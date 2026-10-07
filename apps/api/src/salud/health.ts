// Motor de `GET /health` -- sondeo REAL de la base de datos + estado de
// latidos de cron + modo del rate limiter. Antes `/health` devolvía `{ok:true}`
// sin tocar la BD (un monitor externo veía "verde" con la base caída).
//
// Dos niveles de respuesta (ver `../app.ts`):
//   - PÚBLICO (sin credenciales): solo `{ ok, status }`. HTTP 200 si la BD
//     respondió, 503 si no. Sin versión, sin latencias, sin mensajes de error
//     ni nombres de crons -- nada que ayude a perfilar el despliegue.
//   - DETALLE (con el secreto interno que ya usan las rutas `/internal/*`,
//     `internalOrCronSecretMatches`): agrega versión/commit, latencia de la BD,
//     estado de los crons y modo del rate limiter.
//
// Compatibilidad con la base SIN migrar: la única consulta a la BD es
// `select 1` (no depende de ninguna tabla/función de migración). La lectura de
// latidos (`core.cron_heartbeat`) hoy solo existe detrás de funciones
// `for_superadmin` (exigen `auth.uid() = p_caller_id` de un superadmin real);
// ninguna lectura de SISTEMA existe todavía. Por eso el lector de latidos es
// INYECTABLE y, sin lector, el estado es "sin_medir" -- nunca un 500 ni un
// "todo bien" inventado. Ver `evaluarCrons` para la semántica exacta.
import type { TenancyEngine } from "@atiende/core-tenancy";
import { cadenciaMinutosPorRuta, rutasDeCronDeclaradas } from "./cadencia.ts";
import { juzgarLatido, type CronHeartbeatRow, type EstadoCron } from "./motor.ts";

/** Tope para el `select 1`. Un monitor externo corta alrededor de 5-10 s; 2 s
 *  separa "lento" de "caído" sin acumular conexiones colgadas. */
export const HEALTH_DB_TIMEOUT_MS = 2_000;

export interface EstadoBaseDeDatos {
  readonly ok: boolean;
  readonly latenciaMs: number;
  /** Clasificación gruesa, sin el mensaje crudo del driver (puede traer host/usuario). */
  readonly motivo: "timeout" | "error" | null;
}

/**
 * `select 1` bajo timeout. Abre SU PROPIA transacción (`withAppSession` de un
 * solo statement, nada más se ejecuta después), así que un error aquí nunca
 * envenena la transacción de otra consulta. Nunca lanza.
 */
export async function comprobarBaseDeDatos(engine: TenancyEngine, timeoutMs: number = HEALTH_DB_TIMEOUT_MS, ahora: () => number = Date.now): Promise<EstadoBaseDeDatos> {
  const inicio = ahora();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const consulta = engine.withAppSession({ userId: null }, async (db) => {
    await db.query("select 1 as ok;");
    return "ok" as const;
  });
  // Si gana el timeout, la consulta sigue viva un rato: su rechazo tardío no debe
  // convertirse en unhandledRejection.
  consulta.catch(() => undefined);
  try {
    const resultado = await Promise.race([consulta, timeout]);
    const latenciaMs = ahora() - inicio;
    return resultado === "ok" ? { ok: true, latenciaMs, motivo: null } : { ok: false, latenciaMs, motivo: "timeout" };
  } catch {
    return { ok: false, latenciaMs: ahora() - inicio, motivo: "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type EstadoCronsSalud =
  | { readonly estado: "sin_medir"; readonly motivo: string }
  | {
      readonly estado: "medido";
      readonly total: number;
      readonly ok: number;
      readonly vencido: number;
      readonly sinLatido: number;
      readonly error: number;
      /** Solo nombres de cron con problema (paths públicos de `vercel.json`). */
      readonly conProblema: readonly { readonly cronName: string; readonly estado: EstadoCron }[];
    };

export type LectorLatidos = () => Promise<readonly CronHeartbeatRow[] | null>;

/** Senal AGREGADA y publica de crons (campo `crons` del `/health` sin secreto). Sin nombres, sin errores, sin conteos:
 *  - `sin_latido`: al menos un cron de alta frecuencia (cadencia <= 15 min) sin NINGUN latido (nunca corrio).
 *  - `atrasados`: algun cron con latido mas viejo que 3 veces su cadencia.
 *  - `ok`: ninguno de los dos.
 *  - `sin_medir`: no se pudo leer la tabla de latidos (base sin migrar, error o timeout): nunca un "ok" inventado. */
export type SenalCronsPublica = "ok" | "atrasados" | "sin_latido" | "sin_medir";

/** Cadencia maxima (minutos) de un cron "de alta frecuencia": si estos nunca dejaron latido, el scheduler no esta corriendo. */
export const CADENCIA_ALTA_FRECUENCIA_MIN = 15;
/** Un latido mas viejo que este multiplo de la cadencia del cron cuenta como atrasado. */
export const FACTOR_ATRASO_CRON = 3;

/** Pura. Cuantos crons declarados de alta frecuencia (cadencia <= 15 min) no tienen NINGUN latido. */
export function contarCronsAltaFrecuenciaSinLatido(filas: readonly CronHeartbeatRow[]): number {
  const cadencias = cadenciaMinutosPorRuta();
  const conLatido = new Set(filas.filter((f) => f.lastFinishedAt !== null && !Number.isNaN(new Date(f.lastFinishedAt).getTime())).map((f) => f.cronName));
  return rutasDeCronDeclaradas().filter((r) => (cadencias[r] ?? 0) > 0 && (cadencias[r] ?? 0) <= CADENCIA_ALTA_FRECUENCIA_MIN && !conLatido.has(r)).length;
}

/** Pura. `filas === null` (no se pudo leer) => `sin_medir`. Solo mira los crons declarados en `vercel.json`: un latido de un path que
 *  ya no existe no cuenta, y un cron sin cadencia determinable (0) nunca se declara atrasado ni sin latido. `sin_latido` gana a `atrasados`. */
export function resumirCronsPublico(filas: readonly CronHeartbeatRow[] | null, ahora: Date): SenalCronsPublica {
  if (filas === null) return "sin_medir";
  const cadencias = cadenciaMinutosPorRuta();
  const porNombre = new Map(filas.map((f) => [f.cronName, f]));
  let atrasados = false;
  for (const cronName of rutasDeCronDeclaradas()) {
    const cadenciaMin = cadencias[cronName] ?? 0;
    if (cadenciaMin <= 0) continue;
    const fin = porNombre.get(cronName)?.lastFinishedAt ?? null;
    const finMs = fin === null ? Number.NaN : new Date(fin).getTime();
    if (Number.isNaN(finMs)) {
      if (cadenciaMin <= CADENCIA_ALTA_FRECUENCIA_MIN) return "sin_latido";
      continue;
    }
    if ((ahora.getTime() - finMs) / 60_000 > FACTOR_ATRASO_CRON * cadenciaMin) atrasados = true;
  }
  return atrasados ? "atrasados" : "ok";
}

/** Lee los latidos y resume la senal publica. Nunca lanza: una lectura que falla o devuelve `null` es `sin_medir`. */
export async function senalPublicaDeCrons(leer: LectorLatidos | undefined, ahora: Date): Promise<SenalCronsPublica> {
  if (!leer) return "sin_medir";
  try {
    return resumirCronsPublico(await leer(), ahora);
  } catch {
    return "sin_medir";
  }
}

/** Envuelve un lector con un tope de tiempo (el lector abre SU PROPIA transaccion: un timeout no deja nada a medias en otra consulta). */
export function lectorConTimeout(leer: LectorLatidos, timeoutMs: number): LectorLatidos {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timeout_lectura_latidos")), timeoutMs);
    });
    const lectura = leer();
    lectura.catch(() => undefined); // si gana el timeout, el rechazo tardio no debe ser unhandledRejection
    try {
      return await Promise.race([lectura, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * Reutiliza `juzgarLatido` (motor.ts) y las cadencias derivadas de `vercel.json`.
 * Sin lector, o si el lector falla / devuelve `null` / la tabla no existe (base
 * sin migrar) => "sin_medir". Un latido AUSENTE para un cron declarado es
 * `sin_latido` (distinto de "sin medir": sí se leyó la tabla).
 */
export async function evaluarCrons(leer: LectorLatidos | undefined, ahora: Date): Promise<EstadoCronsSalud> {
  if (!leer) return { estado: "sin_medir", motivo: "lectura_de_sistema_de_latidos_no_disponible" };
  let filas: readonly CronHeartbeatRow[] | null;
  try {
    filas = await leer();
  } catch {
    return { estado: "sin_medir", motivo: "lectura_fallida" };
  }
  if (filas === null) return { estado: "sin_medir", motivo: "tabla_de_latidos_no_disponible" };

  const cadencias = cadenciaMinutosPorRuta();
  const porNombre = new Map(filas.map((f) => [f.cronName, f]));
  const nombres = new Set<string>([...rutasDeCronDeclaradas(), ...porNombre.keys()]);
  const conteo = { ok: 0, vencido: 0, sinLatido: 0, error: 0 };
  const conProblema: { cronName: string; estado: EstadoCron }[] = [];
  for (const cronName of [...nombres].sort((a, b) => a.localeCompare(b))) {
    const estado = juzgarLatido(porNombre.get(cronName) ?? null, cadencias[cronName] ?? 0, ahora);
    if (estado === "ok") conteo.ok += 1;
    else {
      if (estado === "vencido") conteo.vencido += 1;
      else if (estado === "sin_latido") conteo.sinLatido += 1;
      else conteo.error += 1;
      conProblema.push({ cronName, estado });
    }
  }
  return { estado: "medido", total: nombres.size, ...conteo, conProblema };
}

export interface EstadoRateLimiter {
  /** `distribuido` = Redis (Upstash) configurado; `memoria` = por instancia
   *  (degradación documentada de @atiende/core-ratelimit). Solo CONFIGURACIÓN: no
   *  hace ninguna llamada de red al Redis desde /health. */
  readonly modo: "distribuido" | "memoria";
}

export function estadoRateLimiter(env: Readonly<Record<string, string | undefined>> = process.env): EstadoRateLimiter {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return { modo: url && token ? "distribuido" : "memoria" };
}

export interface InfoVersion {
  readonly commit: string | null;
  readonly entorno: string | null;
}

/** Commit corto (7) y entorno de Vercel; `null` si no corre en Vercel (local/tests). */
export function infoVersion(env: Readonly<Record<string, string | undefined>> = process.env): InfoVersion {
  const sha = env.VERCEL_GIT_COMMIT_SHA?.trim();
  return { commit: sha ? sha.slice(0, 7) : null, entorno: env.VERCEL_ENV?.trim() || null };
}
