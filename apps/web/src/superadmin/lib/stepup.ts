// Step-up MFA del superadmin en el cliente (ver apps/api/src/superadmin-seguridad/step-up.ts).
//
// El token de step-up vive SOLO en memoria (nunca en localStorage): dura 5 minutos,
// esta atado al access token con el que se emitio y al usuario, y recargar la pagina
// obliga a verificar de nuevo -- el compromiso correcto para una accion sensible.
//
// `fetchConStepUp` es un `fetch` que (1) adjunta el token de step-up vigente si lo hay y
// (2) si el servidor responde 403 `stepup_required`, pide el codigo TOTP con un dialogo
// (registrado por `StepUpDialog`), lo verifica y REINTENTA UNA vez. Sin dialogo
// registrado (p. ej. en tests) devuelve la respuesta 403 original, sin romper nada.

interface CachedStepUp {
  readonly accessToken: string;
  readonly token: string;
  readonly expiresAtMs: number;
}

let cached: CachedStepUp | null = null;

export type StepUpPrompter = (ctx: { readonly apiBaseUrl: string; readonly accessToken: string }) => Promise<void>;
let prompter: StepUpPrompter | null = null;

export function registrarStepUpPrompter(p: StepUpPrompter | null): void {
  prompter = p;
}

export function limpiarStepUp(): void {
  cached = null;
}

export function stepUpVigente(accessToken: string, nowMs: number = Date.now()): string | null {
  if (!cached || cached.accessToken !== accessToken || cached.expiresAtMs <= nowMs) return null;
  return cached.token;
}

export function guardarStepUp(accessToken: string, token: string, expiraEnSegundos: number, nowMs: number = Date.now()): void {
  // Margen de 10 s: nunca se adjunta un token a punto de vencer.
  cached = { accessToken, token, expiresAtMs: nowMs + Math.max(0, expiraEnSegundos - 10) * 1000 };
}

export interface VerificarMfaResultado {
  readonly ok: boolean;
  readonly activado?: boolean;
  readonly code?: string;
  readonly message?: string;
}

/** POST /superadmin/mfa/verificar; si acierta, guarda el step-up en memoria. */
export async function verificarMfa(apiBaseUrl: string, accessToken: string, codigo: string): Promise<VerificarMfaResultado> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/superadmin/mfa/verificar`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ codigo }),
  });
  const body = (await res.json().catch(() => null)) as { stepUpToken?: string; expiraEnSegundos?: number; activado?: boolean; code?: string; message?: string } | null;
  if (res.ok && body?.stepUpToken) {
    guardarStepUp(accessToken, body.stepUpToken, body.expiraEnSegundos ?? 300);
    return { ok: true, activado: body.activado === true };
  }
  return { ok: false, code: body?.code, message: body?.message ?? "No se pudo verificar el código." };
}

function conStepUp(init: RequestInit, accessToken: string): RequestInit {
  const token = stepUpVigente(accessToken);
  if (!token) return init;
  return { ...init, headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), "x-stepup-token": token } };
}

export async function fetchConStepUp(apiBaseUrl: string, accessToken: string, url: string, init: RequestInit = {}): Promise<Response> {
  const first = await fetch(url, conStepUp(init, accessToken));
  if (first.status !== 403 || !prompter) return first;
  const body = (await first.clone().json().catch(() => null)) as { code?: string } | null;
  if (body?.code !== "stepup_required") return first;
  try {
    await prompter({ apiBaseUrl, accessToken });
  } catch {
    return first; // el usuario cancelo el dialogo: se devuelve el 403 original
  }
  return fetch(url, conStepUp(init, accessToken));
}

/**
 * Pide la verificacion MFA ANTES de enviar una accion sensible (CHAT-17: la tarjeta de accion del Copiloto no manda la confirmacion hasta tener el
 * step-up, para que cancelar el dialogo no deje ninguna peticion de confirmacion). `true` = ya hay un step-up vigente o se verifico ahora;
 * `false` = la persona cancelo el dialogo (o no hay dialogo registrado). El servidor sigue exigiendo el step-up por su cuenta.
 */
export async function solicitarStepUp(apiBaseUrl: string, accessToken: string): Promise<boolean> {
  if (stepUpVigente(accessToken)) return true;
  if (!prompter) return false;
  try {
    await prompter({ apiBaseUrl, accessToken });
    return stepUpVigente(accessToken) !== null;
  } catch {
    return false;
  }
}
