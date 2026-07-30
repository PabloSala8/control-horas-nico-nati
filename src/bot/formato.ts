/**
 * Formateo de mensajes. Separa dos audiencias con reglas estrictas (sección 3):
 *  - Empleadas: SOLO horas, nunca pesos.
 *  - Admins: sí ven pesos.
 * Todo el texto está en español, tono cercano.
 */
import {
  formatoHora12,
  formatoHora12Desde,
  formatoDuracion,
  formatoFechaDMY,
  formatoFechaDMYDesde,
  parseSQLaDate,
  fechaISO,
} from '../core/tiempo.ts';
import type { DesgloseTramos, ResultadoClasificacion } from '../core/clasificador.ts';
import type { CampoRate } from '../core/comandosAdmin.ts';
import type { RatesConfig } from '../core/clasificador.ts';
import { valorHoraOrdinaria } from '../core/clasificador.ts';
import type { Resumen, ConflictoTurno } from './servicio.ts';
import type { ActividadDelDia } from '../db/queries.ts';

/** Línea de actividades del día para la EMPLEADA (sin pesos). null si no hay. */
function lineaActividadesEmpleada(acts: ActividadDelDia[]): string | null {
  if (acts.length === 0) return null;
  return `➕ Hoy también: ${acts.map((a) => `${a.cantidad} ${a.nombre}`).join(', ')}`;
}

/**
 * Bloque de valor para ADMINS al cerrar/corregir un turno. Sin actividades es
 * solo `Total: $turno`; con actividades del día muestra turno + actividades +
 * total combinado, para que el número refleje todo lo generado ese día.
 */
function bloqueValorAdmin(valorTurno: number, acts: ActividadDelDia[]): string {
  if (acts.length === 0) return `Total: *${formatoPesos(valorTurno)}*`;
  const items = acts.map((a) => `${a.cantidad} ${a.nombre}`).join(', ');
  const totalAct = acts.reduce((s, a) => s + a.valor, 0);
  return [
    `Turno: *${formatoPesos(valorTurno)}*`,
    `➕ Actividades hoy: ${items} (${formatoPesos(totalAct)})`,
    `Total del día: *${formatoPesos(valorTurno + totalAct)}*`,
  ].join('\n');
}
import type { EventoTipo, MovimientoTipo, PendienteResumen } from '../db/queries.ts';

/** Pesos colombianos con separador de miles: 1234567 -> "$1.234.567". */
export function formatoPesos(n: number): string {
  return '$' + Math.round(n).toLocaleString('es-CO');
}

/** Desglose de tramos como líneas de HORAS (para empleadas y admins). */
export function desgloseHoras(d: DesgloseTramos): string {
  const lineas: string[] = [];
  if (d.ordinaria > 0) lineas.push(`• Ordinarias: ${formatoDuracion(d.ordinaria)}`);
  if (d.extra_diurna > 0) lineas.push(`• Extra diurna: ${formatoDuracion(d.extra_diurna)}`);
  if (d.extra_nocturna > 0) lineas.push(`• Extra nocturna: ${formatoDuracion(d.extra_nocturna)}`);
  if (d.dominical > 0) lineas.push(`• Dominical/festivo: ${formatoDuracion(d.dominical)}`);
  return lineas.join('\n');
}

/** Igual que `desgloseHoras` pero sin viñeta (formato exacto de la sección 7.4). */
function desgloseHorasSinVinieta(d: DesgloseTramos): string {
  const lineas: string[] = [];
  if (d.ordinaria > 0) lineas.push(`Ordinarias: ${formatoDuracion(d.ordinaria)}`);
  if (d.extra_diurna > 0) lineas.push(`Extra diurna: ${formatoDuracion(d.extra_diurna)}`);
  if (d.extra_nocturna > 0) lineas.push(`Extra nocturna: ${formatoDuracion(d.extra_nocturna)}`);
  if (d.dominical > 0) lineas.push(`Dominical/festivo: ${formatoDuracion(d.dominical)}`);
  return lineas.join('\n');
}

/**
 * Formato de confirmación de turno al grupo de admins — plantilla EXACTA de la
 * sección 7.4, en notación 12h + AM/PM siempre. Usada tanto para aprobar una
 * corrección de salida (7.3) como para la vista previa de corregir un turno
 * pasado (18). `encabezado` permite variar el título ("Turno", "Turno corregido").
 */
export function msgConfirmacionTurno(params: {
  alias: string;
  entrada: Date;
  salida: Date;
  r: ResultadoClasificacion;
  encabezado?: string;
  pregunta?: string;
  actividades?: ActividadDelDia[];
}): string {
  const { alias, entrada, salida, r } = params;
  const encabezado = params.encabezado ?? 'Turno';
  const pregunta = params.pregunta ?? '¿Confirmas este horario?';
  return [
    `✅ *${encabezado} — ${alias}*`,
    `📅 ${formatoFechaDMY(entrada)} · ${formatoHora12(entrada)} – ${formatoHora12(salida)} (${formatoDuracion(
      r.horasTotales,
    )})`,
    ``,
    desgloseHorasSinVinieta(r.desglose),
    bloqueValorAdmin(r.valorCalculado, params.actividades ?? []),
    ``,
    pregunta,
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

// ---------- Guía / instrucciones ----------

/** Guía para la empleada (Nena / Maye) — solo lo que ella usa, sin pesos. */
export function msgGuiaEmpleada(alias: string): string {
  return [
    `📖 *Guía rápida — ${alias}*`,
    ``,
    `*Con los botones:*`,
    `🟢 *Entré* — marca que llegaste.`,
    `🔴 *Salí* — cierra tu turno; te muestro el rango y las horas.`,
    `📝 *Generar novedad* — ¿se te olvidó marcar? Elige Entrada o Salida y me dices la hora.`,
    `➕ *Rocco / Gatas* — registra una actividad extra.`,
    ``,
    `*Escribiendo:*`,
    `• Si olvidaste marcar, dime la hora: «salí a las 3», «entré 8am».`,
    `• Un saludo («hola», «buenas») abre el menú de botones.`,
    ``,
    `Nico y Nati revisan y confirman las correcciones. Cualquier duda, les dices. 🙌`,
  ].join('\n');
}

/** Guía para el grupo de admins — todos los comandos. */
export function msgGuiaAdmin(): string {
  return [
    `📖 *Guía — Grupo de admins*`,
    ``,
    `*Aprobaciones*`,
    `• Cuando una empleada corrige o cierra un turno, te llega aquí con *Sí* / *No, cambiar*.`,
    ``,
    `*Préstamos y bonos (en cuotas)*`,
    `• «le presté 240 a Nena» · «bono de 50 a Maye por navidad»`,
    `• Después te pregunto *en cuántas quincenas* se divide (botones 1–6). Ej: 240 en`,
    `  2 → $120 esta quincena y $120 la siguiente. 1 = solo la quincena actual.`,
    ``,
    `*Consulta en vivo*`,
    `• «cómo va la quincena» — resumen al instante (sin archivo).`,
    ``,
    `*Rates (tarifas)*`,
    `• «cuáles son los rates»`,
    `• «cambiar salario base a 1.800.000» · «recargo dominical a 100%» · «inicio nocturno a 9pm»`,
    ``,
    `*Turnos*`,
    `• «corregir turno de Nena del 20 de julio» — cambia el horario de un turno.`,
    `• «crear turno de Nena del 28 de julio» — para un día que se les olvidó marcar;`,
    `  luego escribes el rango (ej: «de 7:00 am a 4:00 pm»).`,
    `• «eliminar turno de Nena del 28 de julio» — borra un turno; te pido confirmar.`,
    ``,
    `*Cierre y reportes*`,
    `• «cerrar quincena» — congela y genera Excel/PDF.`,
    `• «dame el excel» · «dame el pdf» · «reporte»`,
    `• 📩 La *víspera del cierre* (11:30 PM) te llegan Excel y PDF automáticamente, de respaldo.`,
    ``,
    `*Desarrollo*`,
    `• «borrar base de datos» — reinicia todo a cero (con confirmación).`,
  ].join('\n');
}

// ---------- Mensajes para el grupo de la EMPLEADA (solo horas) ----------

export function msgEntradaConfirmada(entrada: Date): string {
  return `✅ *Entrada* registrada — ${formatoHora12(entrada)}. ¡Buen turno! 💪`;
}

export function msgSalidaConfirmada(
  entrada: Date,
  salida: Date,
  r: ResultadoClasificacion,
  actividades: ActividadDelDia[] = [],
): string {
  return [
    `✅ *Salida* registrada — ${formatoHora12(salida)}`,
    `Turno: *${formatoHora12(entrada)} – ${formatoHora12(salida)}* (${formatoDuracion(r.horasTotales)})`,
    desgloseHoras(r.desglose),
    lineaActividadesEmpleada(actividades),
  ]
    .filter(Boolean)
    .join('\n');
}

export function msgSinBloqueAbierto(): string {
  return `Aún no tienes un turno abierto. Toca *Entré* para empezar. 🙂`;
}

/** A la empleada: su turno no se pudo cerrar porque rompe la regla (sin pesos). */
export function msgTurnoSolapadoEmpleada(c: ConflictoTurno): string {
  if (c.tipo === 'max') {
    return `⚠️ Ya tienes 2 turnos hoy — no puedo agregar otro. Nico y Nati lo revisan.`;
  }
  return `⚠️ No pude cerrar este turno: se cruza con otro que ya tienes hoy (${c.rango}). Nico y Nati lo revisan.`;
}

export function msgCorreccionEnRevision(tipo: 'entrada' | 'salida', hora: Date): string {
  const q = tipo === 'salida' ? 'tu salida' : 'tu entrada';
  return `📝 Anoté ${q} a las ${formatoHora12(hora)} — en revisión con Nico y Nati.`;
}

export function msgFallbackEnRevision(): string {
  return `📝 Le aviso a Nico y Nati para que confirmen tu horario — en revisión.`;
}

/**
 * Mensaje FINAL a la empleada con el detalle completo de lo confirmado
 * (sección 7.3): nunca un genérico "confirmado", siempre "Se confirmó tu
 * entrada/salida a las H:MM AM/PM". Si se materializó el turno, añade las horas
 * (nunca pesos — regla de audiencia de la sección 3).
 */
export function msgCorreccionConfirmadaEmpleada(params: {
  tipo: EventoTipo;
  hora: Date;
  r: ResultadoClasificacion | null;
}): string {
  const q = params.tipo === 'salida' ? 'tu salida' : 'tu entrada';
  const cab = `✅ Se confirmó ${q} a las ${formatoHora12(params.hora)}`;
  if (!params.r) return cab;
  return [cab, `Turno: *${formatoDuracion(params.r.horasTotales)}*`, desgloseHoras(params.r.desglose)]
    .filter(Boolean)
    .join('\n');
}

// ---------- Mensajes para el grupo de ADMINS (con pesos) ----------

/**
 * Escalación al grupo de admins cuando el tipo (entrada/salida) NO se pudo
 * determinar (sección 7.1). No se le pregunta a la empleada: los admins deciden
 * con los botones [Nueva entrada] [Nueva salida] [No es una novedad], o
 * responden con texto libre y el bot lo reenvía a la empleada (relay).
 */
export function msgAdminTipoDesconocido(params: { alias: string; textoOriginal: string }): string {
  return [
    `🔔 *${params.alias}* escribió algo que parece una marcación, pero no sé si es entrada o salida:`,
    `«${params.textoOriginal}»`,
    ``,
    `Elige el tipo con los botones, o responde con un mensaje y se lo reenvío a ${params.alias}.`,
  ].join('\n');
}

export function msgAdminCorreccionEntrada(params: {
  alias: string;
  nuevaEntrada: Date;
  entradaOriginal: Date;
}): string {
  const { alias, nuevaEntrada, entradaOriginal } = params;
  return [
    `🔔 *Corrección — ${alias}*`,
    `Propuesta: nueva *hora de entrada ${formatoHora12(nuevaEntrada)}*`,
    `(antes: ${formatoHora12(entradaOriginal)})`,
    ``,
    `El impacto en pesos se calcula cuando se cierre el bloque.`,
  ].join('\n');
}

export function msgAdminFallback(params: { alias: string; textoOriginal: string }): string {
  return [
    `🔔 *${params.alias}* escribió algo que no pude interpretar como una hora:`,
    `«${params.textoOriginal}»`,
    ``,
    `Usa *No, cambiar* para escribir la hora correcta manualmente.`,
  ].join('\n');
}

/** Entrada olvidada (Generar novedad / texto sin bloque abierto) — a revisar. */
export function msgAdminEntradaOlvidada(params: { alias: string; entrada: Date }): string {
  return [
    `🔔 *Nueva entrada — ${params.alias}*`,
    `Propuesta: entrada a las *${formatoHora12(params.entrada)}* (marcación olvidada).`,
    ``,
    `El impacto en pesos se calcula cuando se cierre el bloque.`,
  ].join('\n');
}

/** A los admins: un turno no se creó porque rompía la regla de no-solape/max-2. */
export function msgAdminTurnoSolapado(params: {
  alias: string;
  entrada: Date;
  salida: Date;
  conflicto: ConflictoTurno;
}): string {
  const { alias, entrada, salida, conflicto } = params;
  const nuevo = `${formatoHora12(entrada)} – ${formatoHora12(salida)}`;
  if (conflicto.tipo === 'max') {
    return [
      `⚠️ *${alias}* ya tiene 2 turnos hoy.`,
      `No creé el turno *${nuevo}* (máximo son 2 por día).`,
      `Si alguno está mal, usa *corregir turno*.`,
    ].join('\n');
  }
  return [
    `⚠️ El turno de *${alias}* (${nuevo}) se cruza con otro que ya existe hoy (*${conflicto.rango}*).`,
    `No lo creé, para no dejar turnos duplicados.`,
    `Si el que ya existe está mal, córrígelo:`,
  ].join('\n');
}

/** Salida propuesta sin un bloque abierto que cerrar — caso borde, a revisar. */
export function msgAdminSalidaSinBloque(params: { alias: string; salida: Date }): string {
  return [
    `🔔 *Corrección — ${params.alias}*`,
    `Salida propuesta: *${formatoHora12(params.salida)}* (sin bloque abierto).`,
    ``,
    `Revisa antes de confirmar.`,
  ].join('\n');
}

export function msgAdminConfirmado(params: {
  alias: string;
  r: ResultadoClasificacion | null;
}): string {
  const { alias, r } = params;
  if (!r) return `✅ Corrección de *${alias}* confirmada.`;
  return [
    `✅ Confirmado — *${alias}*`,
    `Turno: *${formatoDuracion(r.horasTotales)}*`,
    desgloseHoras(r.desglose),
    `💵 ${formatoPesos(r.valorCalculado)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Aviso al grupo de admins cada vez que una empleada CIERRA un turno por su
 * cuenta (botón "Salí"), para que puedan atraparlo si quedó mal. El turno ya
 * está confirmado; el botón ✏️ Corregir lleva al flujo de corregir turno (§18).
 */
export function msgAdminTurnoCerrado(params: {
  alias: string;
  entrada: Date;
  salida: Date;
  r: ResultadoClasificacion;
  actividades?: ActividadDelDia[];
}): string {
  const { alias, entrada, salida, r, actividades = [] } = params;
  return [
    `🔔 *Turno cerrado — ${alias}*`,
    `📅 ${formatoFechaDMY(entrada)} · ${formatoHora12(entrada)} – ${formatoHora12(salida)} (${formatoDuracion(r.horasTotales)})`,
    ``,
    desgloseHorasSinVinieta(r.desglose),
    bloqueValorAdmin(r.valorCalculado, actividades),
    ``,
    `Lo cerró ${alias}. Si hay que corregirlo, toca ✏️ Corregir.`,
  ].join('\n');
}

// ---------- Actividades extra (sección 8) ----------

/** Confirmación a la EMPLEADA — sin pesos (el valor es fijo y conocido). */
export function msgActividadRegistrada(nombre: string): string {
  return `✅ Registré tu *${nombre}* de hoy. ¡Gracias! 🙌`;
}

// ---------- Préstamos y bonos (secciones 9 y 10) — solo grupo admin, con pesos ----------

const etiquetaMov = (t: MovimientoTipo) => (t === 'prestamo' ? 'Préstamo' : 'Bono');

/** Pregunta en cuántas quincenas se divide un préstamo/bono (sección 9.3). */
export function msgPreguntarCuotas(params: { tipo: MovimientoTipo; alias: string; monto: number }): string {
  const { tipo, alias, monto } = params;
  const verbo = tipo === 'prestamo' ? 'se descuenta' : 'se paga';
  return [
    `🧾 *${etiquetaMov(tipo)}* de *${formatoPesos(monto)}* para *${alias}*.`,
    `¿En cuántas quincenas ${verbo}? (1 = solo esta quincena)`,
  ].join('\n');
}

export function msgConfirmarMovimiento(params: {
  tipo: MovimientoTipo;
  alias: string;
  montoTotal: number;
  nota?: string;
  plan: Array<{ periodo: string; monto: number }>;
}): string {
  const { tipo, alias, montoTotal, nota, plan } = params;
  const efecto = tipo === 'prestamo' ? 'se descuenta de' : 'se suma a';
  const lineas: Array<string | undefined> = [
    `🧾 *${etiquetaMov(tipo)}* — voy a registrar:`,
    `${etiquetaMov(tipo)} de *${formatoPesos(montoTotal)}* para *${alias}*`,
    nota ? `Motivo: ${nota}` : undefined,
  ];
  if (plan.length === 1) {
    lineas.push(`${efecto} la quincena *${plan[0].periodo}*.`);
  } else {
    lineas.push(`En *${plan.length} cuotas*:`);
    for (const c of plan) lineas.push(`  • ${c.periodo}: *${formatoPesos(c.monto)}*`);
  }
  lineas.push(``, `¿Confirmo?`);
  return lineas.filter((l) => l !== undefined).join('\n');
}

export function msgMovimientoRegistrado(params: {
  tipo: MovimientoTipo;
  alias: string;
  montoTotal: number;
  plan: Array<{ periodo: string; monto: number }>;
}): string {
  const { tipo, alias, montoTotal, plan } = params;
  if (plan.length === 1) {
    return `✅ ${etiquetaMov(tipo)} de *${formatoPesos(montoTotal)}* registrado para *${alias}* en ${plan[0].periodo}.`;
  }
  const detalle = plan.map((c) => `  • ${c.periodo}: ${formatoPesos(c.monto)}`).join('\n');
  return `✅ ${etiquetaMov(tipo)} de *${formatoPesos(montoTotal)}* registrado para *${alias}* en ${plan.length} cuotas:\n${detalle}`;
}

export function msgMovimientoCancelado(): string {
  return `Cancelado. No registré nada.`;
}

export function msgAyudaMovimiento(params: {
  intento: MovimientoTipo;
  faltaMonto: boolean;
  faltaEmpleada: boolean;
}): string {
  const faltan: string[] = [];
  if (params.faltaMonto) faltan.push('el monto');
  if (params.faltaEmpleada) faltan.push('la empleada');
  const ejemplo =
    params.intento === 'prestamo' ? 'le presté 200 a Nena' : 'bono de 50 a Maye por navidad';
  return `Entendí que es un *${etiquetaMov(params.intento).toLowerCase()}*, pero me falta ${faltan.join(
    ' y ',
  )}. Escríbelo así: \`${ejemplo}\`.`;
}

// ---------- Consulta en vivo (sección 11) ----------

export function msgResumen(resumen: Resumen, opts: { definitivo?: boolean } = {}): string {
  const etiqueta = opts.definitivo ? '_(cerrada — definitiva)_' : '_(preliminar)_';
  const lineas: string[] = [`📊 *Resumen — ${resumen.periodo}* ${etiqueta}`, ``];

  for (const e of resumen.empleadas) {
    const horasExtra = e.desglose.extra_diurna + e.desglose.extra_nocturna + e.desglose.dominical;
    lineas.push(`*${e.alias}*`);
    lineas.push(`🕐 Horas: ${formatoDuracion(e.horas)}  ·  Extras: ${formatoDuracion(horasExtra)}`);
    lineas.push(
      `💵 Extras: ${formatoPesos(e.valorExtras)}  ·  Actividades: ${e.actividades.cantidad} (${formatoPesos(
        e.actividades.valor,
      )})`,
    );
    lineas.push(
      `🔻 Préstamos: ${formatoPesos(e.prestamos)}  ·  🔺 Bonos: ${formatoPesos(e.bonos)}`,
    );
    const etiquetaNeto = opts.definitivo ? 'Neto' : 'Neto preliminar';
    lineas.push(`${etiquetaNeto}: *${formatoPesos(e.netoPreliminar)}*`);
    if (e.pendientes > 0) {
      lineas.push(`⚠️ ${e.pendientes} marcación(es) pendiente(s) por resolver`);
    }
    lineas.push('');
  }

  if (resumen.hayPendientes && !opts.definitivo) {
    lineas.push(`⚠️ Hay marcaciones pendientes — el cierre de quincena quedaría bloqueado hasta resolverlas.`);
  }
  lineas.push(`_Neto = base/2 + extras + actividades + bonos − préstamos._`);
  return lineas.join('\n');
}

// ---------- Cierre de quincena (sección 12) ----------

export function msgCierreBloqueado(periodo: string, pendientes: PendienteResumen[]): string {
  const lineas = [
    `🚫 No puedo cerrar *${periodo}*: hay *${pendientes.length}* marcación(es) pendiente(s).`,
    `Resuélvelas primero (apruébalas o ajústalas):`,
  ];
  for (const p of pendientes) {
    const d = parseSQLaDate(p.momento_declarado);
    lineas.push(`• ${p.alias} — ${p.tipo} ${formatoHora12(d)} (${fechaISO(d)})`);
  }
  return lineas.join('\n');
}

export function msgConfirmarCierre(resumen: Resumen): string {
  return [
    `🔒 Voy a *CERRAR* la quincena *${resumen.periodo}*.`,
    `Esto congela los valores para siempre (no se recalculan aunque cambien rates después).`,
    ``,
    msgResumen(resumen),
    ``,
    `¿Confirmo el cierre?`,
  ].join('\n');
}

export function msgCierreHecho(resumen: Resumen): string {
  return [
    `✅ Quincena *${resumen.periodo}* CERRADA y congelada.`,
    `Te envío el Excel y el PDF definitivos. 📎`,
    ``,
    msgResumen(resumen, { definitivo: true }),
  ].join('\n');
}

export function msgYaCerrada(periodo: string): string {
  return `La quincena *${periodo}* ya estaba cerrada. Los reportes que pidas serán la versión definitiva congelada.`;
}

// ---------- Editar rates (sección 17) — solo grupo admin ----------

/** Formatea el valor de un rate según su campo (con AM/PM para la hora nocturna). */
export function formatoValorRate(campo: CampoRate, valor: number | string): string {
  switch (campo) {
    case 'salario_base':
      return formatoPesos(Number(valor));
    case 'divisor_horas':
      return String(valor);
    case 'inicio_nocturno':
      return formatoHora12Desde(String(valor));
    default:
      return `${(Number(valor) * 100).toFixed(0)}%`; // recargos
  }
}

export function msgRatesVigentes(rates: RatesConfig, vigenteDesde: string): string {
  return [
    `⚙️ *Rates vigentes* (desde ${formatoFechaDMYDesde(vigenteDesde)})`,
    `• Salario base: *${formatoPesos(rates.salarioBase)}*`,
    `• Divisor de horas: *${rates.divisorHoras}*  (hora ordinaria ${formatoPesos(valorHoraOrdinaria(rates))})`,
    `• Recargo extra diurna: *${(rates.recExtraDiurna * 100).toFixed(0)}%*`,
    `• Recargo extra nocturna: *${(rates.recExtraNocturna * 100).toFixed(0)}%*`,
    `• Recargo dominical/festivo: *${(rates.recDominical * 100).toFixed(0)}%*`,
    `• Inicio recargo nocturno: *${formatoHora12Desde(rates.inicioNocturno)}*`,
    ``,
    `Para cambiar algo: «cambiar salario base a 1.800.000», «recargo dominical a 100%», «inicio nocturno a 9pm»...`,
  ].join('\n');
}

export function msgConfirmarCambioRate(params: {
  etiqueta: string;
  anteriorFmt: string;
  nuevoFmt: string;
  vigenteDesde: string;
}): string {
  const { etiqueta, anteriorFmt, nuevoFmt, vigenteDesde } = params;
  return [
    `⚙️ Voy a registrar un cambio de rate:`,
    `*${etiqueta}*: ${anteriorFmt} → *${nuevoFmt}*`,
    ``,
    `Se crea una fila nueva de rates vigente desde *${formatoFechaDMYDesde(vigenteDesde)}* (no se toca lo ya calculado ni las quincenas cerradas).`,
    ``,
    `¿Confirmo?`,
  ].join('\n');
}

export function msgRateCambiado(params: { etiqueta: string; nuevoFmt: string; vigenteDesde: string }): string {
  return `✅ *${params.etiqueta}* quedó en *${params.nuevoFmt}*, vigente desde ${formatoFechaDMYDesde(
    params.vigenteDesde,
  )}.`;
}

export function msgCambioRateCancelado(): string {
  return `Cancelado. No cambié ningún rate.`;
}

// ---------- Corregir un turno pasado (sección 18) — solo grupo admin ----------

export function msgTurnoNoEncontrado(alias: string, fechaFmt: string): string {
  return `No encontré turnos de *${alias}* el ${fechaFmt}. ¿Seguro de la fecha?`;
}

/** Un turno pasado: rango de reloj + desglose de horas (sin pesos aquí, es una lista). */
export function lineaTurno(entrada: Date, salida: Date, desglose: Record<string, number>, horas: number): string {
  const d: DesgloseTramos = {
    ordinaria: desglose.ordinaria ?? 0,
    extra_diurna: desglose.extra_diurna ?? 0,
    extra_nocturna: desglose.extra_nocturna ?? 0,
    dominical: desglose.dominical ?? 0,
  };
  const tramos = desgloseHorasSinVinieta(d).replace(/\n/g, ' · ');
  return `${formatoHora12(entrada)} – ${formatoHora12(salida)} (${formatoDuracion(horas)}) · ${tramos}`;
}

export function msgTurnoUnicoParaCorregir(alias: string, fechaFmt: string, linea: string): string {
  return [
    `✏️ *Corregir turno — ${alias}* · ${fechaFmt}`,
    `Turno actual: ${linea}`,
    ``,
    `Escribe el horario correcto (un punto o un rango, ej: \`de 7:00 am a 4:00 pm\`).`,
  ].join('\n');
}

export function msgVariosTurnosParaCorregir(alias: string, fechaFmt: string, lineas: string[]): string {
  const items = lineas.map((l, i) => `${i + 1}) ${l}`).join('\n');
  return [
    `✏️ *Corregir turno — ${alias}* · ${fechaFmt}`,
    `Hay *${lineas.length}* turnos ese día (turno partido). ¿Cuál corriges?`,
    items,
  ].join('\n');
}

export function msgTurnoCorregido(params: {
  alias: string;
  fechaFmt: string;
  entrada: Date;
  salida: Date;
  r: ResultadoClasificacion;
  quincenaCerrada: boolean;
  actividades?: ActividadDelDia[];
}): string {
  const lineas = [
    `✅ Turno de *${params.alias}* (${params.fechaFmt}) corregido:`,
    `${formatoHora12(params.entrada)} – ${formatoHora12(params.salida)} (${formatoDuracion(params.r.horasTotales)})`,
    bloqueValorAdmin(params.r.valorCalculado, params.actividades ?? []),
  ];
  if (params.quincenaCerrada) {
    lineas.push(
      ``,
      `(!) Esa quincena ya está *cerrada*: el turno queda corregido pero el neto congelado NO cambia. Si hay que ajustar lo pagado, es aparte.`,
    );
  }
  return lineas.join('\n');
}

// ---------- Crear / eliminar turno manual (admin, sección 18.3) ----------

export function msgPedirRangoCrearTurno(alias: string, fechaFmt: string): string {
  return [
    `➕ Crear turno — *${alias}* · ${fechaFmt}`,
    `Escribe el horario del turno (un rango, ej: \`de 7:00 am a 4:00 pm\`).`,
  ].join('\n');
}

export function msgTurnoCreado(params: {
  alias: string;
  fechaFmt: string;
  entrada: Date;
  salida: Date;
  r: ResultadoClasificacion;
}): string {
  return [
    `✅ Turno creado — *${params.alias}* (${params.fechaFmt})`,
    `${formatoHora12(params.entrada)} – ${formatoHora12(params.salida)} (${formatoDuracion(params.r.horasTotales)})`,
    bloqueValorAdmin(params.r.valorCalculado, []),
  ].join('\n');
}

export function msgConfirmarEliminarTurno(params: {
  alias: string;
  fechaFmt: string;
  entrada: Date;
  salida: Date;
  horas: number;
}): string {
  return [
    `🗑️ ¿Eliminar este turno de *${params.alias}* (${params.fechaFmt})?`,
    `${formatoHora12(params.entrada)} – ${formatoHora12(params.salida)} (${formatoDuracion(params.horas)})`,
    ``,
    `Esto borra el turno; las marcaciones quedan anuladas. ¿Confirmas?`,
  ].join('\n');
}

export function msgVariosTurnosParaEliminar(alias: string, fechaFmt: string, lineas: string[]): string {
  return [
    `🗑️ Eliminar turno — *${alias}* · ${fechaFmt}`,
    `Hay ${lineas.length} turnos ese día. ¿Cuál eliminas?`,
    ...lineas.map((l, i) => `${i + 1}) ${l}`),
  ].join('\n');
}

export function msgTurnoEliminado(params: {
  alias: string;
  fechaFmt: string;
  entrada: Date;
  salida: Date;
  quincenaCerrada: boolean;
}): string {
  const lineas = [
    `🗑️ Turno de *${params.alias}* (${params.fechaFmt}) eliminado:`,
    `${formatoHora12(params.entrada)} – ${formatoHora12(params.salida)}`,
  ];
  if (params.quincenaCerrada) {
    lineas.push(
      ``,
      `(!) Esa quincena ya está *cerrada*: el turno se eliminó pero el neto congelado NO cambia. Si hay que ajustar lo pagado, es aparte.`,
    );
  }
  return lineas.join('\n');
}

export function msgTurnoEliminarCancelado(): string {
  return `Cancelado. No eliminé nada.`;
}

// ---------- Respaldo automático la víspera del cierre (sección 12.1) ----------

export function msgRespaldoVispera(periodo: string): string {
  return [
    `📩 *Respaldo automático* — mañana cierra la quincena *${periodo}*.`,
    `Te envío el Excel y el PDF preliminares por si acaso, para que no pierdas la info.`,
  ].join('\n');
}

// ---------- Borrar base de datos (solo desarrollo) — grupo admin ----------

export function msgConfirmarReset(): string {
  return [
    `⚠️ *BORRAR BASE DE DATOS* — solo para desarrollo`,
    ``,
    `Voy a borrar TODO esto y empezar en ceros:`,
    `• Turnos y marcaciones`,
    `• Actividades (Rocco/Gatas)`,
    `• Préstamos y bonos`,
    `• Quincenas — *incluida cualquiera ya cerrada*`,
    ``,
    `Se conservan: empleadas, admins, rates y festivos.`,
    `⚠️ Esto NO se puede deshacer.`,
    ``,
    `¿Seguro que borro todo?`,
  ].join('\n');
}

export function msgResetHecho(): string {
  return `🧹 Base de datos limpia. Turnos, marcaciones, actividades, préstamos/bonos y quincenas borrados. Puedes empezar de cero — la próxima marcación abre una quincena nueva.`;
}

export function msgResetCancelado(): string {
  return `Cancelado. No borré nada. 🙂`;
}

export function msgResetExpirado(): string {
  return `Esa confirmación ya expiró. Escribe *borrar base de datos* de nuevo si quieres reiniciar.`;
}
