// Fuente UNICA de patrones de datos sensibles del monorepo (PL-10). Antes vivian copiados en
// tres lugares: la redaccion de alertas salientes (apps/api/src/alertas/redaccion.ts) y la
// redaccion de pagos de los tres webhooks de WhatsApp (domain-citas/hoteles/restaurantes
// `redactSensitiveInfo`), y las copias de citas y hoteles ya habian divergido de la de
// restaurantes (la tarjeta se comia el separador final y "1/2 orden" se redactaba como un
// vencimiento). Todo consumidor importa de aqui; agregar o ajustar un patron es un cambio en
// UN archivo.
//
// Puro y sin I/O. Los patrones son deliberadamente CONSERVADORES hacia redactar de mas: un
// fragmento de menos en un log es un costo menor que una filtracion.
//
// Los objetos RegExp con bandera `g` son compartidos: usalos solo con `String.replace`/
// `matchAll` (que reinician lastIndex), nunca con `.test()`/`.exec()` directo.

export const MARCA_REDACTADO = "[redactado]";

/** Claves de objeto cuyo VALOR se redacta siempre, sin mirar su contenido. */
export const CLAVE_SENSIBLE = /pass(word|wd)?|secret|token|authorization|api[-_]?key|cookie|dsn|jwt|credential|clave|private|bearer|signature|firma/i;

/** UUID canonico: no es un secreto y es la llave de correlacion de logs (tenant, request). */
export const PATRON_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// ---- datos de pago (los usa tanto el scrub general como la redaccion de chat de WhatsApp) ----

/** Numero de tarjeta: 13-19 digitos con espacios o guiones, sin comerse el separador final
 *  (con `(?:\d[ -]?){13,19}` el siguiente "[cvv oculto]" quedaba pegado). */
export const PATRON_TARJETA = /\b\d(?:[ -]?\d){12,18}\b/g;
/** CVV/CVC con su etiqueta. */
export const PATRON_CVV = /\b(?:cvv|cvc|c\.?v\.?v\.?)\s*:?\s*\d{3,4}\b/gi;
/** MM/AA o MM/AAAA con mes 01-12: "1/2 orden" o "1/4 de kilo" son fracciones, no un vencimiento. */
export const PATRON_VENCIMIENTO = /\b(?:0?[1-9]|1[0-2])\/(?:\d{4}|\d{2})\b/g;

/**
 * Redaccion de datos de pago de un MENSAJE de cliente ANTES de persistirlo (WhatsApp de
 * citas/hoteles/restaurantes). Las etiquetas son parte del contrato: los tests de cada vertical
 * las afirman y el historial guardado las muestra al staff.
 */
export function redactarDatosDePago(texto: string): string {
  return texto
    .replace(PATRON_TARJETA, "[tarjeta oculta]")
    .replace(PATRON_CVV, "[cvv oculto]")
    .replace(PATRON_VENCIMIENTO, "[vencimiento oculto]");
}

// ---- identificadores personales de Mexico (hoteles: el huesped los escribe al hacer check-in por chat) ----
//
// Deliberadamente SEPARADOS de `redactarDatosDePago`: esa funcion la comparten citas y restaurantes con etiquetas que
// sus pruebas afirman. Un vertical que necesite ocultar identificadores compone ambas (`redactarDatosDePagoEIdentidad`).
// El anclaje a "fecha valida + homoclave" y las exclusiones evitan comerse folios, telefonos y montos.

const MES = "(?:0[1-9]|1[0-2])";
const DIA = "(?:0[1-9]|[12]\\d|3[01])";
const FECHA_AAMMDD = `\\d{2}${MES}${DIA}`;

/** CURP (18 caracteres): 4 letras + fecha AAMMDD + sexo + entidad (2 letras) + 3 consonantes internas + homoclave + digito. */
export const PATRON_CURP = new RegExp(`(?<![A-Za-z0-9])[A-Za-z]{4}${FECHA_AAMMDD}[HhMm][A-Za-z]{2}[B-DF-HJ-NP-TV-Zb-df-hj-np-tv-z]{3}[A-Za-z0-9]\\d(?![A-Za-z0-9])`, "g");
/** RFC de persona fisica (13: 4 letras + fecha + homoclave) o moral (12: 3 letras + fecha + homoclave). */
export const PATRON_RFC = new RegExp(`(?<![A-Za-z0-9])[A-Za-z\u00d1\u00f1&]{3,4}${FECHA_AAMMDD}[A-Za-z0-9]{3}(?![A-Za-z0-9])`, "g");
/** RFC genericos del SAT (publico en general / extranjero): no identifican a nadie, se conservan. */
const RFC_GENERICOS: ReadonlySet<string> = new Set(["XAXX010101000", "XEXX010101000"]);
/**
 * Pasaporte: solo con su etiqueta ("pasaporte", "passport"), porque el numero (6-9 caracteres alfanumericos) sin
 * contexto es indistinguible de un folio. Exige al menos un digito en el numero para no comerse palabras.
 */
export const PATRON_PASAPORTE = /\b(pasaporte|passport)(\s*(?:n(?:u|\u00fa)mero|num\.?|no\.?|n\u00ba|#))?(\s*(?:es|is|:|-)?\s*)([A-Za-z0-9]{6,9})(?![A-Za-z0-9])/gi;

/** Oculta CURP, RFC y pasaporte de un texto libre. Idempotente. */
export function redactarIdentificadoresMx(texto: string): string {
  return texto
    .replace(PATRON_CURP, "[curp oculta]")
    .replace(PATRON_RFC, (m) => (RFC_GENERICOS.has(m.toUpperCase()) ? m : "[rfc oculto]"))
    .replace(PATRON_PASAPORTE, (m, etiqueta: string, numeroTxt: string | undefined, sep: string, numero: string) =>
      /\d/.test(numero) ? `${etiqueta}${numeroTxt ?? ""}${sep}[pasaporte oculto]` : m,
    );
}

/** Datos de pago + identificadores personales: lo que hoteles oculta ANTES de persistir un mensaje entrante. */
export function redactarDatosDePagoEIdentidad(texto: string): string {
  return redactarIdentificadoresMx(redactarDatosDePago(texto));
}

// ---- scrub general de texto libre (logs, errores, alertas) ----

export type Reemplazo = string | ((coincidencia: string) => string);

const ISO_FECHA = /^\d{4}-\d{2}-\d{2}/;

/** Orden importa: los mas especificos primero. */
export const PATRONES_SCRUB: ReadonlyArray<readonly [RegExp, Reemplazo]> = [
  // URI con credenciales embebidas (postgres://user:pass@host, https://u:p@host)
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MARCA_REDACTADO}@`],
  // Authorization: Bearer xxx / Basic xxx
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MARCA_REDACTADO}`],
  // JWT (tres segmentos base64url, el primero empieza por eyJ)
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MARCA_REDACTADO],
  // Llaves con prefijo conocido (Stripe sk_/pk_/whsec_, Resend re_, Anthropic/OpenAI sk-, GitHub gh*_)
  [/\b(?:sk|pk|rk|whsec|re|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, MARCA_REDACTADO],
  // clave=valor / clave: valor con clave sensible dentro de un texto libre
  [/\b([A-Za-z_-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|authorization|credential)[A-Za-z_-]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi, `$1=${MARCA_REDACTADO}`],
  // Correos electronicos
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[correo]"],
  // Tarjetas / secuencias largas de digitos (13-19, con espacios o guiones)
  [PATRON_TARJETA, "[numero]"],
  // Telefonos: 10+ digitos con separadores o prefijo +
  // (se exigen >= 10 digitos reales y que no sea una fecha/hora ISO, para no destruir "2026-09-30")
  [/(?<![\w.])\+?\d[\d\s().-]{8,}\d(?![\w.])/g, (m) => (m.replace(/\D/g, "").length >= 10 && !ISO_FECHA.test(m) ? "[telefono]" : m)],
  // Cadenas largas tipo token (hex/base64 de 32+ caracteres)
  // (se exige mezcla de letras y digitos: una ruta como "/internal/hoteles/identidad-purga" NO es un token)
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}(?![\w])/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? MARCA_REDACTADO : m)],
];
