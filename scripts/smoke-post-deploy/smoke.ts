// Smoke test post-deploy (PL-11). Solo hace peticiones SIN credenciales a una URL ya desplegada y comprueba
// que lo esencial responde como se espera. No usa secretos, no escribe datos (el unico POST es un login
// con credenciales inexistentes, que debe dar 401 y nunca crea nada) y no mira nada de produccion mas alla
// de lo que cualquier visitante ve.
//
// Uso:   node --experimental-strip-types scripts/smoke-post-deploy/smoke.ts https://tu-dominio [--api-only]
//        (o SMOKE_BASE_URL=... en el entorno). Sale con codigo 1 si falla cualquier comprobacion.
// Pruebas: apps/api/tests/smoke-post-deploy.spec.ts ejecuta `runSmoke` contra la app Hono real en proceso.
//
// Migraciones (Ola 4, G4): con SMOKE_INTERNAL_SECRET en el entorno, pide el DETALLE de /health (que trae las versiones
// aplicadas, `core.migraciones_aplicadas()`) y lo compara con `supabase/migrations/` de este checkout. Si la base va por
// detrás, AVISA con el conteo (nunca la lista: los logs de Actions de un repo público son públicos; `--detalle` la
// imprime en una corrida local). Un aviso no cambia el código de salida salvo con `--estricto`. Sin el secreto la
// comprobación queda "sin medir" (aviso honesto), nunca "al día".
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface SmokeCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** Advertencia que no tumba el smoke (salvo `--estricto`): hoy solo la de migraciones. */
  readonly aviso?: boolean;
  /** Versiones que faltan en la base (solo para `--detalle`; nunca se imprimen por omisión). */
  readonly faltan?: readonly string[];
}

export type SmokeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SmokeOptions {
  /** Comprobar tambien que la SPA (`/`) responde HTML. Falso para probar solo la API en proceso. */
  readonly checkSpa?: boolean;
  readonly fetchImpl?: SmokeFetch;
  readonly timeoutMs?: number;
  /** Comparar migraciones aplicadas contra el repo. `secreto: null` -> "sin medir". */
  readonly migraciones?: { readonly secreto: string | null; readonly versionesRepo: readonly string[] };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Versiones (prefijo de 14 dígitos) de `supabase/migrations/` de este checkout, ordenadas. */
export function versionesDelRepo(dir: string = path.join(HERE, "..", "..", "supabase", "migrations")): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.split("_")[0] ?? "")
    .filter((v) => /^\d{14}$/.test(v))
    .sort();
}

/** Versiones del repo que la base no tiene aplicadas (incluye huecos por debajo de la máxima aplicada). */
export function compararMigraciones(repo: readonly string[], aplicadas: readonly string[]): { alDia: boolean; faltan: string[] } {
  const hechas = new Set(aplicadas);
  const faltan = [...new Set(repo)].filter((v) => !hechas.has(v)).sort();
  return { alDia: faltan.length === 0, faltan };
}

/** 1 si alguna comprobación falló, o si hay avisos y se pidió `estricto`. */
export function codigoDeSalida(results: readonly SmokeCheck[], opts: { readonly estricto: boolean }): 0 | 1 {
  if (results.some((r) => !r.ok)) return 1;
  if (opts.estricto && results.some((r) => r.aviso)) return 1;
  return 0;
}

const EVIL_ORIGIN = "https://smoke-origen-ajeno.invalid";

async function check(name: string, fn: () => Promise<string>): Promise<SmokeCheck> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function expectStatus(res: Response, expected: number | readonly number[]): void {
  const lista = typeof expected === "number" ? [expected] : expected;
  if (!lista.includes(res.status)) throw new Error(`status ${res.status}, se esperaba ${lista.join(" o ")}`);
}

export async function runSmoke(baseUrl: string, options: SmokeOptions = {}): Promise<SmokeCheck[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const doFetch: SmokeFetch = options.fetchImpl ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" }));
  const loginBody = JSON.stringify({ email: "smoke-post-deploy@no-existe.invalid", password: "contrasena-que-no-existe" });
  const postLogin = (headers: Record<string, string>) =>
    doFetch(`${base}/auth/login`, {
      method: "POST",
      body: loginBody,
      headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(loginBody).byteLength), ...headers },
    });

  const results: SmokeCheck[] = [];

  results.push(
    await check("GET /health responde 200 y {ok:true}", async () => {
      const res = await doFetch(`${base}/health`);
      expectStatus(res, 200);
      const body = (await res.json()) as { ok?: unknown };
      if (body.ok !== true) throw new Error("el cuerpo no trae ok:true");
      return "200 ok";
    }),
  );

  results.push(
    await check("cabeceras de seguridad en la API (nosniff, HSTS, anti-framing)", async () => {
      const res = await doFetch(`${base}/health`);
      const faltan = ["x-content-type-options", "strict-transport-security", "x-frame-options"].filter((h) => !res.headers.get(h));
      if (faltan.length > 0) throw new Error(`faltan: ${faltan.join(", ")}`);
      return "presentes";
    }),
  );

  results.push(
    await check("POST /auth/login con credenciales inexistentes da 401 JSON (nunca 5xx)", async () => {
      const res = await postLogin({});
      expectStatus(res, [401, 429]);
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code !== "string") throw new Error("el cuerpo de error no trae `code`");
      return `${res.status} ${body.code}`;
    }),
  );

  results.push(
    await check("POST /auth/login desde un origen ajeno se rechaza con 403 (guarda de Origin)", async () => {
      const res = await postLogin({ origin: EVIL_ORIGIN });
      expectStatus(res, 403);
      return "403";
    }),
  );

  results.push(
    await check("GET /auth/me sin token da 401", async () => {
      const res = await doFetch(`${base}/auth/me`);
      expectStatus(res, 401);
      return "401";
    }),
  );

  if (options.migraciones) {
    const { secreto, versionesRepo } = options.migraciones;
    results.push(
      await (async (): Promise<SmokeCheck> => {
        const name = "migraciones: la base no va por detrás del repo";
        if (!secreto) return { name, ok: true, aviso: true, detail: "sin medir: falta SMOKE_INTERNAL_SECRET (el detalle de /health lo exige)" };
        try {
          const res = await doFetch(`${base}/health`, { headers: { "x-atiende-internal-secret": secreto } });
          const body = (await res.json()) as { migraciones?: { estado?: string; motivo?: string; aplicadas?: unknown } };
          const m = body.migraciones;
          if (!m) return { name, ok: true, aviso: true, detail: "sin medir: /health no trajo `migraciones` (¿secreto incorrecto o API anterior a la 0101?)" };
          if (m.estado !== "medido" || !Array.isArray(m.aplicadas)) return { name, ok: true, aviso: true, detail: `sin medir: ${m.motivo ?? "desconocido"}` };
          const { alDia, faltan } = compararMigraciones(versionesRepo, m.aplicadas.map(String));
          if (alDia) return { name, ok: true, aviso: false, detail: `al día (${versionesRepo.length} migraciones del repo aplicadas)` };
          return { name, ok: true, aviso: true, faltan, detail: `AVISO: la base va ${faltan.length} migraciones por detrás del repo (aplica con supabase db push; ver docs/DEPLOY.md)` };
        } catch (err) {
          return { name, ok: true, aviso: true, detail: `sin medir: ${err instanceof Error ? err.message : String(err)}` };
        }
      })(),
    );
  }

  if (options.checkSpa) {
    results.push(
      await check("GET / sirve la SPA (HTML)", async () => {
        const res = await doFetch(`${base}/`, { headers: { accept: "text/html" } });
        expectStatus(res, 200);
        const tipo = res.headers.get("content-type") ?? "";
        if (!tipo.includes("text/html")) throw new Error(`content-type ${tipo}`);
        return "200 text/html";
      }),
    );
  }

  return results;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apiOnly = args.includes("--api-only");
  const estricto = args.includes("--estricto");
  const detalle = args.includes("--detalle");
  const base = args.find((a) => !a.startsWith("--")) ?? process.env.SMOKE_BASE_URL;
  if (!base || !/^https?:\/\//.test(base)) {
    console.error("Falta la URL base: smoke.ts https://tu-dominio  (o SMOKE_BASE_URL)");
    process.exit(2);
  }
  const results = await runSmoke(base, {
    checkSpa: !apiOnly,
    migraciones: { secreto: process.env.SMOKE_INTERNAL_SECRET || null, versionesRepo: versionesDelRepo() },
  });
  for (const r of results) {
    console.log(`${!r.ok ? "FALLA" : r.aviso ? "AVISO" : "OK  "} ${r.name} -- ${r.detail}`);
    if (detalle && r.faltan && r.faltan.length > 0) console.log(`      faltan: ${r.faltan.join(", ")}`);
  }
  const fallos = results.filter((r) => !r.ok).length;
  const avisos = results.filter((r) => r.ok && r.aviso).length;
  console.log(
    fallos === 0
      ? `\nSmoke OK (${results.length} comprobaciones${avisos > 0 ? `, ${avisos} aviso(s)${estricto ? " -- --estricto los trata como fallo" : ""}` : ""})`
      : `\nSmoke FALLO: ${fallos} de ${results.length}`,
  );
  process.exit(codigoDeSalida(results, { estricto }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
