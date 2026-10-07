// GET /health -- sondeo real (ver ../salud/health.ts para el detalle de diseño).
//   Público:  { ok, status, crons }  -> 200 si la BD respondió a `select 1`, 503 si no. `crons` es una señal agregada
//             ("ok" | "atrasados" | "sin_latido" | "sin_medir", ver `SenalCronsPublica`): sin nombres de cron ni errores, y NO cambia el
//             código HTTP (un cron sin latido no tumba el smoke del deploy; lo vigila el sondeo externo, scripts/health-check).
//   Detalle:  mismo endpoint con el secreto interno que ya usan las rutas
//             `/internal/*` (`x-atiende-internal-secret` o `Authorization:
//             Bearer`, ver `internalOrCronSecretMatches`) -> agrega versión,
//             latencia de BD, estado de crons y modo del rate limiter.
// Sin secreto válido, el detalle NUNCA se filtra: un secreto incorrecto recibe
// exactamente la misma respuesta pública (sin 401, para no servir de oráculo).
import { Hono } from "hono";
import { internalOrCronSecretMatches } from "../http-security.ts";
import {
  HEALTH_DB_TIMEOUT_MS,
  comprobarBaseDeDatos,
  estadoRateLimiter,
  evaluarCrons,
  infoVersion,
  lectorConTimeout,
  senalPublicaDeCrons,
  type EstadoBaseDeDatos,
  type EstadoCronsSalud,
  type LectorLatidos,
  type SenalCronsPublica,
} from "../salud/health.ts";
import type { AppDeps } from "../deps.ts";

/** El sondeo público se comparte entre llamadores durante este tiempo: un
 *  endpoint anónimo no debe poder convertirse en un generador de `select 1`
 *  contra el pool de la base (defensa de disponibilidad). El detalle (con
 *  secreto) siempre sondea en vivo. */
export const HEALTH_PUBLIC_CACHE_MS = 5_000;

export interface HealthOptions {
  /** Lector de latidos de SISTEMA. Por defecto `deps.resumenDiarioRepo.listCronHeartbeatsForSystem` (función
   *  `core.list_cron_heartbeats_for_system`, solo-sistema, su propia transacción por llamada): contra la base sin esa función o
   *  si falla / agota el tiempo, los crons se reportan "sin_medir" (nunca un 500 ni un "ok" inventado). */
  readonly leerLatidos?: LectorLatidos;
  readonly dbTimeoutMs?: number;
  readonly ahora?: () => Date;
}

export function healthRoutes(deps: AppDeps, opciones: HealthOptions = {}): Hono {
  const app = new Hono();
  const ahora = opciones.ahora ?? (() => new Date());
  const leer = lectorConTimeout(opciones.leerLatidos ?? (() => deps.resumenDiarioRepo.listCronHeartbeatsForSystem()), opciones.dbTimeoutMs ?? HEALTH_DB_TIMEOUT_MS);
  let cache: { readonly en: number; readonly db: EstadoBaseDeDatos; readonly crons: SenalCronsPublica } | null = null;

  app.get("/health", async (c) => {
    c.header("Cache-Control", "no-store");
    const detalle = internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret);

    // Una sola lectura de latidos por request, compartida por la senal publica y el detalle.
    let lectura: ReturnType<LectorLatidos> | undefined;
    const lecturaUnica: LectorLatidos = () => (lectura ??= leer());

    let db: EstadoBaseDeDatos;
    let senal: SenalCronsPublica;
    const t = Date.now();
    if (!detalle && cache && t - cache.en < HEALTH_PUBLIC_CACHE_MS) {
      db = cache.db;
      senal = cache.crons;
    } else {
      db = await comprobarBaseDeDatos(deps.engine, opciones.dbTimeoutMs);
      // Con la BD caida no se intenta otra lectura: la senal es "sin_medir".
      senal = db.ok ? await senalPublicaDeCrons(lecturaUnica, ahora()) : "sin_medir";
      if (!detalle) cache = { en: t, db, crons: senal };
    }

    const status = db.ok ? "ok" : "degradado";
    const httpStatus = db.ok ? 200 : 503;
    if (!detalle) return c.json({ ok: db.ok, status, crons: senal }, httpStatus);

    const crons: EstadoCronsSalud = db.ok ? await evaluarCrons(lecturaUnica, ahora()) : { estado: "sin_medir", motivo: "base_de_datos_no_responde" };
    return c.json(
      {
        ok: db.ok,
        status,
        version: infoVersion(),
        db,
        crons,
        cronsSenal: senal,
        rateLimiter: estadoRateLimiter(),
      },
      httpStatus,
    );
  });

  return app;
}
