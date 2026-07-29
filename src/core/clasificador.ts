/**
 * Motor de clasificación de horas (sección 5 del documento técnico).
 *
 * Funciones PURAS: no importan Telegram ni la base de datos. Reciben todo lo
 * que necesitan por parámetro (el turno y los rates vigentes) y devuelven el
 * desglose de tramos + el valor calculado. Se pueden probar con datos de
 * ejemplo sin levantar el bot ni Postgres.
 *
 * Convención de tiempo: las fechas de entrada/salida vienen en la convención
 * de `tiempo.ts` (campos UTC == hora de pared de Bogotá). Ver ese archivo.
 */

import { minutoDelDia, horaAminutos } from './tiempo.ts';
import type { VentanaOrdinaria } from './horarios.ts';

/** Configuración de rates vigente (una fila de `config_rates`). */
export interface RatesConfig {
  salarioBase: number; // pesos/mes
  divisorHoras: number; // ej. 210 (jornada 42h)
  recExtraDiurna: number; // fracción, ej. 0.25
  recExtraNocturna: number; // fracción, ej. 0.75
  recDominical: number; // fracción, ej. 0.75
  inicioNocturno: string; // "HH:MM", ej. "19:00"
}

/** Desglose de horas por tipo de tramo. Se guarda en `turnos.desglose_tramos`. */
export interface DesgloseTramos {
  ordinaria: number;
  extra_diurna: number;
  extra_nocturna: number;
  dominical: number;
}

export interface ResultadoClasificacion {
  horasTotales: number;
  desglose: DesgloseTramos;
  valorCalculado: number; // pesos, redondeado
  detalle: {
    valorHoraOrdinaria: number;
    esDominicalOFestivo: boolean;
    valorPorTramo: DesgloseTramos; // pesos aportados por cada bucket
  };
}

const redondear2 = (h: number) => Math.round(h * 100) / 100;

/** Valor de la hora ordinaria: siempre derivado, nunca guardado fijo. */
export function valorHoraOrdinaria(rates: RatesConfig): number {
  return rates.salarioBase / rates.divisorHoras;
}

/**
 * Clasifica un turno (entrada + salida confirmadas) en tramos y calcula su
 * valor en pesos.
 *
 * Regla de ordinaria/extra (sección 5): son ordinarias las horas trabajadas
 * DENTRO de la ventana de reloj de esa empleada ese día (`ventanaOrdinaria`);
 * lo trabajado fuera de la ventana —o en un día sin ventana (`null`)— es extra
 * (diurna/nocturna según el corte de `inicioNocturno`).
 *
 * @param esDominicalOFestivo lo determina el llamador (getUTCDay()==0 o la
 *   fecha está en la tabla `festivos`). Si es true, TODO el turno es dominical
 *   (manda sobre la ventana). Se pasa por parámetro para mantener el motor puro.
 * @param ventanaOrdinaria la ventana ordinaria de la empleada para la fecha del
 *   turno, o `null` si ese día no tiene jornada ordinaria (todo extra).
 */
export function clasificarTurno(params: {
  entrada: Date;
  salida: Date;
  rates: RatesConfig;
  esDominicalOFestivo: boolean;
  ventanaOrdinaria: VentanaOrdinaria | null;
}): ResultadoClasificacion {
  const { entrada, salida, rates, esDominicalOFestivo, ventanaOrdinaria } = params;

  const totalMin = Math.round((salida.getTime() - entrada.getTime()) / 60_000);
  if (totalMin <= 0) {
    throw new Error('La salida debe ser posterior a la entrada.');
  }

  const vHora = valorHoraOrdinaria(rates);

  const desglose: DesgloseTramos = {
    ordinaria: 0,
    extra_diurna: 0,
    extra_nocturna: 0,
    dominical: 0,
  };

  // Caso dominical/festivo: todo el turno va al recargo dominical, no se parte
  // en ordinaria/extra (sección 5, paso 2).
  if (esDominicalOFestivo) {
    const horas = redondear2(totalMin / 60);
    desglose.dominical = horas;
    const valorTramo = horas * vHora * (1 + rates.recDominical);
    return {
      horasTotales: horas,
      desglose,
      valorCalculado: Math.round(valorTramo),
      detalle: {
        valorHoraOrdinaria: vHora,
        esDominicalOFestivo: true,
        valorPorTramo: { ordinaria: 0, extra_diurna: 0, extra_nocturna: 0, dominical: Math.round(valorTramo) },
      },
    };
  }

  // Día ordinario: recorremos minuto a minuto. Un minuto es ordinario si su hora
  // de reloj cae DENTRO de la ventana [desde, hasta) de la empleada ese día; si
  // no (o no hay ventana), es extra, clasificado como diurno/nocturno según el
  // corte de `inicio_nocturno`. El recargo nocturno aplica solo a la hora EXTRA
  // nocturna (la ordinaria nunca lleva recargo nocturno en este modelo).
  const inicioNocturnoMin = horaAminutos(rates.inicioNocturno);
  const inicioMinDia = minutoDelDia(entrada);
  const ventDesdeMin = ventanaOrdinaria ? horaAminutos(ventanaOrdinaria.desde) : -1;
  const ventHastaMin = ventanaOrdinaria ? horaAminutos(ventanaOrdinaria.hasta) : -1;

  let minOrdinaria = 0;
  let minExtraDiurna = 0;
  let minExtraNocturna = 0;

  for (let i = 0; i < totalMin; i++) {
    const clockMin = (inicioMinDia + i) % 1440;
    const dentroVentana = ventanaOrdinaria !== null && clockMin >= ventDesdeMin && clockMin < ventHastaMin;
    if (dentroVentana) {
      minOrdinaria++;
    } else if (clockMin >= inicioNocturnoMin) {
      minExtraNocturna++;
    } else {
      minExtraDiurna++;
    }
  }

  desglose.ordinaria = redondear2(minOrdinaria / 60);
  desglose.extra_diurna = redondear2(minExtraDiurna / 60);
  desglose.extra_nocturna = redondear2(minExtraNocturna / 60);

  const valOrdinaria = (minOrdinaria / 60) * vHora;
  const valExtraDiurna = (minExtraDiurna / 60) * vHora * (1 + rates.recExtraDiurna);
  const valExtraNocturna = (minExtraNocturna / 60) * vHora * (1 + rates.recExtraNocturna);
  const valorCalculado = Math.round(valOrdinaria + valExtraDiurna + valExtraNocturna);

  return {
    horasTotales: redondear2(totalMin / 60),
    desglose,
    valorCalculado,
    detalle: {
      valorHoraOrdinaria: vHora,
      esDominicalOFestivo: false,
      valorPorTramo: {
        ordinaria: Math.round(valOrdinaria),
        extra_diurna: Math.round(valExtraDiurna),
        extra_nocturna: Math.round(valExtraNocturna),
        dominical: 0,
      },
    },
  };
}

export type NombreTramo = keyof DesgloseTramos;

export interface SegmentoTramo {
  tramo: NombreTramo;
  desde: Date;
  hasta: Date;
}

/**
 * Devuelve los tramos de un turno como RANGOS de reloj contiguos (sección 13):
 * de qué hora a qué hora corresponde cada tipo de hora (ordinaria, extra diurna,
 * extra nocturna, dominical/festivo). Recorre minuto a minuto con exactamente la
 * misma lógica que `clasificarTurno` y agrupa minutos consecutivos del mismo
 * bucket — así los rangos SIEMPRE cuadran con el desglose, sin guardar nada
 * duplicado en la base de datos (se recalcula al generar el reporte).
 */
export function segmentosDeTurno(params: {
  entrada: Date;
  salida: Date;
  rates: RatesConfig;
  esDominicalOFestivo: boolean;
  ventanaOrdinaria: VentanaOrdinaria | null;
}): SegmentoTramo[] {
  const { entrada, salida, rates, esDominicalOFestivo, ventanaOrdinaria } = params;
  const totalMin = Math.round((salida.getTime() - entrada.getTime()) / 60_000);
  if (totalMin <= 0) return [];

  const at = (min: number) => new Date(entrada.getTime() + min * 60_000);

  // Día dominical/festivo: todo el turno es un único tramo.
  if (esDominicalOFestivo) {
    return [{ tramo: 'dominical', desde: at(0), hasta: at(totalMin) }];
  }

  const inicioNocturnoMin = horaAminutos(rates.inicioNocturno);
  const inicioMinDia = minutoDelDia(entrada);
  const ventDesdeMin = ventanaOrdinaria ? horaAminutos(ventanaOrdinaria.desde) : -1;
  const ventHastaMin = ventanaOrdinaria ? horaAminutos(ventanaOrdinaria.hasta) : -1;

  const bucketDe = (i: number): NombreTramo => {
    const clockMin = (inicioMinDia + i) % 1440;
    if (ventanaOrdinaria !== null && clockMin >= ventDesdeMin && clockMin < ventHastaMin) return 'ordinaria';
    return clockMin >= inicioNocturnoMin ? 'extra_nocturna' : 'extra_diurna';
  };

  const segmentos: SegmentoTramo[] = [];
  let inicioSeg = 0;
  let bucketActual = bucketDe(0);
  for (let i = 1; i < totalMin; i++) {
    const b = bucketDe(i);
    if (b !== bucketActual) {
      segmentos.push({ tramo: bucketActual, desde: at(inicioSeg), hasta: at(i) });
      inicioSeg = i;
      bucketActual = b;
    }
  }
  segmentos.push({ tramo: bucketActual, desde: at(inicioSeg), hasta: at(totalMin) });
  return segmentos;
}
