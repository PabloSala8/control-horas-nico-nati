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
    jornadaOrdinariaDiaria: number; // horas ordinarias/día usadas como umbral
    esDominicalOFestivo: boolean;
    valorPorTramo: DesgloseTramos; // pesos aportados por cada bucket
  };
}

const redondear2 = (h: number) => Math.round(h * 100) / 100;

/**
 * La jornada ordinaria diaria (umbral a partir del cual las horas de un turno
 * cuentan como extra) se deriva del divisor mensual: divisor / 30.
 * Con divisor 210 -> 7 h/día, consistente con 42 h/semana ÷ 6 días.
 *
 * DECISIÓN DE IMPLEMENTACIÓN (anotada en la bitácora): el documento técnico
 * fija el divisor mensual (210) pero no el umbral diario. Se deriva aquí de
 * forma transparente y editable vía `divisor_horas`, coherente con la
 * filosofía del documento (los rates mandan, no el código). Pendiente de
 * confirmación por Pablo.
 */
export function jornadaOrdinariaDiaria(rates: RatesConfig): number {
  return rates.divisorHoras / 30;
}

/** Valor de la hora ordinaria: siempre derivado, nunca guardado fijo. */
export function valorHoraOrdinaria(rates: RatesConfig): number {
  return rates.salarioBase / rates.divisorHoras;
}

/**
 * Clasifica un turno (entrada + salida confirmadas) en tramos y calcula su
 * valor en pesos.
 *
 * @param esDominicalOFestivo lo determina el llamador (getUTCDay()==0 o la
 *   fecha está en la tabla `festivos`). Se pasa por parámetro para mantener el
 *   motor puro y sin dependencia de la DB.
 */
export function clasificarTurno(params: {
  entrada: Date;
  salida: Date;
  rates: RatesConfig;
  esDominicalOFestivo: boolean;
}): ResultadoClasificacion {
  const { entrada, salida, rates, esDominicalOFestivo } = params;

  const totalMin = Math.round((salida.getTime() - entrada.getTime()) / 60_000);
  if (totalMin <= 0) {
    throw new Error('La salida debe ser posterior a la entrada.');
  }

  const vHora = valorHoraOrdinaria(rates);
  const jornadaDiaria = jornadaOrdinariaDiaria(rates);

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
        jornadaOrdinariaDiaria: jornadaDiaria,
        esDominicalOFestivo: true,
        valorPorTramo: { ordinaria: 0, extra_diurna: 0, extra_nocturna: 0, dominical: Math.round(valorTramo) },
      },
    };
  }

  // Día ordinario: recorremos minuto a minuto. Los primeros `jornadaDiaria`
  // horas del turno son ordinarias; lo que exceda es extra, clasificado como
  // diurno/nocturno según la hora de reloj de ese minuto (corte en
  // `inicio_nocturno`). El recargo nocturno del modelo aplica solo a la hora
  // EXTRA nocturna (config no tiene recargo nocturno sobre la ordinaria).
  const inicioNocturnoMin = horaAminutos(rates.inicioNocturno);
  const umbralOrdinarioMin = jornadaDiaria * 60;
  const inicioMinDia = minutoDelDia(entrada);

  let minOrdinaria = 0;
  let minExtraDiurna = 0;
  let minExtraNocturna = 0;

  for (let i = 0; i < totalMin; i++) {
    const clockMin = (inicioMinDia + i) % 1440;
    const esNocturno = clockMin >= inicioNocturnoMin;
    if (i < umbralOrdinarioMin) {
      minOrdinaria++;
    } else if (esNocturno) {
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
      jornadaOrdinariaDiaria: jornadaDiaria,
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
}): SegmentoTramo[] {
  const { entrada, salida, rates, esDominicalOFestivo } = params;
  const totalMin = Math.round((salida.getTime() - entrada.getTime()) / 60_000);
  if (totalMin <= 0) return [];

  const at = (min: number) => new Date(entrada.getTime() + min * 60_000);

  // Día dominical/festivo: todo el turno es un único tramo.
  if (esDominicalOFestivo) {
    return [{ tramo: 'dominical', desde: at(0), hasta: at(totalMin) }];
  }

  const inicioNocturnoMin = horaAminutos(rates.inicioNocturno);
  const umbralOrdinarioMin = jornadaOrdinariaDiaria(rates) * 60;
  const inicioMinDia = minutoDelDia(entrada);

  const bucketDe = (i: number): NombreTramo => {
    if (i < umbralOrdinarioMin) return 'ordinaria';
    const clockMin = (inicioMinDia + i) % 1440;
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
