// Identidad estable de la persona en sesion para separar la cola de «Entregado» pendiente en un celular compartido. El panel del chofer NO asume
// correo: el acceso por celular + codigo (login de choferes por WhatsApp) emite la misma sesion pero el correo puede ser interno o venir vacio.
// Orden: `sub` del token de acceso (id de usuario, no sensible y estable entre refrescos) -> correo -> nombre. La cola solo la usa para
// derivar una huella corta (ver `claveCola`); nunca se muestra ni se envia.
import type { LoginSession } from "../../../lib/auth-client.ts";

function subDelToken(token: string): string | null {
  try {
    const carga = token.split(".")[1];
    if (!carga) return null;
    const base64 = carga.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(carga.length / 4) * 4, "=");
    const json = JSON.parse(atob(base64)) as { sub?: unknown };
    return typeof json.sub === "string" && json.sub.length > 0 ? json.sub : null;
  } catch {
    return null;
  }
}

export function identidadDeSesion(session: Pick<LoginSession, "token" | "email" | "fullName">): string {
  return subDelToken(session.token) ?? (session.email?.trim() || session.fullName?.trim() || "sin-identidad");
}
