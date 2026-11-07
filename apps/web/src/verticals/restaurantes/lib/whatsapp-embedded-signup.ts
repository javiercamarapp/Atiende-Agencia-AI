// WhatsApp Embedded Signup (Meta) del lado del navegador: carga el SDK de Facebook, abre el flujo con el `config_id` de la plataforma
// y junta lo que Meta devuelve (`code` de FB.login + `waba_id`/`phone_number_id` del mensaje WA_EMBEDDED_SIGNUP). El servidor
// (apps/api/src/routes/verticals/restaurantes/whatsapp-embedded-signup.ts) hace el canje y el registro: aqui nunca hay tokens.
import { fetchJson, sendJson } from "./admin-client.ts";

export interface ConfigEmbeddedSignup {
  readonly disponible: boolean;
  readonly faltantes: readonly string[];
  readonly appId: string | null;
  readonly configId: string | null;
  readonly graphApiVersion: string;
}

export interface ResultadoEmbeddedSignup {
  readonly phoneNumberId: string;
  readonly numero: string | null;
  readonly nombreVerificado: string | null;
  /** PIN de verificacion en dos pasos que se fijo al registrar el numero: se muestra UNA vez. */
  readonly pin: string;
}

function ruta(apiBaseUrl: string, propertyId: string, branchId: string): string {
  return `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/sucursales/${branchId}/whatsapp/embedded-signup`;
}

export function fetchConfigEmbeddedSignup(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, branchId: string): Promise<ConfigEmbeddedSignup> {
  return fetchJson(fetchImpl, ruta(apiBaseUrl, propertyId, branchId), token);
}

export function conectarEmbeddedSignup(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  branchId: string,
  datos: { readonly code: string; readonly wabaId: string; readonly phoneNumberId: string },
): Promise<ResultadoEmbeddedSignup> {
  return sendJson(fetchImpl, ruta(apiBaseUrl, propertyId, branchId), token, "POST", datos);
}

interface FbSdk {
  init(opts: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(cb: (r: { authResponse?: { code?: string } | null }) => void, opts: Record<string, unknown>): void;
}

declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_URL = "https://connect.facebook.net/es_LA/sdk.js";

/** Carga el SDK una sola vez. */
export function cargarSdkFacebook(appId: string, version: string): Promise<FbSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      if (!window.FB) return reject(new Error("No cargó el SDK de Facebook."));
      window.FB.init({ appId, autoLogAppEvents: false, xfbml: false, version });
      resolve(window.FB);
    };
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => reject(new Error("No se pudo cargar el SDK de Facebook (revisa bloqueadores de anuncios)."));
    document.body.appendChild(s);
  });
}

/** Mensaje `WA_EMBEDDED_SIGNUP` de la ventana de Meta: solo se acepta de un origen de facebook.com. */
export function leerMensajeEmbeddedSignup(ev: { origin: string; data: unknown }): { wabaId: string; phoneNumberId: string } | "cancelado" | null {
  if (!/^https:\/\/([a-z0-9-]+\.)?facebook\.com$/.test(ev.origin)) return null;
  let d: unknown = ev.data;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  const o = d as { type?: unknown; event?: unknown; data?: { waba_id?: unknown; phone_number_id?: unknown } } | null;
  if (!o || o.type !== "WA_EMBEDDED_SIGNUP") return null;
  if (o.event === "CANCEL" || o.event === "ERROR") return "cancelado";
  const wabaId = o.data?.waba_id;
  const phoneNumberId = o.data?.phone_number_id;
  return typeof wabaId === "string" && typeof phoneNumberId === "string" ? { wabaId, phoneNumberId } : null;
}

/** Abre el flujo de Meta y resuelve con code + ids (o lanza si el dueño cancela). */
export async function correrEmbeddedSignup(cfg: { readonly appId: string; readonly configId: string; readonly graphApiVersion: string }): Promise<{ code: string; wabaId: string; phoneNumberId: string }> {
  const fb = await cargarSdkFacebook(cfg.appId, cfg.graphApiVersion);
  return new Promise((resolve, reject) => {
    let ids: { wabaId: string; phoneNumberId: string } | null = null;
    let code: string | null = null;
    const terminar = () => {
      if (ids && code) {
        window.removeEventListener("message", oir);
        resolve({ code, ...ids });
      }
    };
    const oir = (ev: MessageEvent) => {
      const r = leerMensajeEmbeddedSignup(ev);
      if (r === "cancelado") {
        window.removeEventListener("message", oir);
        reject(new Error("Cancelaste la conexión con Meta."));
      } else if (r) {
        ids = r;
        terminar();
      }
    };
    window.addEventListener("message", oir);
    fb.login(
      (resp) => {
        const c = resp.authResponse?.code;
        if (!c) {
          window.removeEventListener("message", oir);
          reject(new Error("No se completó la autorización en Meta."));
          return;
        }
        code = c;
        terminar();
      },
      { config_id: cfg.configId, response_type: "code", override_default_response_type: true, extras: { setup: {}, sessionInfoVersion: "3" } },
    );
  });
}
