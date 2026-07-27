/**
 * Utilidades de tiempo.
 *
 * Colombia (America/Bogota) es UTC-5 todo el año — no hay horario de verano.
 * Para que el motor de clasificación (funciones puras) no dependa de la
 * zona horaria del proceso ni de `Intl`, adoptamos una convención simple:
 *
 *   Un `Date` que representa una hora de pared en Bogotá se construye de modo
 *   que sus *campos UTC* (`getUTCHours()`, `getUTCMinutes()`, ...) devuelvan
 *   directamente la hora de Bogotá.
 *
 * Es decir: horaBogota = horaUTC - 5h. El motor lee siempre con accesores
 * `getUTC*`, y el resto del sistema (bot, DB) construye/serializa estos Date
 * a través de estos helpers. Nada más en el código llama a `new Date()` para
 * lógica de negocio.
 */

const OFFSET_BOGOTA_MIN = -5 * 60; // Bogotá = UTC-5

/** "Ahora" como hora de pared de Bogotá (campos UTC = hora local de Bogotá). */
export function ahoraBogota(base: Date = new Date()): Date {
  return new Date(base.getTime() + OFFSET_BOGOTA_MIN * 60_000);
}

/** Minuto del día (0..1439) según la hora de pared de Bogotá. */
export function minutoDelDia(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Día de la semana en Bogotá: 0 = domingo ... 6 = sábado. */
export function diaSemana(d: Date): number {
  return d.getUTCDay();
}

/** Fecha en formato `YYYY-MM-DD` (hora de pared de Bogotá). */
export function fechaISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Timestamp `YYYY-MM-DD HH:MM:SS` para columnas `timestamp` (sin tz) de Postgres. */
export function timestampSQL(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Parsea un `timestamp` de Postgres (`"YYYY-MM-DD HH:MM:SS"`, hora de pared de
 * Bogotá) a un Date en convención Bogotá (campos UTC == la hora almacenada).
 */
export function parseSQLaDate(s: string): Date {
  return new Date(s.replace(' ', 'T') + 'Z');
}

/** Parsea `"HH:MM"` a minuto del día. Ej. "19:00" -> 1140. */
export function horaAminutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return h * 60 + (m || 0);
}

/**
 * Construye un Date con la hora de pared de Bogotá indicada, tomando la
 * fecha (año/mes/día) de `fechaBase` (que ya viene en convención Bogotá).
 * Se usa para materializar una hora declarada (ej. "salí a las 3") sobre el
 * día correspondiente.
 */
export function conHoraDelDia(fechaBase: Date, hora: number, minuto: number): Date {
  const d = new Date(fechaBase.getTime());
  d.setUTCHours(hora, minuto, 0, 0);
  return d;
}

/** Formatea un Date (convención Bogotá) como "h:MM AM/PM". Ej. 15:00 -> "3:00 PM". */
export function formatoHora12(d: Date): string {
  const h24 = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h24 < 12 ? 'AM' : 'PM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** Formatea una hora "HH:MM" (24h) como "h:MM AM/PM". Ej. "19:00" -> "7:00 PM". */
export function formatoHora12Desde(hhmm: string): string {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  const ampm = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(m || 0).padStart(2, '0')} ${ampm}`;
}

/** Fecha en formato humano `DD/MM/YYYY` (hora de pared de Bogotá). */
export function formatoFechaDMY(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

/** Igual que `formatoFechaDMY` pero desde un string ISO "YYYY-MM-DD". */
export function formatoFechaDMYDesde(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

/**
 * ¿Dos intervalos de tiempo se cruzan? Los extremos que se TOCAN no cuentan como
 * cruce (un turno 8:00–11:00 y otro 11:00–14:00 NO se cruzan — mañana y tarde).
 * Se usa para la regla de "sin turnos solapados el mismo día" (sección 6).
 */
export function intervalosSeCruzan(aIni: Date, aFin: Date, bIni: Date, bFin: Date): boolean {
  return aIni.getTime() < bFin.getTime() && bIni.getTime() < aFin.getTime();
}

/** Formatea una cantidad de horas decimales como "Xh YYm". Ej. 7.5 -> "7h 30m". */
export function formatoDuracion(horas: number): string {
  const totalMin = Math.round(horas * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
