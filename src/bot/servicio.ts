/**
 * Capa de orquestación entre el bot, la DB (/src/db) y el motor puro (/src/core).
 * Aquí NO hay Telegram: solo se calcula y se persiste. El envío de mensajes vive
 * en index.ts. Así el motor sigue siendo probable sin bot ni DB, y esta capa se
 * puede razonar sin pensar en Telegram.
 */
import {
  clasificarTurno,
  segmentosDeTurno,
  type ResultadoClasificacion,
  type NombreTramo,
  type RatesConfig,
} from '../core/clasificador.ts';
import type { DesgloseTramos } from '../core/clasificador.ts';
import {
  parseSQLaDate,
  fechaISO,
  diaSemana,
  ahoraBogota,
  timestampSQL,
  formatoHora12,
  intervalosSeCruzan,
} from '../core/tiempo.ts';
import { salarioBaseQuincena, calcularNetoPreliminar } from '../core/quincena.ts';
import { ventanaParaFecha } from '../core/horarios.ts';
import {
  getRatesVigentes,
  esDominicalOFestivo,
  ensureQuincenaVigente,
  crearTurno,
  getBloqueAbierto,
  getEmpleadaPorId,
  getEmpleadasActivas,
  getQuincenaById,
  getTurnosConEventosDeQuincena,
  getTurnosDeEmpleadaEnFecha,
  getTurnoConEventosById,
  eliminarTurnoYRechazarEventos,
  getActividadesDetalleDeQuincena,
  agregadosTurnos,
  agregadosActividades,
  agregadosMovimientos,
  contarPendientesPorEmpleada,
  type Evento,
  type TurnoConEventos,
} from '../db/queries.ts';

/**
 * Clasifica un par entrada/salida SIN persistir (para previsualizar impacto).
 * `alias` de la empleada define su ventana ordinaria de ese día (ver horarios.ts).
 */
export async function clasificarPar(
  entrada: Date,
  salida: Date,
  alias: string,
): Promise<{ resultado: ResultadoClasificacion; ratesId: string }> {
  const fecha = fechaISO(entrada);
  const rates = await getRatesVigentes(fecha);
  const domFest = await esDominicalOFestivo(fecha, diaSemana(entrada));
  const ventanaOrdinaria = ventanaParaFecha(alias, entrada);
  const resultado = clasificarTurno({ entrada, salida, rates, esDominicalOFestivo: domFest, ventanaOrdinaria });
  return { resultado, ratesId: rates.ratesId };
}

/**
 * Regla de negocio (sección 6): una empleada NO puede tener turnos que se
 * crucen en horas el mismo día, y máximo 2 turnos por día (la excepción de dos
 * turnos es justo el partido mañana/tarde, que no se cruzan).
 */
export interface ConflictoTurno {
  tipo: 'solape' | 'max';
  /** Rango del turno con el que choca (ya formateado 12h), null para 'max'. */
  rango: string | null;
  /** Id del turno en conflicto, para ofrecer corregirlo. */
  turnoId: string | null;
}

/**
 * ¿Crear un turno [entrada, salida] para esta empleada ese día rompe la regla?
 * `excluirTurnoId` se usa al corregir un turno existente (no choca consigo mismo).
 */
export async function turnoEnConflicto(
  empleadaId: string,
  entrada: Date,
  salida: Date,
  excluirTurnoId?: string,
): Promise<ConflictoTurno | null> {
  const existentes = (await getTurnosDeEmpleadaEnFecha(empleadaId, fechaISO(entrada))).filter(
    (t) => t.id !== excluirTurnoId,
  );
  for (const t of existentes) {
    const tEntrada = parseSQLaDate(t.entrada_declarado);
    const tSalida = parseSQLaDate(t.salida_declarado);
    if (intervalosSeCruzan(entrada, salida, tEntrada, tSalida)) {
      return { tipo: 'solape', rango: `${formatoHora12(tEntrada)} – ${formatoHora12(tSalida)}`, turnoId: t.id };
    }
  }
  if (existentes.length >= 2) return { tipo: 'max', rango: null, turnoId: null };
  return null;
}

export type ResultadoMaterializacion =
  | { ok: true; resultado: ResultadoClasificacion | null; turnoId: string | null }
  | { ok: false; conflicto: ConflictoTurno };

/**
 * Materializa (crea) el turno a partir de un par entrada/salida confirmado.
 * Corre el motor, asegura la quincena vigente y persiste — PERO antes valida la
 * regla de no-solape/max-2 (sección 6). Es el punto único por donde pasa TODA
 * creación de turnos, así que ninguna vía puede crear turnos cruzados.
 */
export async function materializarTurno(
  empleadaId: string,
  entrada: Evento,
  salida: Evento,
): Promise<ResultadoMaterializacion> {
  const entradaDate = parseSQLaDate(entrada.momento_declarado);
  const salidaDate = parseSQLaDate(salida.momento_declarado);
  const fecha = fechaISO(entradaDate);

  const conflicto = await turnoEnConflicto(empleadaId, entradaDate, salidaDate);
  if (conflicto) return { ok: false, conflicto };

  const emp = await getEmpleadaPorId(empleadaId);
  const { resultado, ratesId } = await clasificarPar(entradaDate, salidaDate, emp?.alias ?? '');
  const quincenaId = await ensureQuincenaVigente(fecha);

  const turno = await crearTurno({
    empleadaId,
    fecha,
    horasTotales: resultado.horasTotales,
    desgloseTramos: resultado.desglose,
    valorTramos: resultado.detalle.valorPorTramo,
    valorCalculado: resultado.valorCalculado,
    ratesId,
    quincenaId,
    entradaEventoId: entrada.id,
    salidaEventoId: salida.id,
  });

  return { ok: true, resultado, turnoId: turno?.id ?? null };
}

/**
 * Procesa un evento recién confirmado y, si corresponde, materializa el turno.
 *  - `salida`: busca el bloque abierto y cierra el turno (puede chocar por regla).
 *  - `entrada` (corrección): no crea turno todavía (el bloque queda abierto).
 */
export async function procesarEventoConfirmado(evento: Evento): Promise<ResultadoMaterializacion> {
  if (evento.tipo === 'salida') {
    const bloque = await getBloqueAbierto(evento.empleada_id);
    if (!bloque) return { ok: true, resultado: null, turnoId: null }; // no había bloque que cerrar
    return materializarTurno(evento.empleada_id, bloque, evento);
  }
  // entrada confirmada: supersede la entrada anterior; el bloque queda abierto.
  return { ok: true, resultado: null, turnoId: null };
}

/**
 * Elimina un turno (admin, sección 18.3). Devuelve datos para el mensaje, o null
 * si el turno ya no existe. Si su quincena está cerrada, `quincenaCerrada` avisa que
 * el neto congelado no cambia (igual que al corregir).
 */
export async function eliminarTurno(
  turnoId: string,
): Promise<{ quincenaCerrada: boolean; alias: string; fecha: string; entrada: Date; salida: Date } | null> {
  const t = await getTurnoConEventosById(turnoId);
  if (!t) return null;
  const q = t.quincena_id ? await getQuincenaById(t.quincena_id) : null;
  await eliminarTurnoYRechazarEventos(turnoId);
  return {
    quincenaCerrada: q?.estado === 'cerrada',
    alias: t.alias,
    fecha: t.fecha,
    entrada: parseSQLaDate(t.entrada_declarado),
    salida: parseSQLaDate(t.salida_declarado),
  };
}

// ============================================================================
// Consulta en vivo (sección 11): arma el resumen de una quincena
// ============================================================================

export interface ResumenEmpleada {
  empleadaId: string;
  alias: string;
  horas: number;
  desglose: DesgloseTramos; // horas sumadas
  valorExtras: number;
  actividades: { cantidad: number; valor: number };
  prestamos: number;
  bonos: number;
  pendientes: number;
  salarioBaseQuincena: number;
  netoPreliminar: number;
}

export interface Resumen {
  periodo: string;
  empleadas: ResumenEmpleada[];
  hayPendientes: boolean;
}

/** Calcula al instante el estado de una quincena contra la DB. No genera archivos. */
export async function construirResumen(quincenaId: string): Promise<Resumen> {
  const [empleadas, aggT, aggA, aggM, pend, quincena] = await Promise.all([
    getEmpleadasActivas(),
    agregadosTurnos(quincenaId),
    agregadosActividades(quincenaId),
    agregadosMovimientos(quincenaId),
    contarPendientesPorEmpleada(),
    getQuincenaById(quincenaId),
  ]);

  const turnosPorE = new Map(aggT.map((r) => [r.empleada_id, r]));
  const actPorE = new Map(aggA.map((r) => [r.empleada_id, r]));
  const pendPorE = new Map(pend.map((r) => [r.empleada_id, Number(r.n)]));
  const movPorE = (id: string, tipo: 'prestamo' | 'bono') =>
    Math.round(aggM.find((r) => r.empleada_id === id && r.tipo === tipo)?.total ?? 0);

  const empleadasResumen: ResumenEmpleada[] = empleadas.map((e) => {
    const t = turnosPorE.get(e.id);
    const a = actPorE.get(e.id);
    const prestamos = movPorE(e.id, 'prestamo');
    const bonos = movPorE(e.id, 'bono');
    const valorExtras = Math.round(t?.valor_extras ?? 0);
    const valorActividades = Math.round(a?.valor ?? 0);
    const sbq = salarioBaseQuincena(e.salario_base_mensual);
    return {
      empleadaId: e.id,
      alias: e.alias,
      horas: Number(t?.horas ?? 0),
      desglose: {
        ordinaria: Number(t?.ordinaria_h ?? 0),
        extra_diurna: Number(t?.extra_diurna_h ?? 0),
        extra_nocturna: Number(t?.extra_nocturna_h ?? 0),
        dominical: Number(t?.dominical_h ?? 0),
      },
      valorExtras,
      actividades: { cantidad: Number(a?.cantidad ?? 0), valor: valorActividades },
      prestamos,
      bonos,
      pendientes: pendPorE.get(e.id) ?? 0,
      salarioBaseQuincena: sbq,
      netoPreliminar: calcularNetoPreliminar({
        salarioBaseQuincena: sbq,
        valorExtras,
        valorActividades,
        bonos,
        prestamos,
      }),
    };
  });

  return {
    periodo: quincena?.periodo ?? '—',
    empleadas: empleadasResumen,
    hayPendientes: empleadasResumen.some((e) => e.pendientes > 0),
  };
}

export interface ReporteData {
  resumen: Resumen;
  /** true si sale del snapshot congelado (quincena cerrada); false = parcial. */
  definitivo: boolean;
  /** "YYYY-MM-DD HH:MM" en hora Bogotá (cierre o momento de generación). */
  generadoEn: string;
}

// ============================================================================
// Rangos de horas por tramo para el reporte (sección 13): se RECALCULAN al
// generar, a partir de la entrada/salida real — no se guardan duplicados.
// ============================================================================

const ETIQUETA_TRAMO: Record<NombreTramo, string> = {
  ordinaria: 'Ordinaria',
  extra_diurna: 'Extra diurna',
  extra_nocturna: 'Extra nocturna',
  dominical: 'Dominical/festivo',
};

export interface TurnoReporte {
  fecha: string;
  alias: string;
  horas_totales: string;
  desglose_tramos: Record<string, number>;
  valor_calculado: number;
  entrada: string; // "6:00 AM"
  salida: string; // "5:00 PM"
  rangoTurno: string; // "6:00 AM – 5:00 PM"
  rangosPorTramo: string; // multilínea: "Ordinaria 6:00 AM–1:00 PM\nExtra diurna ..."
}

/** Rangos de reloj por tramo de un turno (recalculados, multilínea). */
function rangosPorTramoDe(t: TurnoConEventos): string {
  const entrada = parseSQLaDate(t.entrada_declarado);
  const salida = parseSQLaDate(t.salida_declarado);
  const rates = {
    divisorHoras: t.divisor_horas,
    inicioNocturno: t.inicio_nocturno.slice(0, 5),
    // El resto no lo usa `segmentosDeTurno`, pero completa el tipo.
    salarioBase: 0,
    recExtraDiurna: 0,
    recExtraNocturna: 0,
    recDominical: 0,
  } satisfies RatesConfig;
  const esDomFest = Number(t.desglose_tramos.dominical ?? 0) > 0;
  const ventanaOrdinaria = ventanaParaFecha(t.alias, entrada);
  return segmentosDeTurno({ entrada, salida, rates, esDominicalOFestivo: esDomFest, ventanaOrdinaria })
    .map((s) => `${ETIQUETA_TRAMO[s.tramo]} ${formatoHora12(s.desde)}–${formatoHora12(s.hasta)}`)
    .join('\n');
}

/** Enriquece un turno con los rangos de reloj por tramo (recalculados). */
function aTurnoReporte(t: TurnoConEventos): TurnoReporte {
  const entrada = parseSQLaDate(t.entrada_declarado);
  const salida = parseSQLaDate(t.salida_declarado);
  return {
    fecha: t.fecha,
    alias: t.alias,
    horas_totales: t.horas_totales,
    desglose_tramos: t.desglose_tramos,
    valor_calculado: t.valor_calculado,
    entrada: formatoHora12(entrada),
    salida: formatoHora12(salida),
    rangoTurno: `${formatoHora12(entrada)} – ${formatoHora12(salida)}`,
    rangosPorTramo: rangosPorTramoDe(t),
  };
}

/** Turnos de una quincena listos para el reporte, con rangos por tramo (§13). */
export async function turnosParaReporte(quincenaId: string): Promise<TurnoReporte[]> {
  const turnos = await getTurnosConEventosDeQuincena(quincenaId);
  return turnos.map(aTurnoReporte);
}

// ============================================================================
// Reporte SEPARADO por empleada (sección 13.1): turnos + actividades del día
// fusionados y listos para una hoja de Excel por persona. Solo agrupa/ordena
// para presentación — no cambia ningún valor calculado.
// ============================================================================

export interface FilaReporteExcel {
  fecha: string; // 'YYYY-MM-DD' (el Excel lo formatea a DD/MM/YYYY)
  entrada: string; // '' en una fila de solo-actividad
  salida: string;
  horas: number | null; // total del turno; null (celda en blanco) si solo-actividad
  ordinariaH: number | null;
  extraDiurnaH: number | null;
  extraDiurnaV: number | null;
  extraNocturnaH: number | null;
  extraNocturnaV: number | null;
  dominicalH: number | null;
  dominicalV: number | null;
  actividad: string; // nombres del día (p.ej. "Rocco, 2 Gatas"), '' si ninguna
  valorTurno: number | null; // valor_calculado; null si solo-actividad
  rangosPorTramo: string;
  soloActividad: boolean;
}

export interface TurnosEmpleadaReporte {
  empleadaId: string;
  alias: string;
  filas: FilaReporteExcel[];
  totalExtraHoras: number;
  totalExtraValor: number;
}

const soloFecha = (f: string) => f.slice(0, 10);
const toNum = (v: unknown) => Number(v ?? 0);
const textoActividades = (items: { nombre: string; cantidad: number }[]) =>
  items.map((a) => (a.cantidad > 1 ? `${a.cantidad} ${a.nombre}` : a.nombre)).join(', ');

export async function turnosPorEmpleadaParaReporte(
  quincenaId: string,
): Promise<TurnosEmpleadaReporte[]> {
  const [turnos, actividades, empleadas] = await Promise.all([
    getTurnosConEventosDeQuincena(quincenaId),
    getActividadesDetalleDeQuincena(quincenaId),
    getEmpleadasActivas(),
  ]);

  return empleadas.map((e) => {
    const misTurnos = turnos
      .filter((t) => t.empleada_id === e.id)
      .sort(
        (a, b) =>
          soloFecha(a.fecha).localeCompare(soloFecha(b.fecha)) ||
          a.entrada_declarado.localeCompare(b.entrada_declarado),
      );

    // Actividades del día: fecha -> lista de {nombre, cantidad}.
    const actPorDia = new Map<string, { nombre: string; cantidad: number }[]>();
    for (const a of actividades) {
      if (a.empleada_id !== e.id) continue;
      const k = soloFecha(a.fecha);
      const arr = actPorDia.get(k);
      if (arr) arr.push({ nombre: a.nombre, cantidad: a.cantidad });
      else actPorDia.set(k, [{ nombre: a.nombre, cantidad: a.cantidad }]);
    }
    const fechasConTurno = new Set(misTurnos.map((t) => soloFecha(t.fecha)));

    const filas: FilaReporteExcel[] = [];
    let totalExtraHoras = 0;
    let totalExtraValor = 0;

    // 1) Filas de turnos. La actividad del día se muestra solo en el primer turno
    //    de esa fecha (evita que un turno partido la duplique visualmente).
    const actMostradaEn = new Set<string>();
    for (const t of misTurnos) {
      const f = soloFecha(t.fecha);
      const g = t.desglose_tramos ?? {};
      const v = t.valor_tramos ?? {};
      const eDiaH = toNum(g.extra_diurna);
      const eNocH = toNum(g.extra_nocturna);
      const domH = toNum(g.dominical);
      const eDiaV = Math.round(toNum(v.extra_diurna));
      const eNocV = Math.round(toNum(v.extra_nocturna));
      const domV = Math.round(toNum(v.dominical));
      totalExtraHoras += eDiaH + eNocH + domH;
      totalExtraValor += eDiaV + eNocV + domV;
      const mostrarAct = actPorDia.has(f) && !actMostradaEn.has(f);
      if (mostrarAct) actMostradaEn.add(f);
      filas.push({
        fecha: f,
        entrada: formatoHora12(parseSQLaDate(t.entrada_declarado)),
        salida: formatoHora12(parseSQLaDate(t.salida_declarado)),
        horas: toNum(t.horas_totales),
        ordinariaH: toNum(g.ordinaria),
        extraDiurnaH: eDiaH,
        extraDiurnaV: eDiaV,
        extraNocturnaH: eNocH,
        extraNocturnaV: eNocV,
        dominicalH: domH,
        dominicalV: domV,
        actividad: mostrarAct ? textoActividades(actPorDia.get(f)!) : '',
        valorTurno: t.valor_calculado,
        rangosPorTramo: rangosPorTramoDe(t),
        soloActividad: false,
      });
    }

    // 2) Días con actividad pero SIN ningún turno -> fila con horas en blanco.
    for (const [f, items] of actPorDia) {
      if (fechasConTurno.has(f)) continue;
      filas.push({
        fecha: f,
        entrada: '',
        salida: '',
        horas: null,
        ordinariaH: null,
        extraDiurnaH: null,
        extraDiurnaV: null,
        extraNocturnaH: null,
        extraNocturnaV: null,
        dominicalH: null,
        dominicalV: null,
        actividad: textoActividades(items),
        valorTurno: null,
        rangosPorTramo: '',
        soloActividad: true,
      });
    }

    filas.sort((a, b) => a.fecha.localeCompare(b.fecha)); // estable: mantiene el orden por entrada dentro del día
    return { empleadaId: e.id, alias: e.alias, filas, totalExtraHoras, totalExtraValor };
  });
}

/**
 * Datos para un reporte (sección 13): si la quincena está cerrada, se sirve el
 * snapshot congelado (definitivo, NUNCA se recalcula); si está abierta, se
 * calcula en vivo y se marca como parcial.
 */
export async function resumenParaReporte(quincenaId: string): Promise<ReporteData> {
  const q = await getQuincenaById(quincenaId);
  if (!q) throw new Error('Quincena no encontrada.');
  if (q.estado === 'cerrada' && q.snapshot) {
    return {
      resumen: q.snapshot as Resumen,
      definitivo: true,
      generadoEn: (q.cerrada_en ?? timestampSQL(ahoraBogota())).slice(0, 16),
    };
  }
  return {
    resumen: await construirResumen(quincenaId),
    definitivo: false,
    generadoEn: timestampSQL(ahoraBogota()).slice(0, 16),
  };
}
