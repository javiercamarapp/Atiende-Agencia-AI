// PL-12. Sondeo de salud de PRODUCCION: GET {base}/health anonimo (el mismo endpoint publico que ya usa
// scripts/smoke-post-deploy). Solo lectura, sin secretos, sin escribir nada. NO envia alertas: su unico efecto
// es el codigo de salida y el texto que imprime; quien lo corre (el workflow prod-health.yml) decide el aviso.
//
// Uso:   node --experimental-strip-types scripts/health-check/check.ts https://tu-dominio
//        (o HEALTH_BASE_URL=... en el entorno). Salida 0 = sano, 1 = degradado/caido, 2 = uso incorrecto.
// Pruebas: packages/db/tests/ci-pl12-guards.spec.ts ejercita `sondearSalud` con un fetch inyectado.
import { pathToFileURL } from "node:url";

export type SaludFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ResultadoSalud {
  readonly ok: boolean;
  readonly detalle: string;
}

export interface OpcionesSalud {
  readonly fetchImpl?: SaludFetch;
  readonly timeoutMs?: number;
  readonly intentos?: number;
  readonly esperaMs?: number;
  /** Sondeo lento pero 200: se reporta como no sano si supera esto. */
  readonly maxLatenciaMs?: number;
  readonly dormir?: (ms: number) => Promise<void>;
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
  let cuerpo: { ok?: unknown };
  try {
    cuerpo = (await res.json()) as { ok?: unknown };
  } catch {
    return { ok: false, detalle: "HTTP 200 pero el cuerpo no es JSON" };
  }
  if (cuerpo.ok !== true) return { ok: false, detalle: "HTTP 200 pero el cuerpo no trae ok:true" };
  if (ms > o.maxLatenciaMs) return { ok: false, detalle: `responde, pero lento: ${ms} ms > ${o.maxLatenciaMs} ms` };
  return { ok: true, detalle: `200 ok en ${ms} ms` };
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
    ultimo = await unIntento(base, { timeoutMs: opciones.timeoutMs ?? 10_000, maxLatenciaMs: opciones.maxLatenciaMs ?? 8_000 }, doFetch);
    if (ultimo.ok) return { ok: true, detalle: `${ultimo.detalle} (intento ${i}/${intentos})` };
    if (i < intentos) await dormir(esperaMs);
  }
  return { ok: false, detalle: `${ultimo.detalle} (tras ${intentos} intentos)` };
}

async function main(): Promise<number> {
  const base = process.argv[2] ?? process.env.HEALTH_BASE_URL ?? "";
  if (!base) {
    console.error("Uso: check.ts https://tu-dominio  (o HEALTH_BASE_URL)");
    return 2;
  }
  const r = await sondearSalud(base);
  console.log(`${r.ok ? "SANO" : "NO SANO"}: ${r.detalle}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
