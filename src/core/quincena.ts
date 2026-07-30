/**
 * Cálculo de resumen de quincena — funciones PURAS (secciones 11 y 12).
 * La agregación contra la DB vive en /src/db; aquí solo la aritmética del neto,
 * para poder probarla con datos de ejemplo.
 *
 * Reglas confirmadas por Pablo (sesión 3):
 * El glosario define  neto = salario_base + extras + actividades + bonos − préstamos.
 *  - "extras" = SOLO la parte de recargo (extra diurna + extra nocturna +
 *    dominical), NO el valor de las horas ordinarias — esas ya están cubiertas
 *    por el salario base (sumarlas sería doble conteo). CONFIRMADO.
 *  - "salario_base" por quincena se prorratea como salario_base_mensual / 2.
 *    CONFIRMADO.
 * Ambas viven aquí y se cambian sin tocar el resto.
 */
import type { DesgloseTramos } from './clasificador.ts';

/** Suma el valor de recargos (todo menos la parte ordinaria) de un turno. */
export function valorExtrasDe(valorTramos: DesgloseTramos): number {
  return valorTramos.extra_diurna + valorTramos.extra_nocturna + valorTramos.dominical;
}

/** Salario base prorrateado a una quincena (mensual / 2). */
export function salarioBaseQuincena(salarioBaseMensual: number): number {
  return Math.round(salarioBaseMensual / 2);
}

export interface ComponentesNeto {
  salarioBaseQuincena: number;
  valorExtras: number;
  valorActividades: number;
  bonos: number;
  prestamos: number;
}

/**
 * neto = salario_base_quincena + extras + actividades + bonos − préstamos.
 * "Preliminar" mientras la quincena esté abierta (sección 11); el valor
 * definitivo se congela en el cierre (sección 12), fase posterior.
 */
export function calcularNetoPreliminar(c: ComponentesNeto): number {
  return (
    c.salarioBaseQuincena + c.valorExtras + c.valorActividades + c.bonos - c.prestamos
  );
}

/**
 * ¿La fecha es día de corte de quincena? Día 15 o último día del mes (sección 12).
 * `fecha` viene en convención Bogotá (campos UTC = hora de pared).
 */
export function esFechaDeCorte(fecha: Date): boolean {
  const dia = fecha.getUTCDate();
  const ultimoDia = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth() + 1, 0)).getUTCDate();
  return dia === 15 || dia === ultimoDia;
}

/**
 * ¿La fecha es la VÍSPERA de un día de corte? (para el envío automático de
 * respaldo el día antes del cierre, sección 12.1). Se evalúa preguntando si
 * MAÑANA es corte — así funciona en meses de 30/31/28-29 días sin casos
 * especiales. Colombia no tiene horario de verano: +24h == +1 día exacto.
 */
export function esVisperaDeCorte(fecha: Date): boolean {
  const manana = new Date(fecha.getTime() + 24 * 60 * 60 * 1000);
  return esFechaDeCorte(manana);
}

const MESES_QUINCENA = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

/** Etiqueta legible de la quincena a la que pertenece la fecha. Ej. "Q2-Julio 2026". */
export function etiquetaPeriodoQuincena(fecha: Date): string {
  const q = fecha.getUTCDate() <= 15 ? 'Q1' : 'Q2';
  return `${q}-${MESES_QUINCENA[fecha.getUTCMonth()]} ${fecha.getUTCFullYear()}`;
}

/**
 * Fechas de INICIO (día 1 o 16) de `cantidad` quincenas consecutivas, empezando
 * por la quincena a la que pertenece `desde`. Se usa para dividir un préstamo/bono
 * en cuotas (cuota 1 = quincena actual, cuota 2 = la siguiente, ...). Usa
 * aritmética de fechas, así el salto de mes y de año (diciembre→enero) es correcto.
 */
export function iniciosProximasQuincenas(desde: Date, cantidad: number): Date[] {
  const result: Date[] = [];
  let anio = desde.getUTCFullYear();
  let mes = desde.getUTCMonth(); // 0-indexed
  let enQ1 = desde.getUTCDate() <= 15;
  for (let i = 0; i < cantidad; i++) {
    result.push(new Date(Date.UTC(anio, mes, enQ1 ? 1 : 16)));
    if (enQ1) {
      enQ1 = false; // misma mes, pasa a Q2
    } else {
      enQ1 = true;
      mes += 1;
      if (mes > 11) {
        mes = 0;
        anio += 1;
      }
    }
  }
  return result;
}

/**
 * Divide un monto entero en `cuotas` partes que SUMAN exactamente el monto. Si no
 * es divisible, el sobrante (en pesos) va a las primeras cuotas. Ej. 250 en 3 ->
 * [84, 83, 83].
 */
export function dividirEnCuotas(monto: number, cuotas: number): number[] {
  const base = Math.floor(monto / cuotas);
  const resto = monto - base * cuotas;
  return Array.from({ length: cuotas }, (_, i) => base + (i < resto ? 1 : 0));
}
