// Defensa contra inyección de prompt DESDE LOS DATOS y redacción de PII.
// Los valores de texto que vienen de la base (nombres de clientes/productos, notas) son
// DATOS, nunca instrucciones: antes de llegar al modelo se les quitan saltos de línea y
// caracteres de control, se acotan en longitud y se redactan teléfonos/correos/tarjetas.
// Esto reduce la superficie; la contención REAL es estructural (catálogo cerrado, solo
// lectura, alcance fijado por el servidor, y números de la respuesta verificados contra
// los resultados) — ver docs/DATA-CHAT.md.

const PHONE_RE = /(?<![\d.])(?:\+?\d[\s().-]?){9,15}(?!\d)/g;
// Cuantificadores acotados (RFC 5321: local <= 64, dominio <= 255): sin acotar, una cadena larga de '%' o '.' sin '@' costaba
// tiempo polinomial (CodeQL js/polynomial-redos) en datos no confiables que ahora tambien entran por el reporte PDF.
const EMAIL_RE = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/gi;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

export const MAX_CELL_CHARS = 60;

// Controles C0/C1, separadores de línea/párrafo, marcas bidireccionales y de ancho cero.
// Construido con `new RegExp` + escapes de cadena para que el archivo no lleve caracteres invisibles.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "g");

export function redactPii(text: string): string {
  return text.replace(EMAIL_RE, "[correo]").replace(CARD_RE, "[tarjeta]").replace(PHONE_RE, "[teléfono]").replace(URL_RE, "[enlace]");
}

/** Texto de una celda de datos listo para mostrarse o enviarse al modelo. */
export function sanitizeCell(value: string, maxChars: number = MAX_CELL_CHARS): string {
  const flat = value
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/[`<>{}\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactPii(flat);
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars - 1)}…` : redacted;
}

export type Cell = string | number | null;

export function sanitizeRowForModel(row: Readonly<Record<string, Cell>>): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === "string" ? sanitizeCell(v) : v;
  return out;
}

/** Quita enlaces y caracteres de marcado que un texto narrado por el modelo no debe llevar. */
export function containsLink(text: string): boolean {
  URL_RE.lastIndex = 0;
  return URL_RE.test(text) || /\]\(/.test(text);
}
