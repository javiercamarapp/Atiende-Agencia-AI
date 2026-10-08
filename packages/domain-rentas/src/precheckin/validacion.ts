// Rn-P3-08 -- validacion de la entrada del formulario publico. Funciones puras. Un dato mal formado se rechaza ANTES de tocar la base y
// con un mensaje fijo: nunca se repite lo que el huesped escribio (ni en la respuesta ni en logs).
export interface EntradaVerificacion {
  readonly codigo: string;
  readonly ultimos4: string;
}

export interface EntradaCaptura {
  readonly token: string;
  readonly correo: string;
  readonly whatsapp: string | null;
  readonly aceptaPrivacidad: boolean;
  readonly aceptaReglamento: boolean;
}

export type Validacion<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly error: string };

const CODIGO_RE = /^[A-Z0-9]{1,40}$/;
const ULTIMOS4_RE = /^[0-9]{4}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** El codigo se normaliza: sin espacios y en mayusculas (el huesped lo copia de un mensaje y suele traer espacios o minusculas). */
export function normalizarCodigo(crudo: string): string {
  return crudo.replace(/\s+/g, "").toUpperCase();
}

export function validarVerificacion(cuerpo: unknown): Validacion<EntradaVerificacion> {
  const o = objeto(cuerpo);
  if (!o || typeof o.codigo !== "string" || typeof o.ultimos4 !== "string") return { ok: false, error: "Escribe tu codigo de confirmacion y los ultimos 4 digitos de tu telefono." };
  const codigo = normalizarCodigo(o.codigo);
  const ultimos4 = o.ultimos4.trim();
  if (!CODIGO_RE.test(codigo)) return { ok: false, error: "Escribe tu codigo de confirmacion y los ultimos 4 digitos de tu telefono." };
  if (!ULTIMOS4_RE.test(ultimos4)) return { ok: false, error: "Escribe tu codigo de confirmacion y los ultimos 4 digitos de tu telefono." };
  return { ok: true, valor: { codigo, ultimos4 } };
}

/** WhatsApp opcional: acepta "+52 998 123 4567" o "(998) 123-4567" y deja solo digitos (10 a 15, con lada). */
export function normalizarWhatsapp(crudo: string): string | null {
  const digitos = crudo.replace(/[\s().+-]/g, "");
  return /^[0-9]{10,15}$/.test(digitos) ? digitos : null;
}

export function validarCaptura(cuerpo: unknown): Validacion<EntradaCaptura> {
  const o = objeto(cuerpo);
  if (!o) return { ok: false, error: "Solicitud invalida." };
  if (typeof o.token !== "string" || !TOKEN_RE.test(o.token)) return { ok: false, error: "La verificacion expiro. Vuelve a empezar." };
  const correo = typeof o.correo === "string" ? o.correo.trim() : "";
  if (correo.length > 254 || !EMAIL_RE.test(correo)) return { ok: false, error: "Escribe un correo valido." };
  let whatsapp: string | null = null;
  if (o.whatsapp !== undefined && o.whatsapp !== null && o.whatsapp !== "") {
    if (typeof o.whatsapp !== "string") return { ok: false, error: "Escribe un WhatsApp valido (10 a 15 digitos) o dejalo vacio." };
    whatsapp = normalizarWhatsapp(o.whatsapp);
    if (whatsapp === null) return { ok: false, error: "Escribe un WhatsApp valido (10 a 15 digitos) o dejalo vacio." };
  }
  if (o.aceptaPrivacidad !== undefined && typeof o.aceptaPrivacidad !== "boolean") return { ok: false, error: "Solicitud invalida." };
  if (o.aceptaReglamento !== undefined && typeof o.aceptaReglamento !== "boolean") return { ok: false, error: "Solicitud invalida." };
  return { ok: true, valor: { token: o.token, correo, whatsapp, aceptaPrivacidad: o.aceptaPrivacidad === true, aceptaReglamento: o.aceptaReglamento === true } };
}

/** Reglamento de la casa (staff): vacio = la property no pide aceptarlo. */
export function validarReglamento(cuerpo: unknown): Validacion<{ readonly reglamento: string | null }> {
  const o = objeto(cuerpo);
  if (!o || (o.reglamento !== null && typeof o.reglamento !== "string")) return { ok: false, error: "reglamento: se esperaba texto o null." };
  if (o.reglamento === null) return { ok: true, valor: { reglamento: null } };
  const texto = o.reglamento.trim();
  if (texto.length === 0) return { ok: true, valor: { reglamento: null } };
  if (texto.length > 4000) return { ok: false, error: "reglamento: maximo 4000 caracteres." };
  return { ok: true, valor: { reglamento: texto } };
}
