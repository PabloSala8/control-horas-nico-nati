/**
 * Bot de Telegram (Telegraf). Punto de entrada del flujo de marcación y
 * corrección (secciones 6 y 7) + comandos de admin (9-13, 17, 18). Toda la
 * lógica de cálculo/parseo vive en /src/core y /src/bot/servicio.ts; aquí solo
 * se enruta Telegram y se arma la conversación.
 *
 * Estado en memoria (deliberado para esta fase): solicitudes de fallback, de
 * tipo-desconocido, propuestas de turno, movimientos y cambios de rate pendientes
 * de confirmar viven en memoria. Los eventos pendientes ya interpretados SÍ se
 * persisten. Ver bitácora (limitación conocida: un reinicio pierde lo que está a
 * medio confirmar en memoria; mejora futura: tabla de solicitudes).
 */
import { Telegraf, Markup } from 'telegraf';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import {
  ahoraBogota,
  conHoraDelDia,
  timestampSQL,
  parseSQLaDate,
  fechaISO,
  formatoFechaDMYDesde,
} from '../core/tiempo.ts';
import { interpretarCorreccion, type Interpretacion, type HoraPunto } from '../core/interpretarCorreccion.ts';
import { esSaludo, esGuia, tieneIndicioDeHora } from '../core/screening.ts';
import { interpretarComandoAdmin, type CambioRate, type CampoRate } from '../core/comandosAdmin.ts';
import type { ResultadoClasificacion } from '../core/clasificador.ts';
import {
  getEmpleadaPorChat,
  getEmpleadaPorId,
  getAdminPorChat,
  getBloqueAbierto,
  crearEvento,
  getEvento,
  transicionarEstado,
  ajustarHoraEvento,
  getEmpleadasActivas,
  getCatalogoActivo,
  getCatalogoById,
  crearActividad,
  crearMovimiento,
  ensureQuincenaVigente,
  getQuincenaById,
  getMovimientosDeQuincena,
  getRatesVigentes,
  insertarConfigRates,
  getTurnosDeEmpleadaEnFecha,
  getTurnoConEventosById,
  getActividadesDeEmpleadaEnFecha,
  actualizarTurnoCorregido,
  resetDatosOperativos,
  type Empleada,
  type Evento,
  type EventoTipo,
  type MovimientoTipo,
  type RatesVigentes,
  type TurnoConEventos,
} from '../db/queries.ts';
import {
  clasificarPar,
  procesarEventoConfirmado,
  materializarTurno,
  turnoEnConflicto,
  resumenParaReporte,
  turnosParaReporte,
  turnosPorEmpleadaParaReporte,
  type ConflictoTurno,
  type ResultadoMaterializacion,
} from './servicio.ts';
import { prepararCierre, confirmarCierre } from '../jobs/cierre.ts';
import { iniciarScheduler } from '../jobs/scheduler.ts';
import { generarExcel } from '../reports/excel.ts';
import { generarPdf } from '../reports/pdf.ts';
import * as F from './formato.ts';

const bot = new Telegraf(config.telegramBotToken);

// ---------- Estado en memoria ----------
/** Texto sin hora interpretable pero con tipo conocido (sección 7.2, fallback). */
interface SolicitudFallback {
  id: string;
  empleadaId: string;
  empleadaChatId: number;
  alias: string;
  tipo: EventoTipo;
  corrigeEventoId: string | null;
  momentoMensaje: string;
}
/** Hora presente pero tipo indeterminado -> escalación a admins (sección 7.1). */
interface SolicitudTipo {
  id: string;
  empleadaId: string;
  empleadaChatId: number;
  alias: string;
  textoOriginal: string;
  momentoMensaje: string;
  interp: Interpretacion;
}
/** Propuesta de turno pendiente de confirmar en la vista previa 7.4. */
interface PropuestaTurno {
  id: string;
  kind: 'correccion-salida' | 'turno-pasado';
  empleadaId: string;
  empleadaChatId: number;
  alias: string;
  fecha: string;
  entrada: Date;
  salida: Date;
  r: ResultadoClasificacion;
  ratesId: string;
  momentoMensaje: string;
  // correccion-salida (sección 7.3):
  entradaEventoId?: string;
  entradaCambiada?: boolean;
  pendienteSalidaEventoId?: string;
  // turno-pasado (sección 18):
  turnoId?: string;
  turnoEntradaEventoId?: string;
  turnoSalidaEventoId?: string;
  quincenaId?: string | null;
}
interface MovimientoPendiente {
  tipo: MovimientoTipo;
  empleadaId: string;
  alias: string;
  monto: number;
  nota?: string;
  quincenaId: string;
  periodo: string;
}
interface RatePendiente {
  id: string;
  cambio: CambioRate;
  rates: RatesVigentes;
}
/** El grupo de admins fue invitado a escribir algo (una hora, un horario...). */
type AdminAwaiting =
  | { kind: 'fallback-hora'; solicitudId: string }
  | { kind: 'ajustar-directo'; eventoId: string }
  | {
      kind: 'reprevisar-salida';
      pendienteSalidaEventoId: string;
      entradaEventoId: string;
      empleadaId: string;
      empleadaChatId: number;
      alias: string;
      fecha: string;
    }
  | { kind: 'corregir-turno-horario'; turno: TurnoConEventos };

const solicitudesFallback = new Map<string, SolicitudFallback>();
const solicitudesTipo = new Map<string, SolicitudTipo>();
const propuestas = new Map<string, PropuestaTurno>();
const movimientosPendientes = new Map<string, MovimientoPendiente>();
const ratesPendientes = new Map<string, RatePendiente>();
const novedades = new Map<number, { empleadaId: string; tipo: EventoTipo }>(); // key = chat de la empleada
const awaitingAdmin = new Map<number, AdminAwaiting>(); // key = chat de admins
const resetPendientes = new Set<string>(); // tokens de "borrar base de datos" sin confirmar
/** Última escalación de tipo sin resolver: destino del relay de texto libre (7.1). */
let ultimaEscalacionTipoId: string | null = null;

// ---------- Utilidades ----------
const escMd = (s: string) => s.replace(/([_*\[\]`])/g, '\\$1');
const ensureQuincenaHoy = () => ensureQuincenaVigente(fechaISO(ahoraBogota()));
const añoBogota = () => ahoraBogota().getUTCFullYear();
type Teclado = ReturnType<typeof Markup.inlineKeyboard>;

/** Panel de la empleada: Entré/Salí, Generar novedad y las actividades activas. */
async function tecladoEmpleada(): Promise<Teclado> {
  const catalogo = await getCatalogoActivo();
  const filas = [
    [Markup.button.callback('🟢 Entré', 'marca:entrada'), Markup.button.callback('🔴 Salí', 'marca:salida')],
    [Markup.button.callback('📝 Generar novedad', 'novedad')],
  ];
  if (catalogo.length) {
    filas.push(catalogo.map((c) => Markup.button.callback(`➕ ${c.nombre}`, `act:${c.id}`)));
  }
  return Markup.inlineKeyboard(filas);
}

const tecladoNovedadTipo = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('🟢 Entrada', 'nov:entrada'),
      Markup.button.callback('🔴 Salida', 'nov:salida'),
    ],
  ]);

const tecladoMovimiento = (id: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ Confirmar', `mov:confirm:${id}`), Markup.button.callback('❌ Cancelar', `mov:cancel:${id}`)],
  ]);

/** Vista previa de una corrección interpretada: Sí / No, cambiar (sección 7.4). */
const tecladoAprobacion = (eventoId: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ Sí', `ap:confirm:${eventoId}`), Markup.button.callback('✏️ No, cambiar', `ap:ajustar:${eventoId}`)],
  ]);

const tecladoFallback = (solicitudId: string) =>
  Markup.inlineKeyboard([[Markup.button.callback('✏️ Escribir la hora', `ap:fbajustar:${solicitudId}`)]]);

/** Escalación de tipo indeterminado (sección 7.1). */
const tecladoTipoDesconocido = (id: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Nueva entrada', `tipo:entrada:${id}`), Markup.button.callback('🔴 Nueva salida', `tipo:salida:${id}`)],
    [Markup.button.callback('🚫 No es una novedad', `tipo:desc:${id}`)],
  ]);

/** Vista previa de una corrección de salida (loop 7.3): Sí / No, cambiar. */
const tecladoPropuestaSalida = (id: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ Sí', `prop:confirm:${id}`), Markup.button.callback('✏️ No, cambiar', `prop:recambiar:${id}`)],
  ]);

/** Vista previa de corregir un turno pasado (sección 18.4): Sí / Cancelar. */
const tecladoPropuestaTurno = (id: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ Sí', `prop:confirm:${id}`), Markup.button.callback('❌ Cancelar', `prop:cancel:${id}`)],
  ]);

const tecladoRate = (id: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ Sí', `rate:confirm:${id}`), Markup.button.callback('❌ Cancelar', `rate:cancel:${id}`)],
  ]);

const tecladoPickTurno = (turnos: TurnoConEventos[]) =>
  Markup.inlineKeyboard(turnos.map((t, i) => [Markup.button.callback(`✏️ Turno ${i + 1}`, `ct:pick:${t.id}`)]));

/** Botón "Corregir" en el aviso de turno cerrado -> entra al flujo de §18. */
const tecladoCorregirTurno = (turnoId: string) =>
  Markup.inlineKeyboard([[Markup.button.callback('✏️ Corregir', `ct:pick:${turnoId}`)]]);

const tecladoCierre = (quincenaId: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔒 Confirmar cierre', `cierre:confirm:${quincenaId}`), Markup.button.callback('❌ Cancelar', 'cierre:cancel')],
  ]);

const tecladoReset = (id: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🗑️ Sí, borrar todo', `reset:confirm:${id}`), Markup.button.callback('❌ No, cancelar', `reset:cancel:${id}`)],
  ]);

async function enviarEmpleada(chatId: number | string, texto: string, teclado?: Teclado): Promise<void> {
  await bot.telegram.sendMessage(chatId, texto, { parse_mode: 'Markdown', ...(teclado ?? {}) });
}
async function enviarAdmins(texto: string, teclado?: Teclado): Promise<void> {
  await bot.telegram.sendMessage(config.adminChatId, texto, { parse_mode: 'Markdown', ...(teclado ?? {}) });
}

/**
 * Envía un documento al grupo de admins usando `fetch`/`FormData` NATIVOS de
 * Node (no el cliente de Telegraf): su subida multipart se cuelga con "socket
 * hang up" en Node 26. Con reintentos ante cortes transitorios.
 */
async function enviarDocumentoAdmins(buffer: Buffer, filename: string, caption?: string): Promise<void> {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendDocument`;
  let ultimoError: unknown;
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const form = new FormData();
      form.append('chat_id', String(config.adminChatId));
      if (caption) form.append('caption', caption);
      form.append('document', new Blob([new Uint8Array(buffer)]), filename);
      const res = await fetch(url, { method: 'POST', body: form });
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) throw new Error(`Telegram sendDocument: ${json.description ?? res.status}`);
      return;
    } catch (err) {
      ultimoError = err;
      console.warn(`Envío de ${filename} falló (intento ${intento}/3):`, (err as Error).message);
      await new Promise((r) => setTimeout(r, 1500 * intento));
    }
  }
  throw ultimoError;
}

/** Nombre de archivo seguro para el reporte. */
const nombreReporte = (periodo: string, ext: string, definitivo: boolean) =>
  `${definitivo ? 'CIERRE' : 'Parcial'}_${periodo.replace(/[^\w]+/g, '-')}.${ext}`;

/** Guard de la sección 3: una acción sensible solo procede desde el grupo admin. */
async function esChatAdmin(chatId: number | undefined): Promise<boolean> {
  if (chatId !== config.adminChatId) return false;
  return (await getAdminPorChat(chatId)) !== null;
}

/** Convierte una interpretación en un punto de hora, según el tipo esperado. */
function puntoDe(interp: Interpretacion, tipoPref: EventoTipo): HoraPunto | undefined {
  if (interp.rango) return tipoPref === 'entrada' ? interp.rango.entrada : interp.rango.salida;
  if (interp.ok && interp.hora !== undefined) return { hora: interp.hora, minuto: interp.minuto ?? 0 };
  return undefined;
}

const lineaDeTurno = (t: TurnoConEventos) =>
  F.lineaTurno(
    parseSQLaDate(t.entrada_declarado),
    parseSQLaDate(t.salida_declarado),
    t.desglose_tramos,
    Number(t.horas_totales),
  );

/** Avisa a los admins que un turno no se creó por la regla de no-solape/max-2 (§6). */
async function avisarConflictoAdmins(alias: string, entrada: Date, salida: Date, conflicto: ConflictoTurno): Promise<void> {
  await enviarAdmins(
    F.msgAdminTurnoSolapado({ alias, entrada, salida, conflicto }),
    conflicto.turnoId ? tecladoCorregirTurno(conflicto.turnoId) : undefined,
  );
}

// ---------- Panel de botones ----------
bot.start(async (ctx) => {
  const empleada = await getEmpleadaPorChat(ctx.chat.id);
  if (empleada) {
    await ctx.reply(`Hola ${empleada.alias} 👋 Marca tu turno con estos botones:`, await tecladoEmpleada());
  } else if (await esChatAdmin(ctx.chat.id)) {
    await ctx.reply(
      'Grupo de admins listo ✅\nAquí llegan las correcciones para aprobar. También puedes escribir:\n' +
        '• «le presté 200 a Nena»\n• «bono de 50 a Maye por navidad»\n• «cómo va la quincena»\n' +
        '• «cuáles son los rates» / «cambiar salario base a 1.800.000»\n• «corregir turno de Nena del 20 de julio»',
    );
  }
});
bot.command('panel', async (ctx) => {
  const empleada = await getEmpleadaPorChat(ctx.chat.id);
  if (empleada) await ctx.reply('Marca tu turno:', await tecladoEmpleada());
});

// ---------- Botón "Entré" ----------
bot.action('marca:entrada', async (ctx) => {
  try {
    const chatId = ctx.chat?.id;
    const empleada = chatId ? await getEmpleadaPorChat(chatId) : null;
    if (!empleada) return ctx.answerCbQuery();
    novedades.delete(Number(empleada.chat_id_grupo));

    const now = ahoraBogota();
    const bloque = await getBloqueAbierto(empleada.id);

    if (!bloque) {
      const ev = await crearEvento({
        empleadaId: empleada.id,
        tipo: 'entrada',
        momentoDeclarado: timestampSQL(now),
        momentoMensaje: timestampSQL(now),
        estado: 'confirmado',
      });
      await enviarEmpleada(empleada.chat_id_grupo, F.msgEntradaConfirmada(parseSQLaDate(ev.momento_declarado)));
      return ctx.answerCbQuery('Entrada registrada ✅');
    }

    // Segundo "Entré" sin "Salí" = corrección de la hora de entrada (sección 6).
    const correccion = await crearEvento({
      empleadaId: empleada.id,
      tipo: 'entrada',
      momentoDeclarado: timestampSQL(now),
      momentoMensaje: timestampSQL(now),
      estado: 'pendiente',
      corrigeEventoId: bloque.id,
    });
    await enviarEmpleada(empleada.chat_id_grupo, F.msgCorreccionEnRevision('entrada', now));
    await enviarAdmins(
      F.msgAdminCorreccionEntrada({
        alias: empleada.alias,
        nuevaEntrada: now,
        entradaOriginal: parseSQLaDate(bloque.momento_declarado),
      }),
      tecladoAprobacion(correccion.id),
    );
    return ctx.answerCbQuery('Corrección enviada a revisión 📝');
  } catch (err) {
    console.error('Error en marca:entrada', err);
    return ctx.answerCbQuery('Ups, algo falló. Intenta de nuevo.');
  }
});

// ---------- Botón "Salí" ----------
bot.action('marca:salida', async (ctx) => {
  try {
    const chatId = ctx.chat?.id;
    const empleada = chatId ? await getEmpleadaPorChat(chatId) : null;
    if (!empleada) return ctx.answerCbQuery();
    novedades.delete(Number(empleada.chat_id_grupo));

    const bloque = await getBloqueAbierto(empleada.id);
    if (!bloque) {
      await enviarEmpleada(empleada.chat_id_grupo, F.msgSinBloqueAbierto());
      return ctx.answerCbQuery();
    }

    const now = ahoraBogota();
    const entradaDate = parseSQLaDate(bloque.momento_declarado);

    // Regla §6: no crear un turno que se cruce con otro del día. Se valida ANTES
    // de crear el evento de salida, para no dejar eventos huérfanos.
    const conflicto = await turnoEnConflicto(empleada.id, entradaDate, now);
    if (conflicto) {
      await enviarEmpleada(empleada.chat_id_grupo, F.msgTurnoSolapadoEmpleada(conflicto));
      await avisarConflictoAdmins(empleada.alias, entradaDate, now, conflicto);
      return ctx.answerCbQuery('No se pudo cerrar: se cruza con otro turno');
    }

    const salida = await crearEvento({
      empleadaId: empleada.id,
      tipo: 'salida',
      momentoDeclarado: timestampSQL(now),
      momentoMensaje: timestampSQL(now),
      estado: 'confirmado',
    });
    const mat = await materializarTurno(empleada.id, bloque, salida);
    if (!mat.ok) {
      await enviarEmpleada(empleada.chat_id_grupo, F.msgTurnoSolapadoEmpleada(mat.conflicto));
      await avisarConflictoAdmins(empleada.alias, entradaDate, now, mat.conflicto);
      return ctx.answerCbQuery('No se pudo cerrar: se cruza con otro turno');
    }
    // Actividades del día (Rocco/Gatas): mostrarlas al cerrar y reflejar su valor.
    const actividadesHoy = await getActividadesDeEmpleadaEnFecha(empleada.id, fechaISO(entradaDate));
    await enviarEmpleada(empleada.chat_id_grupo, F.msgSalidaConfirmada(entradaDate, now, mat.resultado!, actividadesHoy));
    // Aviso al grupo de admins: la empleada cerró el turno sola; que puedan corregir.
    await enviarAdmins(
      F.msgAdminTurnoCerrado({ alias: empleada.alias, entrada: entradaDate, salida: now, r: mat.resultado!, actividades: actividadesHoy }),
      mat.turnoId ? tecladoCorregirTurno(mat.turnoId) : undefined,
    );
    return ctx.answerCbQuery('Salida registrada ✅');
  } catch (err) {
    console.error('Error en marca:salida', err);
    return ctx.answerCbQuery('Ups, algo falló. Intenta de nuevo.');
  }
});

// ---------- Flujo guiado "Generar novedad" (sección 6.1) ----------
bot.action('novedad', async (ctx) => {
  const empleada = ctx.chat ? await getEmpleadaPorChat(ctx.chat.id) : null;
  if (!empleada) return ctx.answerCbQuery();
  await ctx.reply('¿Qué se te olvidó marcar?', tecladoNovedadTipo());
  return ctx.answerCbQuery();
});
bot.action(/^nov:(entrada|salida)$/, async (ctx) => {
  const empleada = ctx.chat ? await getEmpleadaPorChat(ctx.chat.id) : null;
  if (!empleada) return ctx.answerCbQuery();
  const tipo = ctx.match[1] as EventoTipo;
  novedades.set(Number(empleada.chat_id_grupo), { empleadaId: empleada.id, tipo });
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  const q = tipo === 'entrada' ? 'entrada' : 'salida';
  await enviarEmpleada(empleada.chat_id_grupo, `Perfecto. ¿A qué hora fue tu *${q}*? Escríbela, ej: \`7:30 am\`.`);
  return ctx.answerCbQuery();
});

// ---------- Botón de actividad extra (Rocco / Gatas) — sección 8 ----------
bot.action(/^act:(.+)$/, async (ctx) => {
  try {
    const chatId = ctx.chat?.id;
    const empleada = chatId ? await getEmpleadaPorChat(chatId) : null;
    if (!empleada) return ctx.answerCbQuery();

    const catalogoId = ctx.match[1];
    const actividad = await getCatalogoById(catalogoId);
    if (!actividad || !actividad.activa) return ctx.answerCbQuery('Esa actividad ya no está disponible.');

    const hoy = fechaISO(ahoraBogota());
    const quincenaId = await ensureQuincenaVigente(hoy);
    await crearActividad({ empleadaId: empleada.id, catalogoId, fecha: hoy, quincenaId });
    await enviarEmpleada(empleada.chat_id_grupo, F.msgActividadRegistrada(actividad.nombre));
    return ctx.answerCbQuery(`${actividad.nombre} registrada ✅`);
  } catch (err) {
    console.error('Error en act:', err);
    return ctx.answerCbQuery('Ups, algo falló. Intenta de nuevo.');
  }
});

// ============================================================================
// Corrección en lenguaje natural — construye la propuesta pendiente y notifica
// ============================================================================

/** Crea el evento pendiente para una hora ya resuelta y avisa a empleada + admins. */
async function registrarPropuestaHora(
  empleada: Empleada,
  tipo: EventoTipo,
  momentoDeclarado: Date,
  momentoMensaje: string,
): Promise<void> {
  const bloque = await getBloqueAbierto(empleada.id);

  // Regla §6: si cerrar este bloque crearía un turno cruzado, no lo dejamos
  // entrar a revisión — se corrige el turno existente, no se duplica.
  if (tipo === 'salida' && bloque) {
    const entradaDate = parseSQLaDate(bloque.momento_declarado);
    const conflicto = await turnoEnConflicto(empleada.id, entradaDate, momentoDeclarado);
    if (conflicto) {
      await enviarEmpleada(empleada.chat_id_grupo, F.msgTurnoSolapadoEmpleada(conflicto));
      await avisarConflictoAdmins(empleada.alias, entradaDate, momentoDeclarado, conflicto);
      return;
    }
  }

  const corrigeEventoId = tipo === 'entrada' && bloque ? bloque.id : null;
  const evento = await crearEvento({
    empleadaId: empleada.id,
    tipo,
    momentoDeclarado: timestampSQL(momentoDeclarado),
    momentoMensaje,
    estado: 'pendiente',
    corrigeEventoId,
  });
  await enviarEmpleada(empleada.chat_id_grupo, F.msgCorreccionEnRevision(tipo, momentoDeclarado));

  if (tipo === 'salida' && bloque) {
    const entradaDate = parseSQLaDate(bloque.momento_declarado);
    try {
      const { resultado } = await clasificarPar(entradaDate, momentoDeclarado);
      await enviarAdmins(
        F.msgConfirmacionTurno({ alias: empleada.alias, entrada: entradaDate, salida: momentoDeclarado, r: resultado }),
        tecladoAprobacion(evento.id),
      );
    } catch {
      await enviarAdmins(F.msgAdminSalidaSinBloque({ alias: empleada.alias, salida: momentoDeclarado }), tecladoAprobacion(evento.id));
    }
  } else if (tipo === 'entrada' && bloque) {
    await enviarAdmins(
      F.msgAdminCorreccionEntrada({
        alias: empleada.alias,
        nuevaEntrada: momentoDeclarado,
        entradaOriginal: parseSQLaDate(bloque.momento_declarado),
      }),
      tecladoAprobacion(evento.id),
    );
  } else if (tipo === 'entrada') {
    await enviarAdmins(F.msgAdminEntradaOlvidada({ alias: empleada.alias, entrada: momentoDeclarado }), tecladoAprobacion(evento.id));
  } else {
    await enviarAdmins(F.msgAdminSalidaSinBloque({ alias: empleada.alias, salida: momentoDeclarado }), tecladoAprobacion(evento.id));
  }
}

/** Interpreta un texto de la empleada (screening ya pasó): tipo -> hora / escalación. */
async function manejarCorreccionEmpleada(empleada: Empleada, texto: string): Promise<void> {
  const interp = interpretarCorreccion(texto);
  const now = ahoraBogota();
  const momentoMensaje = timestampSQL(now);

  // Paso 2 (7.1): si el tipo no está claro, NO se le pregunta a la empleada —
  // se escala al grupo de admins con botones + relay de texto libre.
  if (!interp.tipo) {
    const sol: SolicitudTipo = {
      id: randomUUID(),
      empleadaId: empleada.id,
      empleadaChatId: Number(empleada.chat_id_grupo),
      alias: empleada.alias,
      textoOriginal: texto,
      momentoMensaje,
      interp,
    };
    solicitudesTipo.set(sol.id, sol);
    ultimaEscalacionTipoId = sol.id;
    await enviarAdmins(F.msgAdminTipoDesconocido({ alias: empleada.alias, textoOriginal: escMd(texto) }), tecladoTipoDesconocido(sol.id));
    return;
  }

  // Tipo claro -> paso 3 (interpretación de la hora).
  const hp = puntoDe(interp, interp.tipo);
  if (hp) {
    const momentoDeclarado = conHoraDelDia(now, hp.hora, hp.minuto);
    await registrarPropuestaHora(empleada, interp.tipo, momentoDeclarado, momentoMensaje);
    return;
  }

  // Hay tipo pero no se pudo leer la hora -> fallback manual a admins (7.2).
  const bloque = await getBloqueAbierto(empleada.id);
  const sol: SolicitudFallback = {
    id: randomUUID(),
    empleadaId: empleada.id,
    empleadaChatId: Number(empleada.chat_id_grupo),
    alias: empleada.alias,
    tipo: interp.tipo,
    corrigeEventoId: interp.tipo === 'entrada' && bloque ? bloque.id : null,
    momentoMensaje,
  };
  solicitudesFallback.set(sol.id, sol);
  await enviarEmpleada(empleada.chat_id_grupo, F.msgFallbackEnRevision());
  await enviarAdmins(F.msgAdminFallback({ alias: empleada.alias, textoOriginal: escMd(texto) }), tecladoFallback(sol.id));
}

// ---------- Aprobación: Sí (confirma la hora interpretada tal cual) ----------
bot.action(/^ap:confirm:(.+)$/, async (ctx) => {
  try {
    if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery(); // guard sección 3
    const admin = await getAdminPorChat(config.adminChatId);
    const evento = await getEvento(ctx.match[1]);
    if (!evento || evento.estado !== 'pendiente') return ctx.answerCbQuery('Ya estaba resuelto.');

    await transicionarEstado(evento.id, 'confirmado', admin!.id);
    const eventoConfirmado: Evento = { ...evento, estado: 'confirmado', aprobado_por: admin!.id };
    const mat = await procesarEventoConfirmado(eventoConfirmado);
    await finalizarEventoConfirmado(eventoConfirmado, mat);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return ctx.answerCbQuery(mat.ok ? 'Confirmado ✅' : 'No se creó: se cruza con otro turno');
  } catch (err) {
    console.error('Error en ap:confirm', err);
    return ctx.answerCbQuery('Ups, algo falló.');
  }
});

/**
 * Cierra el ciclo tras confirmar un evento: si el turno se materializó, avisa a
 * empleada + admins; si chocó con la regla de no-solape/max-2, avisa solo a
 * admins con el botón para corregir el turno existente.
 */
async function finalizarEventoConfirmado(evento: Evento, mat: ResultadoMaterializacion): Promise<void> {
  if (mat.ok) {
    await notificarConfirmado(evento, mat.resultado);
    return;
  }
  const bloque = await getBloqueAbierto(evento.empleada_id);
  const alias = (await getEmpleadaPorId(evento.empleada_id))?.alias ?? 'la empleada';
  const salida = parseSQLaDate(evento.momento_declarado);
  const entrada = bloque ? parseSQLaDate(bloque.momento_declarado) : salida;
  await avisarConflictoAdmins(alias, entrada, salida, mat.conflicto);
}

/** Avisa a empleada (detalle completo, 7.3) y admins tras confirmar un evento. */
async function notificarConfirmado(evento: Evento, resultado: ResultadoClasificacion | null): Promise<void> {
  const empleada = await getEmpleadaPorId(evento.empleada_id);
  const alias = empleada?.alias ?? 'la empleada';
  if (empleada) {
    await enviarEmpleada(
      empleada.chat_id_grupo,
      F.msgCorreccionConfirmadaEmpleada({ tipo: evento.tipo, hora: parseSQLaDate(evento.momento_declarado), r: resultado }),
    );
  }
  await enviarAdmins(F.msgAdminConfirmado({ alias, r: resultado }));
}

// ---------- Aprobación: No, cambiar (evento interpretado existente) ----------
bot.action(/^ap:ajustar:(.+)$/, async (ctx) => {
  if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
  const evento = await getEvento(ctx.match[1]);
  if (!evento || evento.estado !== 'pendiente') return ctx.answerCbQuery('Ya estaba resuelto.');
  const empleada = await getEmpleadaPorId(evento.empleada_id);
  const alias = empleada?.alias ?? 'la empleada';

  if (evento.tipo === 'salida') {
    const bloque = await getBloqueAbierto(evento.empleada_id);
    if (bloque && empleada) {
      awaitingAdmin.set(config.adminChatId, {
        kind: 'reprevisar-salida',
        pendienteSalidaEventoId: evento.id,
        entradaEventoId: bloque.id,
        empleadaId: evento.empleada_id,
        empleadaChatId: Number(empleada.chat_id_grupo),
        alias,
        fecha: fechaISO(parseSQLaDate(evento.momento_declarado)),
      });
      await enviarAdmins(`✏️ Escribe el horario correcto de *${alias}* (un punto o un rango, ej: \`de 7:00 am a 4:00 pm\`).`);
      return ctx.answerCbQuery();
    }
  }
  // Entrada, o salida sin bloque: ajuste directo del punto.
  awaitingAdmin.set(config.adminChatId, { kind: 'ajustar-directo', eventoId: evento.id });
  await enviarAdmins(`✏️ Escribe la hora correcta de *${alias}* (ej. \`3:30 pm\` o \`15:30\`).`);
  return ctx.answerCbQuery();
});

// ---------- Aprobación: escribir la hora (fallback manual, sin evento aún) ----------
bot.action(/^ap:fbajustar:(.+)$/, async (ctx) => {
  if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
  const solicitud = solicitudesFallback.get(ctx.match[1]);
  if (!solicitud) return ctx.answerCbQuery('Esa solicitud ya no está disponible.');
  awaitingAdmin.set(config.adminChatId, { kind: 'fallback-hora', solicitudId: ctx.match[1] });
  await enviarAdmins(`✏️ Escribe la hora de *${solicitud.alias}* (ej. \`3:30 pm\` o \`15:30\`).`);
  return ctx.answerCbQuery();
});

// ---------- Escalación de tipo: botones del grupo de admins (sección 7.1) ----------
bot.action(/^tipo:(entrada|salida|desc):(.+)$/, async (ctx) => {
  try {
    if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
    const accion = ctx.match[1] as 'entrada' | 'salida' | 'desc';
    const sol = solicitudesTipo.get(ctx.match[2]);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    if (!sol) return ctx.answerCbQuery('Esa solicitud ya no está disponible.');

    if (ultimaEscalacionTipoId === sol.id) ultimaEscalacionTipoId = null;

    if (accion === 'desc') {
      solicitudesTipo.delete(sol.id);
      await enviarAdmins(`🚫 Descartado. No creé ningún registro para *${sol.alias}*.`);
      return ctx.answerCbQuery('Descartado');
    }

    const empleada = await getEmpleadaPorId(sol.empleadaId);
    if (!empleada) {
      solicitudesTipo.delete(sol.id);
      return ctx.answerCbQuery();
    }
    const tipo = accion as EventoTipo;
    const hp = puntoDe(sol.interp, tipo);
    if (hp) {
      solicitudesTipo.delete(sol.id);
      const momentoDeclarado = conHoraDelDia(ahoraBogota(), hp.hora, hp.minuto);
      await registrarPropuestaHora(empleada, tipo, momentoDeclarado, sol.momentoMensaje);
    } else {
      // Ya sabemos el tipo, pero no la hora -> pedirla a los admins (fallback).
      const bloque = await getBloqueAbierto(empleada.id);
      const fb: SolicitudFallback = {
        id: randomUUID(),
        empleadaId: empleada.id,
        empleadaChatId: Number(empleada.chat_id_grupo),
        alias: empleada.alias,
        tipo,
        corrigeEventoId: tipo === 'entrada' && bloque ? bloque.id : null,
        momentoMensaje: sol.momentoMensaje,
      };
      solicitudesFallback.set(fb.id, fb);
      solicitudesTipo.delete(sol.id);
      awaitingAdmin.set(config.adminChatId, { kind: 'fallback-hora', solicitudId: fb.id });
      await enviarAdmins(`✏️ Escribe la hora de la *${tipo}* de *${empleada.alias}* (ej. \`3:30 pm\`).`);
    }
    return ctx.answerCbQuery();
  } catch (err) {
    console.error('Error en tipo:', err);
    return ctx.answerCbQuery('Ups, algo falló.');
  }
});

// ============================================================================
// Texto libre
// ============================================================================
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const texto = ctx.message.text;
  if (texto.startsWith('/')) return; // comandos ya manejados

  if (chatId === config.adminChatId) {
    try {
      await manejarTextoAdmin(texto);
    } catch (err) {
      console.error('Error en texto admin', err);
      await enviarAdmins('Ups, algo falló procesando eso. Intenta de nuevo. 🙏').catch(() => {});
    }
    return;
  }

  const empleada = await getEmpleadaPorChat(chatId);
  if (empleada) {
    try {
      await manejarTextoEmpleada(empleada, texto);
    } catch (err) {
      console.error('Error en texto empleada', err);
      await enviarEmpleada(empleada.chat_id_grupo, 'Ups, no pude procesar eso. Intenta de nuevo. 🙏');
    }
  }
});

/** Orden en el grupo de una empleada: saludo -> novedad pendiente -> screening -> corrección. */
async function manejarTextoEmpleada(empleada: Empleada, texto: string): Promise<void> {
  const chatEmpleada = Number(empleada.chat_id_grupo);

  // Guía / instrucciones: manda la ayuda + el panel de botones.
  if (esGuia(texto)) {
    novedades.delete(chatEmpleada);
    await enviarEmpleada(chatEmpleada, F.msgGuiaEmpleada(empleada.alias), await tecladoEmpleada());
    return;
  }

  // Saludo (sección 6.0): despliega el menú (a menos que además traiga una hora).
  if (esSaludo(texto) && !tieneIndicioDeHora(texto)) {
    novedades.delete(chatEmpleada);
    await enviarEmpleada(chatEmpleada, `Hola ${empleada.alias} 👋 Marca tu turno:`, await tecladoEmpleada());
    return;
  }

  // Flujo guiado "Generar novedad": esperando la hora (tipo ya resuelto por botón).
  const nov = novedades.get(chatEmpleada);
  if (nov) {
    const interp = interpretarCorreccion(texto);
    const hp = puntoDe(interp, nov.tipo);
    if (!hp) {
      await enviarEmpleada(chatEmpleada, 'No entendí la hora. Escríbela así: `7:30 am` o `15:30`.');
      return; // mantiene el flujo abierto
    }
    novedades.delete(chatEmpleada);
    const now = ahoraBogota();
    await registrarPropuestaHora(empleada, nov.tipo, conHoraDelDia(now, hp.hora, hp.minuto), timestampSQL(now));
    return;
  }

  // Screening (sección 7.0): sin indicio de hora, el bot NO responde ni registra nada.
  if (!tieneIndicioDeHora(texto)) return;

  await manejarCorreccionEmpleada(empleada, texto);
}

/** Orden en el grupo de admins: hora pedida -> comando -> relay -> silencio. */
async function manejarTextoAdmin(texto: string): Promise<void> {
  if (awaitingAdmin.has(config.adminChatId)) {
    await manejarAwaitingAdmin(texto);
    return;
  }

  const empleadas = await getEmpleadasActivas();
  const cmd = interpretarComandoAdmin(texto, empleadas.map((e) => e.alias), añoBogota());
  if (cmd.tipo !== 'desconocido') {
    await manejarComandoAdmin(cmd, empleadas);
    return;
  }

  // Texto no reconocido: si hay una escalación de tipo pendiente, es un relay (7.1).
  if (ultimaEscalacionTipoId) {
    const sol = solicitudesTipo.get(ultimaEscalacionTipoId);
    if (sol) {
      solicitudesTipo.delete(sol.id);
      ultimaEscalacionTipoId = null;
      await enviarEmpleada(sol.empleadaChatId, `💬 Nico/Nati: ${escMd(texto)}`);
      await enviarAdmins(`↩️ Reenviado a *${sol.alias}*.`);
      return;
    }
  }
  // Nada que hacer: el bot se queda callado.
}

/** El admin escribió algo que le pedimos (una hora o un horario). */
async function manejarAwaitingAdmin(texto: string): Promise<void> {
  const st = awaitingAdmin.get(config.adminChatId)!;
  const interp = interpretarCorreccion(texto);
  const admin = await getAdminPorChat(config.adminChatId);

  if (st.kind === 'fallback-hora') {
    const sol = solicitudesFallback.get(st.solicitudId);
    if (!sol) {
      awaitingAdmin.delete(config.adminChatId);
      return;
    }
    const hp = puntoDe(interp, sol.tipo);
    if (!hp) return enviarAdmins('No entendí la hora. Escríbela así: `3:30 pm` o `15:30`.');
    const now = ahoraBogota();
    const eventoConfirmado = await crearEvento({
      empleadaId: sol.empleadaId,
      tipo: sol.tipo,
      momentoDeclarado: timestampSQL(conHoraDelDia(now, hp.hora, hp.minuto)),
      momentoMensaje: sol.momentoMensaje,
      estado: 'confirmado',
      corrigeEventoId: sol.corrigeEventoId,
      aprobadoPor: admin!.id,
    });
    solicitudesFallback.delete(sol.id);
    awaitingAdmin.delete(config.adminChatId);
    await finalizarEventoConfirmado(eventoConfirmado, await procesarEventoConfirmado(eventoConfirmado));
    return;
  }

  if (st.kind === 'ajustar-directo') {
    const evento = await getEvento(st.eventoId);
    if (!evento || evento.estado !== 'pendiente') {
      awaitingAdmin.delete(config.adminChatId);
      return;
    }
    const hp = puntoDe(interp, evento.tipo);
    if (!hp) return enviarAdmins('No entendí la hora. Escríbela así: `3:30 pm` o `15:30`.');
    const now = ahoraBogota();
    const eventoConfirmado = await ajustarHoraEvento({
      eventoPendiente: evento,
      nuevoMomentoDeclarado: timestampSQL(conHoraDelDia(now, hp.hora, hp.minuto)),
      aprobadoPor: admin!.id,
    });
    awaitingAdmin.delete(config.adminChatId);
    await finalizarEventoConfirmado(eventoConfirmado, await procesarEventoConfirmado(eventoConfirmado));
    return;
  }

  if (st.kind === 'reprevisar-salida') {
    const bloqueEv = await getEvento(st.entradaEventoId);
    if (!bloqueEv) {
      awaitingAdmin.delete(config.adminChatId);
      return;
    }
    const base = parseSQLaDate(bloqueEv.momento_declarado);
    let entrada: Date;
    let salida: Date;
    let entradaCambiada = false;
    if (interp.rango) {
      entrada = conHoraDelDia(base, interp.rango.entrada.hora, interp.rango.entrada.minuto);
      salida = conHoraDelDia(base, interp.rango.salida.hora, interp.rango.salida.minuto);
      entradaCambiada = entrada.getTime() !== base.getTime();
    } else if (interp.ok && interp.hora !== undefined) {
      entrada = base;
      salida = conHoraDelDia(base, interp.hora, interp.minuto ?? 0);
    } else {
      return enviarAdmins('No entendí. Escribe un punto (`3:30 pm`) o un rango (`de 7:00 am a 4:00 pm`).');
    }
    let resultado: ResultadoClasificacion;
    let ratesId: string;
    try {
      ({ resultado, ratesId } = await clasificarPar(entrada, salida));
    } catch {
      return enviarAdmins('Ese horario no es válido: la salida debe ser después de la entrada.');
    }
    const conflicto = await turnoEnConflicto(st.empleadaId, entrada, salida);
    if (conflicto) {
      awaitingAdmin.delete(config.adminChatId);
      return avisarConflictoAdmins(st.alias, entrada, salida, conflicto);
    }
    const prop: PropuestaTurno = {
      id: randomUUID(),
      kind: 'correccion-salida',
      empleadaId: st.empleadaId,
      empleadaChatId: st.empleadaChatId,
      alias: st.alias,
      fecha: st.fecha,
      entrada,
      salida,
      r: resultado,
      ratesId,
      momentoMensaje: timestampSQL(ahoraBogota()),
      entradaEventoId: st.entradaEventoId,
      entradaCambiada,
      pendienteSalidaEventoId: st.pendienteSalidaEventoId,
    };
    propuestas.set(prop.id, prop);
    awaitingAdmin.delete(config.adminChatId);
    await enviarAdmins(
      F.msgConfirmacionTurno({ alias: st.alias, entrada, salida, r: resultado, encabezado: 'Turno (ajustado)' }),
      tecladoPropuestaSalida(prop.id),
    );
    return;
  }

  if (st.kind === 'corregir-turno-horario') {
    const t = st.turno;
    const base = parseSQLaDate(t.entrada_declarado);
    let entrada: Date;
    let salida: Date;
    if (interp.rango) {
      entrada = conHoraDelDia(base, interp.rango.entrada.hora, interp.rango.entrada.minuto);
      salida = conHoraDelDia(base, interp.rango.salida.hora, interp.rango.salida.minuto);
    } else if (interp.ok && interp.hora !== undefined) {
      entrada = base; // un punto solo cambia la salida
      salida = conHoraDelDia(base, interp.hora, interp.minuto ?? 0);
    } else {
      return enviarAdmins('No entendí. Escribe un punto (`3:30 pm`) o un rango (`de 7:00 am a 4:00 pm`).');
    }
    let resultado: ResultadoClasificacion;
    let ratesId: string;
    try {
      ({ resultado, ratesId } = await clasificarPar(entrada, salida));
    } catch {
      return enviarAdmins('Ese horario no es válido: la salida debe ser después de la entrada.');
    }
    // El turno corregido no puede cruzarse con el OTRO turno del día (si es partido).
    const conflicto = await turnoEnConflicto(t.empleada_id, entrada, salida, t.id);
    if (conflicto) {
      awaitingAdmin.delete(config.adminChatId);
      return avisarConflictoAdmins(t.alias, entrada, salida, conflicto);
    }
    const prop: PropuestaTurno = {
      id: randomUUID(),
      kind: 'turno-pasado',
      empleadaId: t.empleada_id,
      empleadaChatId: 0,
      alias: t.alias,
      fecha: t.fecha,
      entrada,
      salida,
      r: resultado,
      ratesId,
      momentoMensaje: timestampSQL(ahoraBogota()),
      turnoId: t.id,
      turnoEntradaEventoId: t.entrada_evento_id,
      turnoSalidaEventoId: t.salida_evento_id,
      quincenaId: t.quincena_id,
    };
    propuestas.set(prop.id, prop);
    awaitingAdmin.delete(config.adminChatId);
    const actsPreview = await getActividadesDeEmpleadaEnFecha(t.empleada_id, t.fecha.slice(0, 10));
    await enviarAdmins(
      F.msgConfirmacionTurno({ alias: t.alias, entrada, salida, r: resultado, encabezado: 'Turno corregido', actividades: actsPreview }),
      tecladoPropuestaTurno(prop.id),
    );
    return;
  }
}

// ---------- Propuestas de turno: confirmar / recambiar / cancelar ----------
bot.action(/^prop:confirm:(.+)$/, async (ctx) => {
  try {
    if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
    const prop = propuestas.get(ctx.match[1]);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    if (!prop) return ctx.answerCbQuery('Esa propuesta ya no está disponible.');
    const admin = await getAdminPorChat(config.adminChatId);
    propuestas.delete(prop.id);

    if (prop.kind === 'correccion-salida') {
      // Guard §6: re-validar por si entró otro turno entre la vista previa y ahora
      // (antes de crear eventos, para no dejar huérfanos).
      const conflicto = await turnoEnConflicto(prop.empleadaId, prop.entrada, prop.salida);
      if (conflicto) {
        await avisarConflictoAdmins(prop.alias, prop.entrada, prop.salida, conflicto);
        return ctx.answerCbQuery('No se creó: se cruza con otro turno');
      }
      let entradaEvento: Evento;
      if (prop.entradaCambiada && prop.entradaEventoId) {
        entradaEvento = await crearEvento({
          empleadaId: prop.empleadaId,
          tipo: 'entrada',
          momentoDeclarado: timestampSQL(prop.entrada),
          momentoMensaje: prop.momentoMensaje,
          estado: 'confirmado',
          corrigeEventoId: prop.entradaEventoId,
          aprobadoPor: admin!.id,
        });
      } else {
        entradaEvento = (await getEvento(prop.entradaEventoId!))!;
      }
      if (prop.pendienteSalidaEventoId) {
        const pend = await getEvento(prop.pendienteSalidaEventoId);
        if (pend && pend.estado === 'pendiente') await transicionarEstado(pend.id, 'rechazado', admin!.id);
      }
      const salidaEvento = await crearEvento({
        empleadaId: prop.empleadaId,
        tipo: 'salida',
        momentoDeclarado: timestampSQL(prop.salida),
        momentoMensaje: prop.momentoMensaje,
        estado: 'confirmado',
        corrigeEventoId: prop.pendienteSalidaEventoId ?? null,
        aprobadoPor: admin!.id,
      });
      const mat = await materializarTurno(prop.empleadaId, entradaEvento, salidaEvento);
      if (!mat.ok) {
        await avisarConflictoAdmins(prop.alias, prop.entrada, prop.salida, mat.conflicto);
        return ctx.answerCbQuery('No se creó: se cruza con otro turno');
      }
      await enviarEmpleada(prop.empleadaChatId, F.msgCorreccionConfirmadaEmpleada({ tipo: 'salida', hora: prop.salida, r: mat.resultado }));
      await enviarAdmins(F.msgAdminConfirmado({ alias: prop.alias, r: mat.resultado }));
      return ctx.answerCbQuery('Confirmado ✅');
    }

    // turno-pasado (sección 18): eventos corregidos + recálculo del turno.
    // Guard §6: no dejar que la corrección cruce el OTRO turno del día.
    const conflictoTP = await turnoEnConflicto(prop.empleadaId, prop.entrada, prop.salida, prop.turnoId);
    if (conflictoTP) {
      await avisarConflictoAdmins(prop.alias, prop.entrada, prop.salida, conflictoTP);
      return ctx.answerCbQuery('No se corrigió: se cruza con otro turno');
    }
    const entradaEvento = await crearEvento({
      empleadaId: prop.empleadaId,
      tipo: 'entrada',
      momentoDeclarado: timestampSQL(prop.entrada),
      momentoMensaje: prop.momentoMensaje,
      estado: 'confirmado',
      corrigeEventoId: prop.turnoEntradaEventoId!,
      aprobadoPor: admin!.id,
    });
    const salidaEvento = await crearEvento({
      empleadaId: prop.empleadaId,
      tipo: 'salida',
      momentoDeclarado: timestampSQL(prop.salida),
      momentoMensaje: prop.momentoMensaje,
      estado: 'confirmado',
      corrigeEventoId: prop.turnoSalidaEventoId!,
      aprobadoPor: admin!.id,
    });
    await actualizarTurnoCorregido({
      turnoId: prop.turnoId!,
      entradaEventoId: entradaEvento.id,
      salidaEventoId: salidaEvento.id,
      horasTotales: prop.r.horasTotales,
      desgloseTramos: prop.r.desglose,
      valorTramos: prop.r.detalle.valorPorTramo,
      valorCalculado: prop.r.valorCalculado,
      ratesId: prop.ratesId,
    });
    // El snapshot de una quincena cerrada NO se toca (sección 18.5).
    const q = prop.quincenaId ? await getQuincenaById(prop.quincenaId) : null;
    const actsCorregidas = await getActividadesDeEmpleadaEnFecha(prop.empleadaId, prop.fecha.slice(0, 10));
    await enviarAdmins(
      F.msgTurnoCorregido({
        alias: prop.alias,
        fechaFmt: formatoFechaDMYDesde(prop.fecha),
        entrada: prop.entrada,
        salida: prop.salida,
        r: prop.r,
        quincenaCerrada: q?.estado === 'cerrada',
        actividades: actsCorregidas,
      }),
    );
    return ctx.answerCbQuery('Turno corregido ✅');
  } catch (err) {
    console.error('Error en prop:confirm', err);
    return ctx.answerCbQuery('Ups, algo falló.');
  }
});

bot.action(/^prop:recambiar:(.+)$/, async (ctx) => {
  if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
  const prop = propuestas.get(ctx.match[1]);
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  if (!prop || prop.kind !== 'correccion-salida' || !prop.entradaEventoId || !prop.pendienteSalidaEventoId) {
    return ctx.answerCbQuery('Esa propuesta ya no está disponible.');
  }
  propuestas.delete(prop.id);
  awaitingAdmin.set(config.adminChatId, {
    kind: 'reprevisar-salida',
    pendienteSalidaEventoId: prop.pendienteSalidaEventoId,
    entradaEventoId: prop.entradaEventoId,
    empleadaId: prop.empleadaId,
    empleadaChatId: prop.empleadaChatId,
    alias: prop.alias,
    fecha: prop.fecha,
  });
  await enviarAdmins('✏️ Escribe el horario correcto (un punto o un rango, ej: `de 7:00 am a 4:00 pm`).');
  return ctx.answerCbQuery();
});

bot.action(/^prop:cancel:(.+)$/, async (ctx) => {
  if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
  propuestas.delete(ctx.match[1]);
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await enviarAdmins('Cancelado. No cambié nada.');
  return ctx.answerCbQuery('Cancelado');
});

// ---------- Elegir cuál turno corregir (turno partido, sección 18.2) ----------
bot.action(/^ct:pick:(.+)$/, async (ctx) => {
  if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
  const turno = await getTurnoConEventosById(ctx.match[1]);
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  if (!turno) return ctx.answerCbQuery('Ese turno ya no está disponible.');
  awaitingAdmin.set(config.adminChatId, { kind: 'corregir-turno-horario', turno });
  await enviarAdmins('✏️ Escribe el horario correcto para ese turno (un punto o un rango, ej: `de 7:00 am a 4:00 pm`).');
  return ctx.answerCbQuery();
});

// ============================================================================
// Comandos del grupo de admins (secciones 9-13, 17, 18)
// ============================================================================
async function manejarComandoAdmin(
  cmd: ReturnType<typeof interpretarComandoAdmin>,
  empleadas: Empleada[],
): Promise<void> {
  switch (cmd.tipo) {
    case 'consulta': {
      const quincenaId = await ensureQuincenaHoy();
      const { resumen, definitivo } = await resumenParaReporte(quincenaId);
      await enviarAdmins(F.msgResumen(resumen, { definitivo }));
      return;
    }
    case 'cerrar': {
      const quincenaId = await ensureQuincenaHoy();
      const prep = await prepararCierre(quincenaId);
      if (prep.estado === 'bloqueado') {
        const q = await getQuincenaById(quincenaId);
        await enviarAdmins(F.msgCierreBloqueado(q?.periodo ?? '—', prep.pendientes));
      } else if (prep.estado === 'ya_cerrada') {
        await enviarAdmins(F.msgYaCerrada(prep.resumen.periodo));
      } else {
        await enviarAdmins(F.msgConfirmarCierre(prep.resumen), tecladoCierre(quincenaId));
      }
      return;
    }
    case 'reporte': {
      const quincenaId = await ensureQuincenaHoy();
      await enviarReportes(quincenaId, cmd.formato);
      return;
    }
    case 'rates-ver': {
      const rates = await getRatesVigentes(fechaISO(ahoraBogota()));
      await enviarAdmins(F.msgRatesVigentes(rates, rates.vigenteDesde));
      return;
    }
    case 'rates-cambiar': {
      const rates = await getRatesVigentes(fechaISO(ahoraBogota()));
      const id = randomUUID();
      ratesPendientes.set(id, { id, cambio: cmd.cambio, rates });
      const anteriorFmt = F.formatoValorRate(cmd.cambio.campo, valorActualDeRate(cmd.cambio.campo, rates));
      const nuevoFmt = F.formatoValorRate(cmd.cambio.campo, cmd.cambio.valor);
      await enviarAdmins(
        F.msgConfirmarCambioRate({ etiqueta: cmd.cambio.etiqueta, anteriorFmt, nuevoFmt, vigenteDesde: fechaISO(ahoraBogota()) }),
        tecladoRate(id),
      );
      return;
    }
    case 'corregir-turno': {
      await iniciarCorreccionTurno(cmd.alias, cmd.fecha, empleadas);
      return;
    }
    case 'reset-db': {
      const id = randomUUID();
      resetPendientes.add(id);
      await enviarAdmins(F.msgConfirmarReset(), tecladoReset(id));
      return;
    }
    case 'guia': {
      await enviarAdmins(F.msgGuiaAdmin());
      return;
    }
    case 'prestamo':
    case 'bono': {
      const empleada = empleadas.find((e) => e.alias === cmd.alias);
      if (!empleada) return;
      const quincenaId = await ensureQuincenaHoy();
      const quincena = await getQuincenaById(quincenaId);
      const periodo = quincena?.periodo ?? '—';
      const id = randomUUID();
      movimientosPendientes.set(id, {
        tipo: cmd.tipo,
        empleadaId: empleada.id,
        alias: empleada.alias,
        monto: cmd.monto,
        nota: cmd.nota,
        quincenaId,
        periodo,
      });
      await enviarAdmins(
        F.msgConfirmarMovimiento({ tipo: cmd.tipo, alias: empleada.alias, monto: cmd.monto, periodo, nota: cmd.nota }),
        tecladoMovimiento(id),
      );
      return;
    }
    case 'incompleto': {
      await enviarAdmins(F.msgAyudaMovimiento({ intento: cmd.intento, faltaMonto: cmd.faltaMonto, faltaEmpleada: cmd.faltaEmpleada }));
      return;
    }
    case 'desconocido':
      return;
  }
}

function valorActualDeRate(campo: CampoRate, rates: RatesVigentes): number | string {
  switch (campo) {
    case 'salario_base':
      return rates.salarioBase;
    case 'divisor_horas':
      return rates.divisorHoras;
    case 'rec_extra_diurna':
      return rates.recExtraDiurna;
    case 'rec_extra_nocturna':
      return rates.recExtraNocturna;
    case 'rec_dominical':
      return rates.recDominical;
    case 'inicio_nocturno':
      return rates.inicioNocturno;
  }
}

/** Arranca el flujo de corregir un turno pasado (sección 18). */
async function iniciarCorreccionTurno(
  alias: string | null,
  fecha: string | null,
  empleadas: Empleada[],
): Promise<void> {
  if (!alias || !fecha) {
    await enviarAdmins('Escríbelo así: `corregir turno de Nena del 20 de julio`.');
    return;
  }
  const empleada = empleadas.find((e) => e.alias.toLowerCase() === alias.toLowerCase());
  if (!empleada) {
    await enviarAdmins(`No reconozco a «${escMd(alias)}».`);
    return;
  }
  const turnos = await getTurnosDeEmpleadaEnFecha(empleada.id, fecha);
  const fechaFmt = formatoFechaDMYDesde(fecha);
  if (turnos.length === 0) {
    await enviarAdmins(F.msgTurnoNoEncontrado(empleada.alias, fechaFmt));
    return;
  }
  if (turnos.length === 1) {
    awaitingAdmin.set(config.adminChatId, { kind: 'corregir-turno-horario', turno: turnos[0] });
    await enviarAdmins(F.msgTurnoUnicoParaCorregir(empleada.alias, fechaFmt, lineaDeTurno(turnos[0])));
    return;
  }
  // Turno partido: hay más de un turno ese día (sección 18.2).
  await enviarAdmins(F.msgVariosTurnosParaCorregir(empleada.alias, fechaFmt, turnos.map(lineaDeTurno)), tecladoPickTurno(turnos));
}

// ---------- Confirmar / cancelar un préstamo o bono ----------
bot.action(/^mov:confirm:(.+)$/, async (ctx) => {
  try {
    if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
    const pend = movimientosPendientes.get(ctx.match[1]);
    if (!pend) return ctx.answerCbQuery('Esa solicitud ya no está disponible.');
    const admin = await getAdminPorChat(config.adminChatId);
    await crearMovimiento({
      empleadaId: pend.empleadaId,
      tipo: pend.tipo,
      monto: pend.monto,
      fecha: fechaISO(ahoraBogota()),
      quincenaId: pend.quincenaId,
      registradoPor: admin!.id,
      nota: pend.nota ?? null,
    });
    movimientosPendientes.delete(ctx.match[1]);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await enviarAdmins(F.msgMovimientoRegistrado({ tipo: pend.tipo, alias: pend.alias, monto: pend.monto, periodo: pend.periodo }));
    return ctx.answerCbQuery('Registrado ✅');
  } catch (err) {
    console.error('Error en mov:confirm', err);
    return ctx.answerCbQuery('Ups, algo falló.');
  }
});

bot.action(/^mov:cancel:(.+)$/, async (ctx) => {
  if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
  movimientosPendientes.delete(ctx.match[1]);
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await enviarAdmins(F.msgMovimientoCancelado());
  return ctx.answerCbQuery('Cancelado');
});

// ---------- Confirmar / cancelar un cambio de rate (sección 17) ----------
bot.action(/^rate:confirm:(.+)$/, async (ctx) => {
  try {
    if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
    const pend = ratesPendientes.get(ctx.match[1]);
    if (!pend) return ctx.answerCbQuery('Ese cambio ya no está disponible.');
    const admin = await getAdminPorChat(config.adminChatId);
    const vigenteDesde = fechaISO(ahoraBogota());
    const { rates, cambio } = pend;
    // Fila NUEVA con el resto de campos sin cambio (config_rates nunca se edita en sitio).
    const nueva = {
      vigenteDesde,
      salarioBase: rates.salarioBase,
      divisorHoras: rates.divisorHoras,
      recExtraDiurna: rates.recExtraDiurna,
      recExtraNocturna: rates.recExtraNocturna,
      recDominical: rates.recDominical,
      inicioNocturno: rates.inicioNocturno,
      creadoPor: admin!.id,
    };
    switch (cambio.campo) {
      case 'salario_base':
        nueva.salarioBase = Number(cambio.valor);
        break;
      case 'divisor_horas':
        nueva.divisorHoras = Number(cambio.valor);
        break;
      case 'rec_extra_diurna':
        nueva.recExtraDiurna = Number(cambio.valor);
        break;
      case 'rec_extra_nocturna':
        nueva.recExtraNocturna = Number(cambio.valor);
        break;
      case 'rec_dominical':
        nueva.recDominical = Number(cambio.valor);
        break;
      case 'inicio_nocturno':
        nueva.inicioNocturno = String(cambio.valor);
        break;
    }
    await insertarConfigRates(nueva);
    ratesPendientes.delete(ctx.match[1]);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await enviarAdmins(
      F.msgRateCambiado({ etiqueta: cambio.etiqueta, nuevoFmt: F.formatoValorRate(cambio.campo, cambio.valor), vigenteDesde }),
    );
    return ctx.answerCbQuery('Rate actualizado ✅');
  } catch (err) {
    console.error('Error en rate:confirm', err);
    return ctx.answerCbQuery('Ups, algo falló.');
  }
});

bot.action(/^rate:cancel:(.+)$/, async (ctx) => {
  if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
  ratesPendientes.delete(ctx.match[1]);
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await enviarAdmins(F.msgCambioRateCancelado());
  return ctx.answerCbQuery('Cancelado');
});

// ---------- Reportes bajo demanda (sección 13) ----------
async function enviarReportes(quincenaId: string, formato: 'excel' | 'pdf' | 'ambos'): Promise<void> {
  const [datosBase, turnos, turnosPorEmpleada, movimientos] = await Promise.all([
    resumenParaReporte(quincenaId),
    turnosParaReporte(quincenaId),
    turnosPorEmpleadaParaReporte(quincenaId),
    getMovimientosDeQuincena(quincenaId),
  ]);
  const datos = { ...datosBase, turnos, turnosPorEmpleada, movimientos };
  const { resumen, definitivo, generadoEn } = datosBase;
  const marca = definitivo ? 'definitivo' : `parcial (al ${generadoEn})`;

  if (formato === 'excel' || formato === 'ambos') {
    const buf = await generarExcel(datos);
    await enviarDocumentoAdmins(buf, nombreReporte(resumen.periodo, 'xlsx', definitivo), `📊 Excel ${marca} — ${resumen.periodo}`);
  }
  if (formato === 'pdf' || formato === 'ambos') {
    const buf = await generarPdf(datos);
    await enviarDocumentoAdmins(buf, nombreReporte(resumen.periodo, 'pdf', definitivo), `📄 PDF ${marca} — ${resumen.periodo}`);
  }
}

// ---------- Ejecutar el cierre y enviar los reportes definitivos ----------
async function ejecutarCierreYenviar(quincenaId: string, opts: { auto: boolean }): Promise<void> {
  const res = await confirmarCierre(quincenaId);
  if (!res.ok && res.motivo === 'bloqueado') {
    const q = await getQuincenaById(quincenaId);
    await enviarAdmins(F.msgCierreBloqueado(q?.periodo ?? '—', res.pendientes));
    return;
  }
  if (!res.ok && res.motivo === 'ya_cerrada') {
    if (!opts.auto) await enviarAdmins(F.msgYaCerrada(res.resumen.periodo));
    return;
  }
  if (res.ok) {
    if (opts.auto) await enviarAdmins('⏰ *Cierre automático* en la fecha de corte.');
    await enviarAdmins(F.msgCierreHecho(res.resumen));
    await enviarReportes(quincenaId, 'ambos');
  }
}

// ---------- Confirmar / cancelar el cierre ----------
bot.action(/^cierre:confirm:(.+)$/, async (ctx) => {
  try {
    if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
    const quincenaId = ctx.match[1];
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.answerCbQuery('Cerrando y generando reportes...');
    await ejecutarCierreYenviar(quincenaId, { auto: false });
  } catch (err) {
    console.error('Error en cierre:confirm', err);
    await enviarAdmins('Ups, algo falló durante el cierre. Revisa los logs.');
  }
});

bot.action('cierre:cancel', async (ctx) => {
  if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await enviarAdmins('Cierre cancelado. La quincena sigue abierta.');
  return ctx.answerCbQuery('Cancelado');
});

// ---------- Borrar base de datos (solo desarrollo, sección dev) ----------
/** Descarta todo el estado en memoria (queda huérfano tras un reset). */
function limpiarEstadoEnMemoria(): void {
  solicitudesFallback.clear();
  solicitudesTipo.clear();
  propuestas.clear();
  movimientosPendientes.clear();
  ratesPendientes.clear();
  novedades.clear();
  awaitingAdmin.clear();
  ultimaEscalacionTipoId = null;
}

bot.action(/^reset:confirm:(.+)$/, async (ctx) => {
  try {
    if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    if (!resetPendientes.has(ctx.match[1])) {
      await enviarAdmins(F.msgResetExpirado());
      return ctx.answerCbQuery('Expiró');
    }
    resetPendientes.delete(ctx.match[1]);
    await resetDatosOperativos();
    limpiarEstadoEnMemoria();
    await enviarAdmins(F.msgResetHecho());
    return ctx.answerCbQuery('Base de datos limpia 🧹');
  } catch (err) {
    console.error('Error en reset:confirm', err);
    return ctx.answerCbQuery('Ups, algo falló.');
  }
});

bot.action(/^reset:cancel:(.+)$/, async (ctx) => {
  if (!(await esChatAdmin(ctx.chat?.id))) return ctx.answerCbQuery();
  resetPendientes.delete(ctx.match[1]);
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await enviarAdmins(F.msgResetCancelado());
  return ctx.answerCbQuery('Cancelado');
});

// ---------- Manejo de errores global ----------
bot.catch((err, ctx) => {
  console.error(`Error no manejado en update ${ctx.update?.update_id}:`, err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

// ---------- Arranque ----------
bot.launch({ dropPendingUpdates: true }).catch((err) => {
  console.error('Fallo al arrancar el bot:', err);
  process.exit(1);
});
iniciarScheduler((quincenaId) => ejecutarCierreYenviar(quincenaId, { auto: true }));
console.log('🤖 Bot arrancado (long polling). Ctrl+C para detener.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
