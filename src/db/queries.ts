/**
 * Capa de acceso a datos. Encapsula todo el SQL que necesita el bot y los jobs.
 * Ninguna regla de negocio de clasificación vive aquí (eso es /src/core) — esto
 * solo lee/escribe y mantiene invariantes de integridad (bloques, quincenas).
 */
import { query } from './pool.ts';
import type { RatesConfig, DesgloseTramos } from '../core/clasificador.ts';

// ---------- Tipos de fila ----------
export interface Empleada {
  id: string;
  nombre: string;
  alias: string;
  telegram_user_id: string | null;
  chat_id_grupo: string;
  salario_base_mensual: number;
  activa: boolean;
}

export interface Admin {
  id: string;
  nombre: string;
  telegram_user_id: string | null;
  chat_id_admin: string;
}

export type EventoTipo = 'entrada' | 'salida';
export type EventoEstado = 'confirmado' | 'pendiente' | 'rechazado';

export interface Evento {
  id: string;
  empleada_id: string;
  tipo: EventoTipo;
  momento_declarado: string; // "YYYY-MM-DD HH:MM:SS" (convención Bogotá)
  momento_mensaje: string;
  estado: EventoEstado;
  corrige_evento_id: string | null;
  aprobado_por: string | null;
}

export interface RatesVigentes extends RatesConfig {
  ratesId: string;
  vigenteDesde: string; // "YYYY-MM-DD"
}

// ---------- Empleadas / admins ----------
export async function getEmpleadaPorChat(chatId: number): Promise<Empleada | null> {
  const r = await query<Empleada>(
    `SELECT * FROM empleadas WHERE chat_id_grupo = $1 AND activa = true`,
    [chatId],
  );
  return r.rows[0] ?? null;
}

export async function getAdminPorChat(chatId: number): Promise<Admin | null> {
  const r = await query<Admin>(`SELECT * FROM admins WHERE chat_id_admin = $1 LIMIT 1`, [chatId]);
  return r.rows[0] ?? null;
}

export async function getEmpleadaPorId(id: string): Promise<Empleada | null> {
  const r = await query<Empleada>(`SELECT * FROM empleadas WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

// ---------- Rates vigentes ----------
export async function getRatesVigentes(fechaISO: string): Promise<RatesVigentes> {
  const r = await query<{
    id: string;
    salario_base: number;
    divisor_horas: number;
    rec_extra_diurna: string;
    rec_extra_nocturna: string;
    rec_dominical: string;
    inicio_nocturno: string;
  }>(
    `SELECT id, vigente_desde, salario_base, divisor_horas, rec_extra_diurna, rec_extra_nocturna,
            rec_dominical, inicio_nocturno
       FROM config_rates
      WHERE vigente_desde <= $1
      ORDER BY vigente_desde DESC, creado_en DESC
      LIMIT 1`,
    [fechaISO],
  );
  const row = r.rows[0] as (typeof r.rows)[0] & { vigente_desde: string };
  if (!row) throw new Error(`No hay config_rates vigente para ${fechaISO}. ¿Corriste el seed?`);
  return {
    ratesId: row.id,
    vigenteDesde: String(row.vigente_desde).slice(0, 10),
    salarioBase: row.salario_base,
    divisorHoras: row.divisor_horas,
    recExtraDiurna: Number(row.rec_extra_diurna),
    recExtraNocturna: Number(row.rec_extra_nocturna),
    recDominical: Number(row.rec_dominical),
    inicioNocturno: row.inicio_nocturno.slice(0, 5), // "19:00:00" -> "19:00"
  };
}

/**
 * Inserta una fila NUEVA de `config_rates` (sección 17). Nunca se edita en sitio
 * (convención CLAUDE.md): cada cambio es una fila con su `vigente_desde`.
 */
export async function insertarConfigRates(params: {
  vigenteDesde: string;
  salarioBase: number;
  divisorHoras: number;
  recExtraDiurna: number;
  recExtraNocturna: number;
  recDominical: number;
  inicioNocturno: string; // "HH:MM"
  creadoPor: string;
}): Promise<void> {
  await query(
    `INSERT INTO config_rates
       (vigente_desde, salario_base, divisor_horas, rec_extra_diurna, rec_extra_nocturna,
        rec_dominical, inicio_nocturno, creado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.vigenteDesde,
      params.salarioBase,
      params.divisorHoras,
      params.recExtraDiurna,
      params.recExtraNocturna,
      params.recDominical,
      params.inicioNocturno,
      params.creadoPor,
    ],
  );
}

// ---------- Festivos / domingo ----------
export async function esDominicalOFestivo(fechaISO: string, diaSemana: number): Promise<boolean> {
  if (diaSemana === 0) return true; // domingo
  const r = await query(`SELECT 1 FROM festivos WHERE fecha = $1`, [fechaISO]);
  return r.rowCount ? r.rowCount > 0 : false;
}

// ---------- Eventos ----------
export async function crearEvento(params: {
  empleadaId: string;
  tipo: EventoTipo;
  momentoDeclarado: string;
  momentoMensaje: string;
  estado: EventoEstado;
  corrigeEventoId?: string | null;
  aprobadoPor?: string | null;
}): Promise<Evento> {
  const r = await query<Evento>(
    `INSERT INTO eventos_marcacion
       (empleada_id, tipo, momento_declarado, momento_mensaje, estado, corrige_evento_id, aprobado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.empleadaId,
      params.tipo,
      params.momentoDeclarado,
      params.momentoMensaje,
      params.estado,
      params.corrigeEventoId ?? null,
      params.aprobadoPor ?? null,
    ],
  );
  return r.rows[0];
}

export async function getEvento(id: string): Promise<Evento | null> {
  const r = await query<Evento>(`SELECT * FROM eventos_marcacion WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

/**
 * Transiciona el estado de un evento (aprobación). NO toca momento_declarado ni
 * tipo — solo el ciclo de vida estado/aprobado_por (sección 7, paso 4). La
 * corrección de la *hora* nunca edita una fila: es un evento nuevo (ver
 * `ajustarHoraEvento`), respetando la inmutabilidad de la sección 3.
 */
export async function transicionarEstado(
  eventoId: string,
  estado: EventoEstado,
  aprobadoPor: string | null,
): Promise<void> {
  await query(`UPDATE eventos_marcacion SET estado = $2, aprobado_por = $3 WHERE id = $1`, [
    eventoId,
    estado,
    aprobadoPor,
  ]);
}

/**
 * "Ajustar hora": el admin fija una hora distinta a la interpretada/propuesta.
 * Respeta inmutabilidad — el evento pendiente pasa a `rechazado` y se crea un
 * evento NUEVO confirmado con la hora corregida, encadenado vía corrige_evento_id.
 */
export async function ajustarHoraEvento(params: {
  eventoPendiente: Evento;
  nuevoMomentoDeclarado: string;
  aprobadoPor: string;
}): Promise<Evento> {
  const { eventoPendiente, nuevoMomentoDeclarado, aprobadoPor } = params;
  await transicionarEstado(eventoPendiente.id, 'rechazado', aprobadoPor);
  return crearEvento({
    empleadaId: eventoPendiente.empleada_id,
    tipo: eventoPendiente.tipo,
    momentoDeclarado: nuevoMomentoDeclarado,
    momentoMensaje: eventoPendiente.momento_mensaje,
    estado: 'confirmado',
    // Mantiene la cadena de corrección del pendiente (o apunta al pendiente si no tenía).
    corrigeEventoId: eventoPendiente.corrige_evento_id ?? eventoPendiente.id,
    aprobadoPor,
  });
}

/**
 * Bloque abierto de una empleada = entrada `confirmado` que (a) no fue consumida
 * por ningún turno y (b) no fue superada por una corrección confirmada.
 * El invariante de la sección 6 garantiza como máximo uno.
 */
export async function getBloqueAbierto(empleadaId: string): Promise<Evento | null> {
  const r = await query<Evento>(
    `SELECT e.* FROM eventos_marcacion e
      WHERE e.empleada_id = $1
        AND e.tipo = 'entrada'
        AND e.estado = 'confirmado'
        AND NOT EXISTS (SELECT 1 FROM turnos t WHERE t.entrada_evento_id = e.id)
        AND NOT EXISTS (
              SELECT 1 FROM eventos_marcacion c
               WHERE c.corrige_evento_id = e.id AND c.estado = 'confirmado')
      ORDER BY e.momento_declarado DESC, e.creado_en DESC
      LIMIT 1`,
    [empleadaId],
  );
  return r.rows[0] ?? null;
}

// ---------- Quincenas ----------
const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

/**
 * Asegura que exista la quincena vigente para una fecha y devuelve su id.
 * Quincena Q1 = días 1-15, Q2 = 16-fin de mes (Glosario + sección 12).
 */
export async function ensureQuincenaVigente(fechaISO: string): Promise<string> {
  const [año, mes, dia] = fechaISO.split('-').map((n) => parseInt(n, 10));
  const ultimoDia = new Date(Date.UTC(año, mes, 0)).getUTCDate();
  const esQ1 = dia <= 15;
  const inicio = `${año}-${String(mes).padStart(2, '0')}-01`;
  const finDia = esQ1 ? 15 : ultimoDia;
  const inicioReal = esQ1
    ? inicio
    : `${año}-${String(mes).padStart(2, '0')}-16`;
  const fin = `${año}-${String(mes).padStart(2, '0')}-${String(finDia).padStart(2, '0')}`;
  const periodo = `${esQ1 ? 'Q1' : 'Q2'}-${MESES[mes - 1]} ${año}`;

  await query(
    `INSERT INTO quincenas (periodo, fecha_inicio, fecha_fin, estado)
     VALUES ($1, $2, $3, 'abierta')
     ON CONFLICT (fecha_inicio, fecha_fin) DO NOTHING`,
    [periodo, inicioReal, fin],
  );
  const r = await query<{ id: string }>(
    `SELECT id FROM quincenas WHERE fecha_inicio = $1 AND fecha_fin = $2`,
    [inicioReal, fin],
  );
  return r.rows[0].id;
}

export interface Quincena {
  id: string;
  periodo: string;
  fecha_inicio: string;
  fecha_fin: string;
  estado: 'abierta' | 'cerrada';
  snapshot: unknown | null;
  cerrada_en: string | null;
}

export async function getQuincenaById(id: string): Promise<Quincena | null> {
  const r = await query<Quincena>(
    `SELECT id, periodo, fecha_inicio, fecha_fin, estado, snapshot, cerrada_en
       FROM quincenas WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

// ---------- Cierre de quincena (sección 12) ----------
export interface PendienteResumen {
  id: string;
  alias: string;
  tipo: EventoTipo;
  momento_declarado: string;
}

/** Marcaciones pendientes cuya hora declarada cae dentro del rango de la quincena. */
export async function pendientesEnRango(
  fechaInicio: string,
  fechaFin: string,
): Promise<PendienteResumen[]> {
  const r = await query<PendienteResumen>(
    `SELECT e.id, em.alias, e.tipo, e.momento_declarado
       FROM eventos_marcacion e JOIN empleadas em ON em.id = e.empleada_id
      WHERE e.estado = 'pendiente'
        AND e.momento_declarado::date BETWEEN $1 AND $2
      ORDER BY e.momento_declarado`,
    [fechaInicio, fechaFin],
  );
  return r.rows;
}

/**
 * Congela la quincena: escribe snapshot, marca `cerrada`. SOLO procede si estaba
 * `abierta` (garantiza que el snapshot es de escritura única — convención
 * CLAUDE.md). Devuelve true si efectivamente la cerró.
 */
export async function marcarQuincenaCerrada(id: string, snapshotJson: string): Promise<boolean> {
  const r = await query(
    `UPDATE quincenas
        SET estado = 'cerrada', snapshot = $2::jsonb,
            cerrada_en = (now() AT TIME ZONE 'America/Bogota')
      WHERE id = $1 AND estado = 'abierta'`,
    [id, snapshotJson],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface MovimientoDetalle {
  alias: string;
  tipo: MovimientoTipo;
  monto: number;
  fecha: string;
  nota: string | null;
}

export async function getMovimientosDeQuincena(quincenaId: string): Promise<MovimientoDetalle[]> {
  const r = await query<MovimientoDetalle>(
    `SELECT em.alias, m.tipo, m.monto, m.fecha, m.nota
       FROM movimientos m JOIN empleadas em ON em.id = m.empleada_id
      WHERE m.quincena_id = $1 ORDER BY m.fecha, em.alias`,
    [quincenaId],
  );
  return r.rows;
}

// ---------- Turnos ----------
export interface Turno {
  id: string;
  empleada_id: string;
  fecha: string;
  horas_totales: string;
  desglose_tramos: Record<string, number>;
  valor_calculado: number;
  quincena_id: string | null;
}

export async function crearTurno(params: {
  empleadaId: string;
  fecha: string;
  horasTotales: number;
  desgloseTramos: DesgloseTramos;
  valorTramos: DesgloseTramos;
  valorCalculado: number;
  ratesId: string;
  quincenaId: string;
  entradaEventoId: string;
  salidaEventoId: string;
}): Promise<Turno> {
  const r = await query<Turno>(
    `INSERT INTO turnos
       (empleada_id, fecha, horas_totales, desglose_tramos, valor_tramos, valor_calculado,
        rates_id, quincena_id, entrada_evento_id, salida_evento_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (entrada_evento_id, salida_evento_id) DO NOTHING
     RETURNING *`,
    [
      params.empleadaId,
      params.fecha,
      params.horasTotales,
      JSON.stringify(params.desgloseTramos),
      JSON.stringify(params.valorTramos),
      params.valorCalculado,
      params.ratesId,
      params.quincenaId,
      params.entradaEventoId,
      params.salidaEventoId,
    ],
  );
  return r.rows[0];
}

/**
 * Turno + sus eventos entrada/salida reales + los campos de rate necesarios para
 * recalcular los rangos por tramo (sección 13) o para corregirlo (sección 18).
 * La entrada/salida NO se guardan duplicadas en `turnos`: se leen de los eventos.
 */
export interface TurnoConEventos {
  id: string;
  fecha: string;
  alias: string;
  empleada_id: string;
  horas_totales: string;
  desglose_tramos: Record<string, number>;
  valor_tramos: Record<string, number>; // pesos por tramo (para desglosar extras en el reporte)
  valor_calculado: number;
  rates_id: string;
  quincena_id: string | null;
  entrada_evento_id: string;
  salida_evento_id: string;
  entrada_declarado: string; // momento_declarado del evento de entrada
  salida_declarado: string;
  divisor_horas: number;
  inicio_nocturno: string; // "HH:MM:SS"
}

const SELECT_TURNO_EVENTOS = `
  SELECT t.id, t.fecha, em.alias, t.empleada_id, t.horas_totales, t.desglose_tramos,
         t.valor_tramos, t.valor_calculado, t.rates_id, t.quincena_id, t.entrada_evento_id, t.salida_evento_id,
         ev_in.momento_declarado  AS entrada_declarado,
         ev_out.momento_declarado AS salida_declarado,
         cr.divisor_horas, cr.inicio_nocturno
    FROM turnos t
    JOIN empleadas em          ON em.id = t.empleada_id
    JOIN eventos_marcacion ev_in  ON ev_in.id = t.entrada_evento_id
    JOIN eventos_marcacion ev_out ON ev_out.id = t.salida_evento_id
    JOIN config_rates cr       ON cr.id = t.rates_id`;

/** Turnos de una empleada en una fecha (0, 1, o varios si es turno partido). */
export async function getTurnosDeEmpleadaEnFecha(
  empleadaId: string,
  fecha: string,
): Promise<TurnoConEventos[]> {
  const r = await query<TurnoConEventos>(
    `${SELECT_TURNO_EVENTOS} WHERE t.empleada_id = $1 AND t.fecha = $2 ORDER BY ev_in.momento_declarado`,
    [empleadaId, fecha],
  );
  return r.rows;
}

/**
 * Reinicia a cero los datos OPERATIVOS (solo desarrollo): turnos, marcaciones,
 * actividades, préstamos/bonos y quincenas — incluida cualquier quincena cerrada.
 * Conserva la configuración/referencia (empleadas, admins, config_rates,
 * catalogo_actividades, festivos) para que el bot siga funcionando sin re-seed.
 */
export async function resetDatosOperativos(): Promise<void> {
  await query(
    `TRUNCATE TABLE turnos, actividades, movimientos, eventos_marcacion, quincenas RESTART IDENTITY CASCADE`,
  );
}

/** Un turno concreto por id, con entrada/salida y rate (sección 18). */
export async function getTurnoConEventosById(turnoId: string): Promise<TurnoConEventos | null> {
  const r = await query<TurnoConEventos>(`${SELECT_TURNO_EVENTOS} WHERE t.id = $1`, [turnoId]);
  return r.rows[0] ?? null;
}

/** Turnos de una quincena con entrada/salida y rate (para rangos por tramo, §13). */
export async function getTurnosConEventosDeQuincena(quincenaId: string): Promise<TurnoConEventos[]> {
  const r = await query<TurnoConEventos>(
    `${SELECT_TURNO_EVENTOS} WHERE t.quincena_id = $1 ORDER BY t.fecha, em.alias`,
    [quincenaId],
  );
  return r.rows;
}

/**
 * Recalcula un turno ya existente (sección 18). `turnos` es DERIVADA, así que sí
 * se actualiza en sitio — pero la corrección de las HORAS se hace con eventos
 * nuevos (inmutabilidad de la sección 3): el llamador crea los eventos corregidos
 * y pasa sus ids aquí. No toca `fecha` ni `quincena_id` (misma quincena).
 */
export async function actualizarTurnoCorregido(params: {
  turnoId: string;
  entradaEventoId: string;
  salidaEventoId: string;
  horasTotales: number;
  desgloseTramos: DesgloseTramos;
  valorTramos: DesgloseTramos;
  valorCalculado: number;
  ratesId: string;
}): Promise<void> {
  await query(
    `UPDATE turnos
        SET entrada_evento_id = $2, salida_evento_id = $3, horas_totales = $4,
            desglose_tramos = $5::jsonb, valor_tramos = $6::jsonb,
            valor_calculado = $7, rates_id = $8
      WHERE id = $1`,
    [
      params.turnoId,
      params.entradaEventoId,
      params.salidaEventoId,
      params.horasTotales,
      JSON.stringify(params.desgloseTramos),
      JSON.stringify(params.valorTramos),
      params.valorCalculado,
      params.ratesId,
    ],
  );
}

// ============================================================================
// Fase 2: actividades, movimientos (préstamos/bonos) y agregados de quincena
// ============================================================================

export type MovimientoTipo = 'prestamo' | 'bono';

export interface CatalogoActividad {
  id: string;
  nombre: string;
  valor: number;
  activa: boolean;
}

export async function getEmpleadasActivas(): Promise<Empleada[]> {
  const r = await query<Empleada>(`SELECT * FROM empleadas WHERE activa = true ORDER BY alias`);
  return r.rows;
}

export async function getCatalogoActivo(): Promise<CatalogoActividad[]> {
  const r = await query<CatalogoActividad>(
    `SELECT id, nombre, valor, activa FROM catalogo_actividades WHERE activa = true ORDER BY nombre`,
  );
  return r.rows;
}

export async function getCatalogoById(id: string): Promise<CatalogoActividad | null> {
  const r = await query<CatalogoActividad>(
    `SELECT id, nombre, valor, activa FROM catalogo_actividades WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function crearActividad(params: {
  empleadaId: string;
  catalogoId: string;
  fecha: string;
  quincenaId: string;
}): Promise<void> {
  await query(
    `INSERT INTO actividades (empleada_id, catalogo_id, fecha, quincena_id)
     VALUES ($1, $2, $3, $4)`,
    [params.empleadaId, params.catalogoId, params.fecha, params.quincenaId],
  );
}

export async function crearMovimiento(params: {
  empleadaId: string;
  tipo: MovimientoTipo;
  monto: number;
  fecha: string;
  quincenaId: string;
  registradoPor: string;
  nota?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO movimientos (empleada_id, tipo, monto, fecha, quincena_id, registrado_por, nota)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.empleadaId,
      params.tipo,
      params.monto,
      params.fecha,
      params.quincenaId,
      params.registradoPor,
      params.nota ?? null,
    ],
  );
}

// ---------- Agregados para la consulta en vivo (sección 11) ----------
export interface AgregadoTurnos {
  empleada_id: string;
  horas: number;
  ordinaria_h: number;
  extra_diurna_h: number;
  extra_nocturna_h: number;
  dominical_h: number;
  valor_extras: number; // pesos de recargos (sin la parte ordinaria)
  valor_total: number; // pesos de todo el turno (informativo)
}

export async function agregadosTurnos(quincenaId: string): Promise<AgregadoTurnos[]> {
  const r = await query<AgregadoTurnos>(
    `SELECT empleada_id,
        SUM(horas_totales)::float8                                   AS horas,
        SUM((desglose_tramos->>'ordinaria')::numeric)::float8        AS ordinaria_h,
        SUM((desglose_tramos->>'extra_diurna')::numeric)::float8     AS extra_diurna_h,
        SUM((desglose_tramos->>'extra_nocturna')::numeric)::float8   AS extra_nocturna_h,
        SUM((desglose_tramos->>'dominical')::numeric)::float8        AS dominical_h,
        SUM(COALESCE((valor_tramos->>'extra_diurna')::numeric,0)
          + COALESCE((valor_tramos->>'extra_nocturna')::numeric,0)
          + COALESCE((valor_tramos->>'dominical')::numeric,0))::float8 AS valor_extras,
        SUM(valor_calculado)::float8                                 AS valor_total
     FROM turnos WHERE quincena_id = $1 GROUP BY empleada_id`,
    [quincenaId],
  );
  return r.rows;
}

/** Actividades de una empleada en un día, agrupadas por nombre (para el cierre de turno). */
export interface ActividadDelDia {
  nombre: string;
  cantidad: number;
  valor: number; // valor total del grupo (cantidad × valor unitario)
}

export async function getActividadesDeEmpleadaEnFecha(
  empleadaId: string,
  fecha: string,
): Promise<ActividadDelDia[]> {
  const r = await query<ActividadDelDia>(
    `SELECT c.nombre, COUNT(*)::int AS cantidad, SUM(c.valor)::float8 AS valor
       FROM actividades a JOIN catalogo_actividades c ON c.id = a.catalogo_id
      WHERE a.empleada_id = $1 AND a.fecha = $2
      GROUP BY c.nombre ORDER BY c.nombre`,
    [empleadaId, fecha],
  );
  return r.rows;
}

/** Detalle de actividades de una quincena por empleada y día (para el Excel §13.1). */
export interface ActividadReporteDetalle {
  empleada_id: string;
  fecha: string;
  nombre: string;
  cantidad: number;
}

export async function getActividadesDetalleDeQuincena(
  quincenaId: string,
): Promise<ActividadReporteDetalle[]> {
  const r = await query<ActividadReporteDetalle>(
    `SELECT a.empleada_id, a.fecha, c.nombre, COUNT(*)::int AS cantidad
       FROM actividades a JOIN catalogo_actividades c ON c.id = a.catalogo_id
      WHERE a.quincena_id = $1
      GROUP BY a.empleada_id, a.fecha, c.nombre
      ORDER BY a.fecha, c.nombre`,
    [quincenaId],
  );
  return r.rows;
}

export interface AgregadoActividades {
  empleada_id: string;
  cantidad: number;
  valor: number;
}

export async function agregadosActividades(quincenaId: string): Promise<AgregadoActividades[]> {
  const r = await query<AgregadoActividades>(
    `SELECT a.empleada_id, COUNT(*)::int AS cantidad, SUM(c.valor)::float8 AS valor
       FROM actividades a JOIN catalogo_actividades c ON c.id = a.catalogo_id
      WHERE a.quincena_id = $1 GROUP BY a.empleada_id`,
    [quincenaId],
  );
  return r.rows;
}

export interface AgregadoMovimientos {
  empleada_id: string;
  tipo: MovimientoTipo;
  total: number;
}

export async function agregadosMovimientos(quincenaId: string): Promise<AgregadoMovimientos[]> {
  const r = await query<AgregadoMovimientos>(
    `SELECT empleada_id, tipo, SUM(monto)::float8 AS total
       FROM movimientos WHERE quincena_id = $1 GROUP BY empleada_id, tipo`,
    [quincenaId],
  );
  return r.rows;
}

export async function contarPendientesPorEmpleada(): Promise<Array<{ empleada_id: string; n: number }>> {
  const r = await query<{ empleada_id: string; n: number }>(
    `SELECT empleada_id, COUNT(*)::int AS n FROM eventos_marcacion
      WHERE estado = 'pendiente' GROUP BY empleada_id`,
  );
  return r.rows;
}
