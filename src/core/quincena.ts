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
