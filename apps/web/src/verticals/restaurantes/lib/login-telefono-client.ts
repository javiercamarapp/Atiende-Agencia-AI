// Cliente del login del REPARTIDOR por celular + codigo de WhatsApp (docs/LOGIN-CHOFER-WHATSAPP.md). Backend real:
// apps/api/src/routes/auth-login-telefono.ts. Sin React y con `fetchImpl` inyectado para probar la red real con vitest en entorno node.
// La respuesta de `solicitar` es la MISMA exista o no la cuenta: aqui nunca se confirma ni se niega que un celular tenga cuenta.
import type { LoginSession } from "../../../lib/auth-client.ts";
import { deleteJson, fetchJson, sendJson } from "./admin-client.ts";

/** 10 digitos nacionales de un celular mexicano, o null. Acepta +52/52/521, espacios, guiones y parentesis (mismas reglas que el servidor). */
export function normalizarCelular(entrada: string): string | null {
  if (entrada.length > 32 || !/^[+\d\s().-]+$/.test(entrada)) return null;
  const d = entrada.replace(/\D/g, "");
  let nacional: string;
  if (d.length === 10) nacional = d;
  else if (d.length === 12 && d.startsWith("52")) nacional = d.slice(2);
  else if (d.length === 13 && d.startsWith("521")) nacional = d.slice(3);
  else return null;
  return /^[1-9]\d{9}$/.test(nacional) ? nacional : null;
}

/** "999 123 0001" para mostrar el numero ya normalizado. */
export function formatearCelular(nacional: string): string {
  return `${nacional.slice(0, 3)} ${nacional.slice(3, 6)} ${nacional.slice(6)}`;
}

export function normalizarCodigo(entrada: string): string | null {
  const limpio = entrada.replace(/\s+/g, "");
  return /^\d{6}$/.test(limpio) ? limpio : null;
}

export type MotivoFallo = "no_disponible" | "demasiados" | "invalido" | "red";
export type ResultadoSolicitud = { readonly ok: true; readonly expiraEnSegundos: number } | { readonly ok: false; readonly motivo: MotivoFallo; readonly mensaje: string };
export type ResultadoVerificacion = { readonly ok: true; readonly session: LoginSession } | { readonly ok: false; readonly motivo: MotivoFallo; readonly mensaje: string };

const MSG_RED = "No pudimos conectarnos. Revisa tu señal e inténtalo de nuevo.";
const MSG_NO_DISPONIBLE = "El acceso con celular todavía no está disponible. Entra con tu correo o pídele ayuda a tu encargado.";

function base(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/$/, "");
}

async function mensajeDe(res: Response, respaldo: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body.message === "string" && body.message.length > 0 ? body.message : respaldo;
  } catch {
    return respaldo;
  }
}

export async function consultarDisponibilidadLoginCelular(fetchImpl: typeof fetch, apiBaseUrl: string): Promise<boolean> {
  try {
    const res = await fetchImpl(`${base(apiBaseUrl)}/auth/login-telefono/estado`);
    if (!res.ok) return false;
    return ((await res.json()) as { disponible?: unknown }).disponible === true;
  } catch {
    return false;
  }
}

export async function solicitarCodigoCelular(fetchImpl: typeof fetch, apiBaseUrl: string, celularNacional: string): Promise<ResultadoSolicitud> {
  try {
    const res = await fetchImpl(`${base(apiBaseUrl)}/auth/login-telefono/solicitar`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telefono: celularNacional }),
    });
    if (res.ok) return { ok: true, expiraEnSegundos: Number(((await res.json()) as { expiraEnSegundos?: unknown }).expiraEnSegundos) || 300 };
    if (res.status === 503) return { ok: false, motivo: "no_disponible", mensaje: MSG_NO_DISPONIBLE };
    if (res.status === 429) return { ok: false, motivo: "demasiados", mensaje: await mensajeDe(res, "Pediste demasiados códigos. Espera unos minutos e inténtalo de nuevo.") };
    if (res.status === 400) return { ok: false, motivo: "invalido", mensaje: await mensajeDe(res, "Escribe tu celular de 10 dígitos.") };
    return { ok: false, motivo: "red", mensaje: "No pudimos enviar el código. Inténtalo de nuevo en un momento." };
  } catch {
    return { ok: false, motivo: "red", mensaje: MSG_RED };
  }
}

export async function verificarCodigoCelular(fetchImpl: typeof fetch, apiBaseUrl: string, celularNacional: string, codigo: string): Promise<ResultadoVerificacion> {
  try {
    const res = await fetchImpl(`${base(apiBaseUrl)}/auth/login-telefono/verificar`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telefono: celularNacional, codigo }),
    });
    if (res.ok) {
      const b = (await res.json()) as { token: string; refreshToken: string; email: string; fullName?: string; organizations: LoginSession["organizations"] };
      return { ok: true, session: { token: b.token, refreshToken: b.refreshToken, email: b.email, fullName: b.fullName ?? "", organizations: b.organizations } };
    }
    if (res.status === 503) return { ok: false, motivo: "no_disponible", mensaje: MSG_NO_DISPONIBLE };
    if (res.status === 429) return { ok: false, motivo: "demasiados", mensaje: await mensajeDe(res, "Demasiados intentos. Espera unos minutos.") };
    if (res.status === 400) return { ok: false, motivo: "invalido", mensaje: await mensajeDe(res, "Escribe el código de 6 dígitos.") };
    return { ok: false, motivo: "invalido", mensaje: "Código incorrecto o vencido. Pide uno nuevo." };
  } catch {
    return { ok: false, motivo: "red", mensaje: MSG_RED };
  }
}

// ---- Alta del celular por el encargado/admin (Staff) ----
export interface TelefonoAccesoFila {
  readonly userId: string;
  readonly telefonoEnmascarado: string;
}

export async function fetchTelefonosAcceso(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly TelefonoAccesoFila[]> {
  const body = await fetchJson<{ telefonos: TelefonoAccesoFila[] }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/staff/telefonos-acceso`, token);
  return body.telefonos;
}

export async function guardarTelefonoAcceso(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, userId: string, celular: string): Promise<void> {
  await sendJson<{ ok: true }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/staff/miembros/${userId}/telefono-acceso`, token, "PUT", { telefono: celular });
}

export async function quitarTelefonoAcceso(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, userId: string): Promise<void> {
  await deleteJson<{ ok: true; quitado: boolean }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/staff/miembros/${userId}/telefono-acceso`, token);
}
