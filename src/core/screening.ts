/**
 * Screening de mensajes de texto libre — Nivel 0 (secciones 6.0 y 7.0).
 *
 * Funciones PURAS. Deciden, ANTES de intentar interpretar nada, qué hacer con
 * un mensaje de una empleada:
 *   - `esSaludo`            -> mostrar el menú de botones (además de /start, 6.0).
 *   - `tieneIndicioDeHora`  -> ¿vale la pena intentar interpretarlo como una
 *                             marcación? Si NO, el bot se queda callado y no crea
 *                             ningún registro (7.0: ignorar conversación normal).
 *   - `detectarTipoMarcacion` -> entrada / salida según palabras clave (7.1).
 *
 * Estas tres viven juntas porque comparten el mismo vocabulario de marcación y
 * se usan en secuencia en el handler de texto de la empleada.
 */

/** Normaliza: minúsculas, sin tildes, recortado. */
export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita marcas diacríticas combinadas (tildes)
    .trim();
}

// Saludos comunes con los que la empleada abre el menú (sección 6.0).
const SALUDO =
  /\b(hola+|holi|holis|ola|buenas|buenos?\s*d[ií]as|buenas?\s*tardes|buenas?\s*noches|buen\s*d[ií]a|hey|hello|menu|que\s*mas|q\s*mas|epa|ey)\b/;

// Pide la guía / instrucciones de uso.
const GUIA = /\b(guia|instrucciones|instructivo|comandos|ayuda|help|opciones)\b/;

// Palabras clave de marcación (sin distinguir entrada/salida todavía).
const PALABRAS_MARCACION =
  /\b(sali|salida|me\s*fui|termine|termino|acabe|acabo|entre|entrada|llegue|llego|llegada|empece|empezo|comence)\b/;

// Patrones que "parecen un reloj": HH:MM, "X am/pm", "a las X", mediodía/medianoche.
const PATRON_HORA =
  /(\d{1,2}:\d{2})|(\b\d{1,2}\s*(?:a\.?\s?m|p\.?\s?m)\b)|(\ba\s+las?\s+\d{1,2})|(\bmedio\s?dia\b)|(\bmedianoche\b)/;

/**
 * ¿El texto es (esencialmente) un saludo? Se usa para desplegar el menú.
 * El llamador decide combinarlo con `tieneIndicioDeHora` para que un
 * "hola, salí a las 3" NO se trate como saludo sino como marcación.
 */
export function esSaludo(texto: string): boolean {
  return SALUDO.test(normalizar(texto));
}

/** ¿Pide la guía de uso? ("guía", "instrucciones", "ayuda", "comandos"...). */
export function esGuia(texto: string): boolean {
  return GUIA.test(normalizar(texto));
}

/**
 * ¿El mensaje tiene ALGÚN indicio de que es un intento de marcación? (sección
 * 7.0). Un número tipo reloj o una palabra clave de marcación bastan. Si no hay
 * ninguno, el bot no responde ni crea nada — así no reacciona a charla normal.
 */
export function tieneIndicioDeHora(texto: string): boolean {
  const t = normalizar(texto);
  return PATRON_HORA.test(t) || PALABRAS_MARCACION.test(t);
}

/**
 * Detecta el tipo de marcación por palabras clave (sección 7.1).
 *  - "salí" / "salida" / "me fui" / "terminé"     -> salida
 *  - "entré" / "entrada" / "llegué" / "empecé"    -> entrada
 *  - sin ninguna pista                            -> undefined (escalar a admins)
 */
export function detectarTipoMarcacion(texto: string): 'entrada' | 'salida' | undefined {
  const t = normalizar(texto);
  if (/\b(sali|salida|me\s*fui|termine|termino|acabe|acabo)\b/.test(t)) return 'salida';
  if (/\b(entre|entrada|llegue|llego|llegada|empece|empezo|comence)\b/.test(t)) return 'entrada';
  return undefined;
}
