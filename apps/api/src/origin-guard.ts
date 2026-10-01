// PL-09 -- validacion de Origin/Host (defensa en profundidad anti-CSRF) para las rutas de sesion.
//
// Hoy la sesion viaja como `Authorization: Bearer` (no hay cookie de sesion), asi que un sitio de
// terceros no puede disparar una accion autenticada con las credenciales ambientales del navegador.
// Esta guarda existe para que seguir siendo asi no dependa de una sola decision: si manana alguna
// ruta de sesion pasa a cookies, o un navegador envia una peticion de escritura desde un origen
// ajeno, se rechaza ANTES de ejecutar el handler.
//
// Regla (solo metodos con efectos: POST/PUT/PATCH/DELETE; GET/HEAD/OPTIONS no se tocan):
//   1. `Origin` presente: debe ser "mismo origen" (su host == el `Host` de la peticion, o el
//      `X-Forwarded-Host` que Vercel agrega) o estar en la allowlist del entorno (`ALLOWED_ORIGINS` +
//      el origen de `APP_BASE_URL`). `Origin: null` (iframe sandbox, redirecciones opacas) se rechaza.
//   2. Sin `Origin`: se mira `Referer` con el mismo criterio si viene; y `Sec-Fetch-Site: cross-site`
//      se rechaza. Sin ninguna senal de navegador (curl, servidor a servidor, pruebas) pasa: no es
//      un vector CSRF y rechazarlo romperia integraciones/cron/webhooks.
// Un navegador no puede falsear `Origin`/`Host`, que es lo que hace util la comprobacion.
import type { MiddlewareHandler } from "hono";
import { Errors } from "./errors.ts";
import { logEvent } from "./logger.ts";

const METODOS_CON_EFECTOS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface OriginGuardConfig {
  /** `ApiEnv.allowedOrigins` (variable `ALLOWED_ORIGINS`, por entorno). */
  readonly allowedOrigins: readonly string[];
  /** `ApiEnv.appBaseUrl`: el origen publico de la app siempre es de confianza. */
  readonly appBaseUrl?: string;
}

export interface OriginSignals {
  readonly origin: string | null;
  readonly referer: string | null;
  readonly host: string | null;
  readonly forwardedHost: string | null;
  readonly secFetchSite: string | null;
}

export type OriginVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: "origin_null" | "origin_no_permitido" | "referer_no_permitido" | "cross_site" };

function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function allowlist(config: OriginGuardConfig): Set<string> {
  const out = new Set<string>();
  for (const raw of config.allowedOrigins) {
    const n = normalizeOrigin(raw);
    if (n) out.add(n);
  }
  if (config.appBaseUrl) {
    const n = normalizeOrigin(config.appBaseUrl);
    if (n) out.add(n);
  }
  return out;
}

function hostOf(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  return first ? first : null;
}

function esMismoOrigenOPermitido(candidato: string, signals: OriginSignals, permitidos: Set<string>): boolean {
  const n = normalizeOrigin(candidato);
  if (!n) return false;
  if (permitidos.has(n)) return true;
  const host = new URL(n).host.toLowerCase();
  return host === hostOf(signals.host) || host === hostOf(signals.forwardedHost);
}

/** Decision pura (sin Hono) para poder probarla de forma exhaustiva. */
export function evaluateOrigin(signals: OriginSignals, config: OriginGuardConfig): OriginVerdict {
  const permitidos = allowlist(config);
  if (signals.origin !== null) {
    if (signals.origin === "null") return { ok: false, reason: "origin_null" };
    return esMismoOrigenOPermitido(signals.origin, signals, permitidos) ? { ok: true } : { ok: false, reason: "origin_no_permitido" };
  }
  if (signals.referer) {
    return esMismoOrigenOPermitido(signals.referer, signals, permitidos) ? { ok: true } : { ok: false, reason: "referer_no_permitido" };
  }
  if (signals.secFetchSite === "cross-site") return { ok: false, reason: "cross_site" };
  return { ok: true };
}

/** Middleware Hono: 403 uniforme si una peticion con efectos viene de un origen no permitido. */
export function originGuard(config: OriginGuardConfig): MiddlewareHandler {
  return async (c, next) => {
    if (METODOS_CON_EFECTOS.has(c.req.method)) {
      const verdict = evaluateOrigin(
        {
          origin: c.req.header("origin") ?? null,
          referer: c.req.header("referer") ?? null,
          host: c.req.header("host") ?? null,
          forwardedHost: c.req.header("x-forwarded-host") ?? null,
          secFetchSite: c.req.header("sec-fetch-site") ?? null,
        },
        config,
      );
      if (!verdict.ok) {
        logEvent(c, "warn", "origen_rechazado", { reason: verdict.reason, path: c.req.path });
        throw Errors.forbidden("Origen no permitido");
      }
    }
    await next();
  };
}

/** Respuestas de sesion (tokens, estado de cuenta) nunca deben quedar en cache de navegador o proxy. */
export function sinCacheEnSesion(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  };
}
