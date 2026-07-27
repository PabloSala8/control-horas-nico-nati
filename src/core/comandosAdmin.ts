/**
 * Interpretación de comandos del grupo de admins en lenguaje natural
 * (secciones 9, 10 y 11): préstamos, bonos y consulta en vivo.
 *
 * Función PURA, detrás de una sola entrada `interpretarComandoAdmin()` — mismo
 * patrón que `interpretarCorreccion`: swappable por un LLM más adelante sin tocar
 * el resto del bot. `parseMonto` se exporta aparte porque también es útil/testeable
 * por sí sola.
 */

import { esGuia } from './screening.ts';

export type CampoRate =
  | 'salario_base'
  | 'divisor_horas'
  | 'rec_extra_diurna'
  | 'rec_extra_nocturna'
  | 'rec_dominical'
  | 'inicio_nocturno';

export interface CambioRate {
  campo: CampoRate;
  etiqueta: string; // nombre legible del campo (para la vista previa)
  /** número para todos los campos numéricos; "HH:MM" para inicio_nocturno. */
  valor: number | string;
}

export type ComandoAdmin =
  | { tipo: 'prestamo'; monto: number; alias: string; nota?: string }
  | { tipo: 'bono'; monto: number; alias: string; nota?: string }
  | { tipo: 'consulta' }
  | { tipo: 'cerrar' }
  | { tipo: 'reporte'; formato: 'excel' | 'pdf' | 'ambos' }
  | { tipo: 'rates-ver' }
  | { tipo: 'rates-cambiar'; cambio: CambioRate }
  | { tipo: 'corregir-turno'; alias: string | null; fecha: string | null }
  | { tipo: 'reset-db' }
  | { tipo: 'guia' }
  | { tipo: 'incompleto'; intento: 'prestamo' | 'bono'; faltaMonto: boolean; faltaEmpleada: boolean }
  | { tipo: 'desconocido' };

function norm(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * Extrae un monto en pesos de texto libre. Reglas (con red de seguridad en la
 * confirmación del bot, sección 9.2):
 *  - "1 millon" / "1.5 millones" -> ×1.000.000
 *  - "200 mil" / "200k"          -> ×1.000
 *  - "200.000" / "1.500.000"     -> literal (los separadores son de miles)
 *  - "200" (número pelado < 10.000, sin separador) -> ×1.000  (el ejemplo del
 *    doc "le presté 200 a Nena" significa $200.000, no $200)
 * Devuelve pesos como entero, o null si no hay número.
 */
export function parseMonto(texto: string): number | null {
  const t = norm(texto);

  const parseLeading = (s: string): number => {
    // separador como DECIMAL solo si es "N,NN" o "N.NN" corto (ej. "1.5 millones")
    if (/^\d{1,3}[.,]\d{1,2}$/.test(s)) return parseFloat(s.replace(',', '.'));
    return parseInt(s.replace(/[.,]/g, ''), 10);
  };

  let m: RegExpMatchArray | null;
  if ((m = t.match(/(\d[\d.,]*)\s*mill?on(?:es)?/))) return Math.round(parseLeading(m[1]) * 1_000_000);
  if ((m = t.match(/(\d[\d.,]*)\s*mil\b/))) return Math.round(parseLeading(m[1]) * 1_000);
  if ((m = t.match(/(\d[\d.,]*)\s*k\b/))) return Math.round(parseLeading(m[1]) * 1_000);
  if ((m = t.match(/(\d[\d.,]*)/))) {
    const raw = m[1].replace(/[.,]+$/, ''); // quita separador colgante
    const tieneSep = /[.,]/.test(raw);
    const n = parseInt(raw.replace(/[.,]/g, ''), 10);
    if (!Number.isFinite(n)) return null;
    if (!tieneSep && n < 10_000) return n * 1_000; // "200" -> 200.000
    return n;
  }
  return null;
}

/** Extrae una nota/motivo tras "por ..." (ej. "bono de 50 a Maye por navidad"). */
function extraerNota(t: string): string | undefined {
  const m = t.match(/\bpor\s+(.{2,60})$/);
  // "por" seguido de un número es parte del monto ("bono por 50"), no una nota.
  if (m && /^\d/.test(m[1].trim())) return undefined;
  return m ? m[1].trim() : undefined;
}

const MESES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * Parsea una fecha en español libre a `YYYY-MM-DD` (sección 18). Reconoce:
 *  - "20 de julio [de 2026]"
 *  - "20/07[/2026]"  o  "20-07[-2026]"
 *  - "2026-07-20" (ISO)
 * Devuelve null si no reconoce ninguna. `añoDefault` es el año en curso.
 */
export function parseFechaEspanol(texto: string, añoDefault: number): string | null {
  const t = norm(texto);
  const pad = (n: number) => String(n).padStart(2, '0');

  // ISO directo.
  const iso = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${pad(+iso[2])}-${pad(+iso[3])}`;

  // "20 de julio [de 2026]"
  const enLetras = t.match(/\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+(?:de\s+|del\s+)?(\d{4}))?/);
  if (enLetras) {
    const dia = parseInt(enLetras[1], 10);
    const mesIdx = MESES_ES.findIndex((m) => enLetras[2].startsWith(m.slice(0, 4)) || m.startsWith(enLetras[2]));
    const setiembre = enLetras[2].startsWith('setiembre') ? 8 : -1;
    const mes = mesIdx >= 0 ? mesIdx : setiembre;
    const año = enLetras[3] ? parseInt(enLetras[3], 10) : añoDefault;
    if (mes >= 0 && dia >= 1 && dia <= 31) return `${año}-${pad(mes + 1)}-${pad(dia)}`;
  }

  // "20/07[/2026]" o "20-07[-2026]"
  const numerica = t.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (numerica) {
    const dia = parseInt(numerica[1], 10);
    const mes = parseInt(numerica[2], 10);
    let año = numerica[3] ? parseInt(numerica[3], 10) : añoDefault;
    if (año < 100) año += 2000;
    if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) return `${año}-${pad(mes)}-${pad(dia)}`;
  }

  return null;
}

/** Parsea un recargo como fracción. "0.25"->0.25, "25%"->0.25, "25"->0.25, "100%"->1.0. */
function parseFraccion(t: string): number | null {
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(%|por\s*ciento)?/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  if (m[2]) return n / 100; // explícito "%"/"por ciento"
  if (n > 3) return n / 100; // un recargo > 3 es sin duda un porcentaje escrito sin "%"
  return n; // 0.25, 0.75, 1.0 ...
}

/** Parsea una hora de inicio nocturno a "HH:MM". Acepta "19:00", "21:00", "7pm". */
function parseHoraRate(t: string): string | null {
  const hhmm = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (hhmm) {
    const h = parseInt(hhmm[1], 10);
    const m = parseInt(hhmm[2], 10);
    if (h <= 23 && m <= 59) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const ampm = t.match(/\b(\d{1,2})\s*(a\.?\s?m|p\.?\s?m)\b/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const pm = ampm[2].startsWith('p');
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    if (h <= 23) return `${String(h).padStart(2, '0')}:00`;
  }
  return null;
}

// Campos de rate reconocibles. El ORDEN importa: "inicio nocturno" se prueba
// antes que "recargo nocturno" porque ambos contienen "nocturn".
const CAMPOS_RATE: Array<{
  campo: CampoRate;
  etiqueta: string;
  test: RegExp;
  tipoValor: 'monto' | 'entero' | 'fraccion' | 'hora';
}> = [
  { campo: 'inicio_nocturno', etiqueta: 'inicio del recargo nocturno', tipoValor: 'hora',
    test: /\binicio\s+(?:del\s+)?noct|hora\s+(?:de\s+inicio\s+)?noct|empieza\s+(?:el\s+)?noct|arranca\s+(?:el\s+)?noct/ },
  { campo: 'divisor_horas', etiqueta: 'divisor de horas', tipoValor: 'entero', test: /\bdivisor\b/ },
  { campo: 'salario_base', etiqueta: 'salario base', tipoValor: 'monto',
    test: /\bsalario\b|\bsueldo\b|\bsmmlv\b|\bminimo\b|\bbase\b/ },
  { campo: 'rec_extra_diurna', etiqueta: 'recargo extra diurna', tipoValor: 'fraccion', test: /diurn/ },
  { campo: 'rec_extra_nocturna', etiqueta: 'recargo extra nocturna', tipoValor: 'fraccion', test: /nocturn/ },
  { campo: 'rec_dominical', etiqueta: 'recargo dominical/festivo', tipoValor: 'fraccion', test: /dominical|festiv/ },
];

/**
 * Interpreta un cambio de rate (sección 17): a qué campo y con qué valor.
 * Devuelve null si no reconoce el campo o no logra parsear el valor — en ese
 * caso el bot pide que se escriba mejor. NUNCA edita en sitio: el bot inserta
 * una fila nueva de `config_rates` al confirmar (convención CLAUDE.md).
 */
export function interpretarCambioRate(texto: string): CambioRate | null {
  const t = norm(texto);
  const def = CAMPOS_RATE.find((c) => c.test.test(t));
  if (!def) return null;

  let valor: number | string | null = null;
  if (def.tipoValor === 'monto') valor = parseMonto(t);
  else if (def.tipoValor === 'entero') {
    const m = t.match(/(\d[\d.,]*)/);
    valor = m ? parseInt(m[1].replace(/[.,]/g, ''), 10) : null;
  } else if (def.tipoValor === 'fraccion') valor = parseFraccion(t);
  else if (def.tipoValor === 'hora') valor = parseHoraRate(t);

  if (valor === null || (typeof valor === 'number' && !Number.isFinite(valor))) return null;
  return { campo: def.campo, etiqueta: def.etiqueta, valor };
}

/**
 * @param aliases lista de alias/nombres reconocibles de empleadas (ej. ["Nena","Maye"]).
 */
export function interpretarComandoAdmin(
  texto: string,
  aliases: string[],
  añoActual: number = new Date().getFullYear(),
): ComandoAdmin {
  const t = norm(texto);
  const alias = aliases.find((a) => new RegExp(`\\b${norm(a)}\\b`).test(t)) ?? null;

  // Guía / instrucciones de uso.
  if (esGuia(texto)) return { tipo: 'guia' };

  // Borrar base de datos (solo desarrollo): reinicia los datos operativos a cero.
  if (
    (/\bborrar\b/.test(t) && /\b(base|datos|todo)\b/.test(t)) ||
    /\bresetear\b|\breset\b/.test(t) ||
    /\bempezar\s+(?:de\s+|en\s+)?cero\b/.test(t) ||
    (/\blimpiar\b/.test(t) && /\b(base|datos|todo)\b/.test(t))
  ) {
    return { tipo: 'reset-db' };
  }

  // Corregir un turno pasado (sección 18): "corregir turno de Nena del 20 de julio".
  if (/\bcorregir\b|\bcorrige\b|\bcorreccion\b/.test(t) && /\bturno\b/.test(t)) {
    return { tipo: 'corregir-turno', alias, fecha: parseFechaEspanol(t, añoActual) };
  }

  // Rates (sección 17): cambiar primero (verbo + campo + valor), luego consultar.
  const verboCambio = /\bcambiar\b|\bcambia\b|\bactualiza|\bpon(?:er|le)?\b|\bsube|\bbaja|\bajusta|\bmodifica|\bset\b/.test(t);
  if (verboCambio) {
    const cambio = interpretarCambioRate(t);
    if (cambio) return { tipo: 'rates-cambiar', cambio };
  }
  if (/\brates?\b|\btarifas?\b|\brecargos?\b|\bconfiguracion\b/.test(t)) {
    return { tipo: 'rates-ver' };
  }

  const esPrestamo = /\bprest/.test(t) || /\badelanto/.test(t);
  const esBono = /\bbono/.test(t) || /\bbonific/.test(t);

  if (esPrestamo || esBono) {
    // Si menciona ambos (raro), gana el que aparezca como préstamo salvo que solo
    // haya "bono".
    const intento: 'prestamo' | 'bono' = esBono && !esPrestamo ? 'bono' : 'prestamo';
    const monto = parseMonto(t);
    if (monto !== null && alias) {
      const nota = extraerNota(t);
      return nota ? { tipo: intento, monto, alias, nota } : { tipo: intento, monto, alias };
    }
    return { tipo: 'incompleto', intento, faltaMonto: monto === null, faltaEmpleada: !alias };
  }

  // Cierre de quincena (sección 12).
  if (/\bcierre\b/.test(t) || (/\bcerrar\b/.test(t) && /\bquincena\b/.test(t))) {
    return { tipo: 'cerrar' };
  }

  // Reporte bajo demanda (sección 13): Excel y/o PDF.
  const pideExcel = /\bexcel\b/.test(t);
  const pidePdf = /\bpdf\b/.test(t);
  if (pideExcel || pidePdf || /\breporte\b|\binforme\b/.test(t)) {
    const formato = pideExcel && pidePdf ? 'ambos' : pideExcel ? 'excel' : pidePdf ? 'pdf' : 'ambos';
    return { tipo: 'reporte', formato };
  }

  if (/\bcomo\s+va\b|\bcomo\s+vamos\b|\bresumen\b|estado\s+de\s+la\s+quincena|\bcuanto\s+(va|llevo|llevamos|debo|debemos)\b/.test(t)) {
    return { tipo: 'consulta' };
  }

  return { tipo: 'desconocido' };
}
