// Caller ID desde la cabecera SIP `From` (o `P-Asserted-Identity`). El telefono del cliente SOLO puede salir de aqui (la
// telefonia lo reporta), nunca de lo que dice o escribe el modelo: viaja al token firmado por llamada
// (`x-atiende-call-token`, apps/api/src/voice-call-token.ts) y de ahi al contexto de las herramientas.
import { canonicalizeMexicanPhone } from "../../phone.ts";

const ANONIMO_RE = /^(anonymous|unavailable|restricted|private|unknown|withheld)$/i;

/** Devuelve el telefono canonico de 10 digitos, o null si el llamante es anonimo / no es un numero mexicano valido. */
export function extraerTelefonoSipFrom(cabecera: string | null | undefined): string | null {
  if (typeof cabecera !== "string" || cabecera.length === 0 || cabecera.length > 512) return null;
  // `"Nombre" <sip:+5219991234567@host;user=phone>;tag=abc`  |  `sip:5219991234567@host`  |  `tel:+52-999-123-4567`
  const uri = /<([^>]+)>/.exec(cabecera)?.[1] ?? cabecera;
  const m = /^\s*(?:sips?|tel):([^@;>\s]+)/i.exec(uri);
  if (!m) return null;
  let usuario: string;
  try {
    usuario = decodeURIComponent(m[1] ?? "");
  } catch {
    return null;
  }
  if (ANONIMO_RE.test(usuario)) return null;
  return canonicalizeMexicanPhone(usuario.replace(/[\s().-]/g, ""));
}
