// GET /health -- sondeo real (ver ../salud/health.ts para el detalle de diseño).
//   Público:  { ok, status }  -> 200 si la BD respondió a `select 1`, 503 si no.
//   Detalle:  mismo endpoint con el secreto interno que ya usan las rutas
//             `/internal/*` (`x-atiende-internal-secret` o `Authorization:
//             Bearer`, ver `internalOrCronSecretMatches`) -> agrega versión,
//             latencia de BD, estado de crons y modo del rate limiter.
// Sin secreto válido, el detalle NUNCA se filtra: un secreto incorrecto recibe
// exactamente la misma respuesta pública (sin 401, para no servir de oráculo).
import { Hono } from "hono";
import { internalOrCronSecretMatches } from "../http-security.ts";
import { comprobarBaseDeDatos, estadoRateLimiter, evaluarCrons, infoVersion, type EstadoBaseDeDatos, type LectorLatidos } from "../salud/health.ts";
import type { AppDeps } from "../deps.ts";

/** El sondeo público se comparte entre llamadores durante este tiempo: un
 *  endpoint anónimo no debe poder convertirse en un generador de `select 1`
 *  contra el pool de la base (defensa de disponibilidad). El detalle (con
 *  secreto) siempre sondea en vivo. */
export const HEALTH_PUBLIC_CACHE_MS = 5_000;

export interface HealthOptions {
  /** Lector de latidos de SISTEMA; sin él, los crons se reportan "sin_medir". */
  readonly leerLatidos?: LectorLatidos;
  readonly dbTimeoutMs?: number;
  readonly ahora?: () => Date;
}

export function healthRoutes(deps: AppDeps, opciones: HealthOptions = {}): Hono {
  const app = new Hono();
  const ahora = opciones.ahora ?? (() => new Date());
  let cache: { readonly en: number; readonly db: EstadoBaseDeDatos } | null = null;

  app.get("/health", async (c) => {
    c.header("Cache-Control", "no-store");
    const detalle = internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret);

    let db: EstadoBaseDeDatos;
    const t = Date.now();
    if (!detalle && cache && t - cache.en < HEALTH_PUBLIC_CACHE_MS) {
      db = cache.db;
    } else {
      db = await comprobarBaseDeDatos(deps.engine, opciones.dbTimeoutMs);
      if (!detalle) cache = { en: t, db };
    }

    const status = db.ok ? "ok" : "degradado";
    const httpStatus = db.ok ? 200 : 503;
    if (!detalle) return c.json({ ok: db.ok, status }, httpStatus);

    const crons = await evaluarCrons(opciones.leerLatidos, ahora());
    return c.json(
      {
        ok: db.ok,
        status,
        version: infoVersion(),
        db,
        crons,
        rateLimiter: estadoRateLimiter(),
      },
      httpStatus,
    );
  });

  return app;
}
