/**
 * Interpretación de correcciones en lenguaje natural — Nivel 1 (sección 7).
 *
 * Función PURA. Intenta extraer UNA hora (o un RANGO completo) de un mensaje de
 * texto libre con patrones simples (sin LLM). Toda la implementación vive detrás
 * de esta única función `interpretarCorreccion()`: el resto del bot NO sabe cómo
 * funciona por dentro. Esto es deliberado — si mañana se reemplaza por una
 * llamada a un LLM (Gemini, Kimi, u otro) para subir el % de aciertos, solo se
 * toca este archivo y el flujo de aprobación queda intacto (nota de
 * arquitectura, sección 7).
 *
 * Contrato:
 *  - `ok: true` + `hora`/`minuto`  -> se extrajo UNA hora (un punto).
 *  - `ok: true` + `rango`          -> se extrajo un rango completo entrada→salida
 *                                     (ej. "de 7:00 am a 4:00 pm"), para el flujo
 *                                     de "No, cambiar" (sección 7.3).
 *  - `ok: false`                   -> no se pudo interpretar. El bot NO adivina.
 */

import { normalizar, detectarTipoMarcacion } from './screening.ts';

export interface HoraPunto {
  hora: number; // 0..23
  minuto: number; // 0..59
}

export interface Interpretacion {
  ok: boolean;
  /** Hora del día 0..23 (solo si ok y es un punto, no un rango). */
  hora?: number;
  /** Minuto 0..59 (solo si ok y es un punto). */
  minuto?: number;
  /** Rango completo entrada→salida, si el texto tenía dos horas (sección 7.3). */
  rango?: { entrada: HoraPunto; salida: HoraPunto };
  /** Pista de tipo según palabras clave, si el mensaje lo sugiere. */
  tipo?: 'entrada' | 'salida';
  /** true si AM/PM se dedujo por heurística (no venía explícito en el texto). */
  meridiemInferido?: boolean;
  /** El texto tal cual lo escribió la empleada (para el fallback a admins). */
  textoOriginal: string;
}

/**
 * Resuelve AM/PM. Si viene explícito ("am"/"pm"/"de la mañana"/"de la tarde")
 * lo respeta; si no, usa una heurística. `sesgo` permite empujar la inferencia
 * hacia AM o PM (se usa en rangos: la entrada tiende a AM, la salida a PM).
 */
function resolverMeridiem(
  t: string,
  hora: number,
  meridiemToken?: string,
  sesgo?: 'am' | 'pm',
): { hora: number; inferido: boolean } {
  const esPM = meridiemToken?.startsWith('p');
  const esAM = meridiemToken?.startsWith('a');
  const tarde = /de la (tarde|noche)/.test(t);
  const manana = /de la manana/.test(t);

  if (esPM || tarde) return { hora: hora === 12 ? 12 : hora + 12, inferido: false };
  if (esAM || manana) return { hora: hora === 12 ? 0 : hora, inferido: false };

  // Sin meridiem explícito.
  if (hora === 12) return { hora: 12, inferido: true }; // mediodía
  if (sesgo === 'am') return { hora: hora === 12 ? 0 : hora, inferido: true };
  if (sesgo === 'pm') return { hora: hora <= 11 ? hora + 12 : hora, inferido: true };
  // Heurística de horario doméstico: 1..6 -> tarde; 7..11 -> mañana; 0 -> medianoche.
  if (hora >= 1 && hora <= 6) return { hora: hora + 12, inferido: true };
  return { hora, inferido: true };
}

/**
 * Extrae UNA hora de un fragmento de texto ya normalizado con los patrones
 * simples del Nivel 1. Devuelve null si no reconoce ninguna. `sesgo` se pasa a
 * la resolución de meridiem (útil para rangos).
 */
function extraerHora(
  t: string,
  sesgo?: 'am' | 'pm',
): { hora: number; minuto: number; inferido: boolean } | null {
  // 1) mediodía / medianoche.
  if (/\bmedio\s?dia\b/.test(t)) return { hora: 12, minuto: 0, inferido: false };
  if (/\bmedianoche\b/.test(t)) return { hora: 0, minuto: 0, inferido: false };

  // 2) HH:MM con am/pm opcional. ej. "3:30 pm", "15:45"
  const conMinutos = t.match(/(\d{1,2}):(\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)?/);
  if (conMinutos) {
    const h = parseInt(conMinutos[1], 10);
    const m = parseInt(conMinutos[2], 10);
    const mer = conMinutos[3]?.replace(/[.\s]/g, '');
    if (h <= 23 && m <= 59) {
      if (h >= 13) return { hora: h, minuto: m, inferido: false };
      const r = resolverMeridiem(t, h, mer, sesgo);
      return { hora: r.hora, minuto: m, inferido: r.inferido };
    }
  }

  // 3) "X am/pm" ej. "8am", "3 pm"
  const conMeridiem = t.match(/\b(\d{1,2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)\b/);
  if (conMeridiem) {
    const h = parseInt(conMeridiem[1], 10);
    const mer = conMeridiem[2].replace(/[.\s]/g, '');
    if (h >= 0 && h <= 12) {
      const r = resolverMeridiem(t, h, mer, sesgo);
      return { hora: r.hora, minuto: 0, inferido: r.inferido };
    }
  }

  // 4) "a la(s) X" ej. "a las 3", "a la 1"
  const aLas = t.match(/a\s+las?\s+(\d{1,2})(?::(\d{2}))?/);
  if (aLas) {
    const h = parseInt(aLas[1], 10);
    const m = aLas[2] ? parseInt(aLas[2], 10) : 0;
    if (h >= 0 && h <= 23 && m <= 59) {
      if (h >= 13) return { hora: h, minuto: m, inferido: false };
      const r = resolverMeridiem(t, h, undefined, sesgo);
      return { hora: r.hora, minuto: m, inferido: r.inferido };
    }
  }

  // 5) Número suelto, SOLO si no es claramente una duración ("5 horas") ni va
  //    pegado a otra unidad. Evita adivinar con falsos positivos.
  const suelto = t.match(/\b(\d{1,2})\b(?!\s*(?:horas?|hrs?|min|minutos?|h\b|:))/);
  if (suelto) {
    const h = parseInt(suelto[1], 10);
    if (h >= 0 && h <= 23) {
      if (h >= 13) return { hora: h, minuto: 0, inferido: false };
      const r = resolverMeridiem(t, h, undefined, sesgo);
      return { hora: r.hora, minuto: 0, inferido: r.inferido };
    }
  }

  return null;
}

/**
 * Intenta leer un RANGO completo "de X a Y" (sección 7.3). Separadores
 * aceptados: "a", "hasta", "al", o un guion. Solo se considera rango si AMBOS
 * lados se interpretan como una hora — así "salí a las 3" (donde el lado
 * izquierdo no es una hora) NO se confunde con un rango.
 */
function extraerRango(t: string): { entrada: HoraPunto; salida: HoraPunto } | null {
  const cuerpo = t.replace(/^\s*de(?:sde)?\s+/, '');
  const partes = cuerpo.split(/\s+(?:a|hasta|al)\s+|\s*[-–—]\s*/);
  if (partes.length !== 2) return null;
  const e = extraerHora(partes[0], 'am');
  const s = extraerHora(partes[1], 'pm');
  if (!e || !s) return null;
  return {
    entrada: { hora: e.hora, minuto: e.minuto },
    salida: { hora: s.hora, minuto: s.minuto },
  };
}

export function interpretarCorreccion(texto: string): Interpretacion {
  const original = texto;
  const t = normalizar(texto);
  const tipo = detectarTipoMarcacion(texto);
  const base = (extra: Partial<Interpretacion>): Interpretacion => ({
    ok: false,
    textoOriginal: original,
    tipo,
    ...extra,
  });

  // Rango completo primero (ej. "de 7:00 am a 4:00 pm").
  const rango = extraerRango(t);
  if (rango) return base({ ok: true, rango });

  // Un solo punto.
  const punto = extraerHora(t);
  if (punto) {
    return base({ ok: true, hora: punto.hora, minuto: punto.minuto, meridiemInferido: punto.inferido });
  }

  // No se pudo extraer una hora -> fallback a admins (sección 7, paso 3).
  return base({ ok: false });
}
