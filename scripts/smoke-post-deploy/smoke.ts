// Smoke test post-deploy (PL-11). Solo hace peticiones SIN credenciales a una URL ya desplegada y comprueba
// que lo esencial responde como se espera. No usa secretos, no escribe datos (el unico POST es un login
// con credenciales inexistentes, que debe dar 401 y nunca crea nada) y no mira nada de produccion mas alla
// de lo que cualquier visitante ve.
//
// Uso:   node --experimental-strip-types scripts/smoke-post-deploy/smoke.ts https://tu-dominio [--api-only]
//        (o SMOKE_BASE_URL=... en el entorno). Sale con codigo 1 si falla cualquier comprobacion.
// Pruebas: apps/api/tests/smoke-post-deploy.spec.ts ejecuta `runSmoke` contra la app Hono real en proceso.
import { pathToFileURL } from "node:url";

export interface SmokeCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export type SmokeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SmokeOptions {
  /** Comprobar tambien que la SPA (`/`) responde HTML. Falso para probar solo la API en proceso. */
  readonly checkSpa?: boolean;
  readonly fetchImpl?: SmokeFetch;
  readonly timeoutMs?: number;
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
  const base = args.find((a) => !a.startsWith("--")) ?? process.env.SMOKE_BASE_URL;
  if (!base || !/^https?:\/\//.test(base)) {
    console.error("Falta la URL base: smoke.ts https://tu-dominio  (o SMOKE_BASE_URL)");
    process.exit(2);
  }
  const results = await runSmoke(base, { checkSpa: !apiOnly });
  for (const r of results) console.log(`${r.ok ? "OK  " : "FALLA"} ${r.name} -- ${r.detail}`);
  const fallos = results.filter((r) => !r.ok).length;
  console.log(fallos === 0 ? `\nSmoke OK (${results.length} comprobaciones)` : `\nSmoke FALLO: ${fallos} de ${results.length}`);
  process.exit(fallos === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
