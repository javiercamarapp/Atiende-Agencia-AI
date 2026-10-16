// PL-12. Sondeo de salud de PRODUCCION: GET {base}/health anonimo (el mismo endpoint publico que ya usa
// scripts/smoke-post-deploy). Solo lectura, sin secretos, sin escribir nada. NO envia alertas: su unico efecto
// es el codigo de salida y el texto que imprime; quien lo corre (el workflow prod-health.yml) decide el aviso.
//
// Ademas de que la API responda, vigila la senal agregada `crons` del /health publico ("ok" | "atrasados" | "sin_latido" |
// "sin_medir", ver apps/api/src/salud/health.ts): si NO es "ok" en DOS sondeos seguidos (separados `esperaCronsMs`, mas que el cache de
// 5 s del endpoint) el resultado es no sano. Un /health sin el campo `crons` (version anterior desplegada) no falla: se anota.
//
// Uso:   node --experimental-strip-types scripts/health-check/check.ts https://tu-dominio
//        (o HEALTH_BASE_URL=... en el entorno). Salida 0 = sano, 1 = degradado/caido/crons sin correr, 2 = uso incorrecto.
// Pruebas: packages/db/tests/ci-pl12-guards.spec.ts ejercita `sondearSalud` con un fetch inyectado.
import { pathToFileURL } from "node:url";

export type SaludFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ResultadoSalud {
  readonly ok: boolean;
  readonly detalle: string;
  /** Valor de `crons` del cuerpo del /health; `undefined` si el cuerpo no lo trae. */
  readonly crons?: string;
}

export interface OpcionesSalud {
  readonly fetchImpl?: SaludFetch;
  readonly timeoutMs?: number;
  readonly intentos?: number;
  readonly esperaMs?: number;
  /** Sondeo lento pero 200: se reporta como no sano si supera esto. */
  readonly maxLatenciaMs?: number;
  readonly dormir?: (ms: number) => Promise<void>;
  /** Espera entre los dos sondeos de la senal de crons (por defecto 6 s: mas que el cache publico de 5 s del /health). */
  readonly esperaCronsMs?: number;
}

async function unIntento(base: string, o: Required<Pick<OpcionesSalud, "timeoutMs" | "maxLatenciaMs">>, doFetch: SaludFetch): Promise<ResultadoSalud> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(o.timeoutMs), redirect: "manual" });
  } catch (err) {
    return { ok: false, detalle: `sin respuesta: ${err instanceof Error ? err.name : "error"}` };
  }
  const ms = Date.now() - t0;
  if (res.status !== 200) return { ok: false, detalle: `HTTP ${res.status} (la API reporta degradado o caido)` };
  let cuerpo: { ok?: unknown; crons?: unknown };
  try {
    cuerpo = (await res.json()) as { ok?: unknown; crons?: unknown };
  } catch {
    return { ok: false, detalle: "HTTP 200 pero el cuerpo no es JSON" };
  }
  if (cuerpo.ok !== true) return { ok: false, detalle: "HTTP 200 pero el cuerpo no trae ok:true" };
  if (ms > o.maxLatenciaMs) return { ok: false, detalle: `responde, pero lento: ${ms} ms > ${o.maxLatenciaMs} ms` };
  return { ok: true, detalle: `200 ok en ${ms} ms`, ...(typeof cuerpo.crons === "string" ? { crons: cuerpo.crons } : {}) };
}

function explicarCrons(estado: string): string {
  if (estado === "sin_latido") return "crons SIN LATIDO: al menos un cron de alta frecuencia nunca dejo latido (el scheduler no esta corriendo; revisa CRON_SECRET = INTERNAL_SECRET y el plan Pro en Vercel)";
  if (estado === "atrasados") return "crons ATRASADOS: algun cron lleva mas de 3 veces su cadencia sin dejar latido";
  if (estado === "sin_medir") return "crons SIN MEDIR: no se pudo leer la tabla de latidos (migracion pendiente o error de la base)";
  return `crons en estado desconocido '${estado}'`;
}

/** Reintenta para no avisar por un parpadeo de red o un arranque en frio; falla solo si TODOS los intentos fallan. */
export async function sondearSalud(baseUrl: string, opciones: OpcionesSalud = {}): Promise<ResultadoSalud> {
  const base = baseUrl.replace(/\/+$/, "");
  if (!base.startsWith("https://")) return { ok: false, detalle: `URL invalida (se exige https://): '${base}'` };
  const intentos = opciones.intentos ?? 3;
  const esperaMs = opciones.esperaMs ?? 10_000;
  const dormir = opciones.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const doFetch: SaludFetch = opciones.fetchImpl ?? ((url, init) => fetch(url, init));
  let ultimo: ResultadoSalud = { ok: false, detalle: "sin intentos" };
  for (let i = 1; i <= intentos; i += 1) {
    const o = { timeoutMs: opciones.timeoutMs ?? 10_000, maxLatenciaMs: opciones.maxLatenciaMs ?? 8_000 };
    ultimo = await unIntento(base, o, doFetch);
    if (ultimo.ok) {
      const detalle = `${ultimo.detalle} (intento ${i}/${intentos})`;
      if (ultimo.crons === undefined) return { ok: true, detalle: `${detalle}; el /health no trae la senal de crons (version anterior)` };
      if (ultimo.crons === "ok") return { ok: true, detalle: `${detalle}; crons ok`, crons: "ok" };
      // La senal de crons no es "ok": se confirma con un segundo sondeo antes de fallar (un solo dato malo no alarma).
      await dormir(opciones.esperaCronsMs ?? 6_000);
      const segundo = await unIntento(base, o, doFetch);
      if (segundo.ok && segundo.crons === "ok") return { ok: true, detalle: `${detalle}; crons ok en el segundo sondeo (el primero dijo '${ultimo.crons}')`, crons: "ok" };
      const estado = segundo.ok ? (segundo.crons ?? "desconocido") : ultimo.crons;
      return { ok: false, detalle: `${explicarCrons(estado)} en 2 sondeos seguidos`, crons: estado };
    }
    if (i < intentos) await dormir(esperaMs);
  }
  return { ok: false, detalle: `${ultimo.detalle} (tras ${intentos} intentos)` };
}

/** Punto de entrada testeable: devuelve el codigo de salida y escribe con `salida`/`error` (por defecto consola). */
export async function main(
  argv: readonly string[] = process.argv,
  env: Readonly<Record<string, string | undefined>> = process.env,
  opciones: OpcionesSalud = {},
  io: { salida: (t: string) => void; error: (t: string) => void } = { salida: (t) => console.log(t), error: (t) => console.error(t) },
): Promise<number> {
  const base = argv[2] ?? env.HEALTH_BASE_URL ?? "";
  if (!base) {
    io.error("Uso: check.ts https://tu-dominio  (o HEALTH_BASE_URL)");
    return 2;
  }
  const r = await sondearSalud(base, opciones);
  io.salida(`${r.ok ? "SANO" : "NO SANO"}: ${r.detalle}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
