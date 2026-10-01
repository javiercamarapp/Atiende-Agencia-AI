// Redaccion de datos sensibles para alertas SALIENTES (correo, webhook, Sentry).
// Una alerta sale del proceso hacia un tercero (Resend, un webhook generico, Sentry): lo que
// viaje ahi NO debe contener secretos, tokens, correos ni telefonos de clientes aunque un
// mensaje de error de Postgres/proveedor los haya incluido. Defensa en profundidad: el
// llamador ya deberia mandar solo texto operativo; esto es la red de seguridad.
//
// Pura y sin I/O. Cada patron es deliberadamente CONSERVADOR hacia redactar de mas: una alerta
// con un fragmento de menos es un costo menor que una filtracion.

export const MARCA_REDACTADO = "[redactado]";

/** Longitud maxima de cualquier cadena que sale en una alerta. */
export const MAX_LARGO_CADENA = 500;
const MAX_PROFUNDIDAD = 4;
const MAX_CLAVES = 30;
const MAX_ELEMENTOS = 20;

/** Claves cuyo VALOR se redacta siempre, sin mirar su contenido. */
const CLAVE_SENSIBLE = /pass(word|wd)?|secret|token|authorization|api[-_]?key|cookie|dsn|jwt|credential|clave|private|bearer|signature|firma/i;

// Orden importa: los mas especificos primero.
const PATRONES: ReadonlyArray<readonly [RegExp, string | ((m: string) => string)]> = [
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
  [/\b(?:\d[ -]?){13,19}\b/g, "[numero]"],
  // Telefonos: 10+ digitos con separadores o prefijo +
  // (se exigen >= 10 digitos reales y que no sea una fecha/hora ISO, para no destruir "2026-09-30")
  [/(?<![\w.])\+?\d[\d\s().-]{8,}\d(?![\w.])/g, (m) => (m.replace(/\D/g, "").length >= 10 && !/^\d{4}-\d{2}-\d{2}/.test(m) ? "[telefono]" : m)],
  // Cadenas largas tipo token (hex/base64 de 32+ caracteres)
  // (se exige mezcla de letras y digitos: una ruta como "/internal/hoteles/identidad-purga" NO es un token)
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}(?![\w])/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? MARCA_REDACTADO : m)],
];

export function redactarTexto(texto: string): string {
  let salida = texto;
  for (const [patron, reemplazo] of PATRONES) salida = typeof reemplazo === "string" ? salida.replace(patron, reemplazo) : salida.replace(patron, reemplazo);
  return salida.length > MAX_LARGO_CADENA ? `${salida.slice(0, MAX_LARGO_CADENA - 1)}…` : salida;
}

/** Redacta recursivamente un valor arbitrario (objeto/array/primitivo) con topes de
 *  profundidad y tamano. Nunca lanza; los ciclos terminan por el tope de profundidad. */
export function redactarValor(valor: unknown, profundidad = 0): unknown {
  if (valor === null || valor === undefined) return valor ?? null;
  if (typeof valor === "string") return redactarTexto(valor);
  if (typeof valor === "number" || typeof valor === "boolean") return valor;
  if (valor instanceof Error) return redactarTexto(valor.message);
  if (profundidad >= MAX_PROFUNDIDAD) return "[truncado]";
  if (Array.isArray(valor)) return valor.slice(0, MAX_ELEMENTOS).map((v) => redactarValor(v, profundidad + 1));
  if (typeof valor === "object") {
    const salida: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor as Record<string, unknown>).slice(0, MAX_CLAVES)) {
      salida[clave] = CLAVE_SENSIBLE.test(clave) ? MARCA_REDACTADO : redactarValor(v, profundidad + 1);
    }
    return salida;
  }
  return "[no_serializable]";
}
