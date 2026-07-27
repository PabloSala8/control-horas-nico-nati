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
import {
  getRatesVigentes,
  esDominicalOFestivo,
  ensureQuincenaVigente,
  crearTurno,
  getBloqueAbierto,
  getEmpleadasActivas,
  getQuincenaById,
  getTurnosConEventosDeQuincena,
  getTurnosDeEmpleadaEnFecha,
  agregadosTurnos,
  agregadosActividades,
  agregadosMovimientos,
  contarPendientesPorEmpleada,
  type Evento,
  type TurnoConEventos,
} from '../db/queries.ts';

/** Clasifica un par entrada/salida SIN persistir (para previsualizar impacto). */
export async function clasificarPar(
  entrada: Date,
  salida: Date,
): Promise<{ resultado: ResultadoClasificacion; ratesId: string }> {
  const fecha = fechaISO(entrada);
  const rates = await getRatesVigentes(fecha);
  const domFest = await esDominicalOFestivo(fecha, diaSemana(entrada));
  const resultado = clasificarTurno({ entrada, salida, rates, esDominicalOFestivo: domFest });
  return { resultado, ratesId: rates.ratesId };
}

/** Igual que `clasificarPar` pero tomando los eventos persistidos. */
export async function clasificarDesdeEventos(
  entrada: Evento,
  salida: Evento,
): Promise<{ resultado: ResultadoClasificacion; ratesId: string }> {
  return clasificarPar(
    parseSQLaDate(entrada.momento_declarado),
    parseSQLaDate(salida.momento_declarado),
  );
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

  const { resultado, ratesId } = await clasificarPar(entradaDate, salidaDate);
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

/** Enriquece un turno con los rangos de reloj por tramo (recalculados). */
function aTurnoReporte(t: TurnoConEventos): TurnoReporte {
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
  const segs = segmentosDeTurno({ entrada, salida, rates, esDominicalOFestivo: esDomFest });
  const rangosPorTramo = segs
    .map((s) => `${ETIQUETA_TRAMO[s.tramo]} ${formatoHora12(s.desde)}–${formatoHora12(s.hasta)}`)
    .join('\n');
  return {
    fecha: t.fecha,
    alias: t.alias,
    horas_totales: t.horas_totales,
    desglose_tramos: t.desglose_tramos,
    valor_calculado: t.valor_calculado,
    entrada: formatoHora12(entrada),
    salida: formatoHora12(salida),
    rangoTurno: `${formatoHora12(entrada)} – ${formatoHora12(salida)}`,
    rangosPorTramo,
  };
}

/** Turnos de una quincena listos para el reporte, con rangos por tramo (§13). */
export async function turnosParaReporte(quincenaId: string): Promise<TurnoReporte[]> {
  const turnos = await getTurnosConEventosDeQuincena(quincenaId);
  return turnos.map(aTurnoReporte);
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
