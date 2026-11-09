// PL-11: el smoke post-deploy se ejecuta contra la app Hono REAL en proceso, para que el script no pueda
// quedar desalineado de la API (si cambia una ruta o una guarda, esta prueba falla antes del deploy).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { describirRedireccion, opcionesCli, runSmoke } from "../../../scripts/smoke-post-deploy/smoke.ts";
import { buildTestDeps } from "./fixtures.ts";

async function appFetch() {
  const { deps } = await buildTestDeps();
  // La BD en memoria de los fixtures no contesta `select 1` (el /health real responderia 503): se inyecta un
  // motor que si contesta, igual que health.spec.ts, para ejercitar el resto del smoke sin mockear la API.
  const engine: TenancyEngine = {
    async withAppSession<T>(_claims: { userId: string | null }, fn: (s: TenantDbSession) => Promise<T>): Promise<T> {
      return fn({ query: async <R>() => ({ rows: [] as R[] }), exec: async () => undefined });
    },
  };
  const app = buildApp({ ...deps, engine });
  return (url: string, init?: RequestInit) => {
    const u = new URL(url);
    return Promise.resolve(app.request(u.pathname + u.search, init));
  };
}

describe("scripts/smoke-post-deploy", () => {
  it("contra la API real en proceso todas las comprobaciones pasan", async () => {
    const results = await runSmoke("https://smoke.test", { fetchImpl: await appFetch() });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(5);
  });

  it("detecta un despliegue roto: si /health responde 503 el smoke falla (y lo dice)", async () => {
    const real = await appFetch();
    const roto = (url: string, init?: RequestInit) =>
      new URL(url).pathname === "/health" ? Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 503 })) : real(url, init);
    const results = await runSmoke("https://smoke.test", { fetchImpl: roto });
    const health = results.find((r) => r.name.startsWith("GET /health"));
    expect(health?.ok).toBe(false);
    expect(health?.detail).toContain("503");
  });

  it("detecta que la guarda de origen NO esta desplegada (login ajeno no da 403)", async () => {
    const real = await appFetch();
    const sinGuarda = (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.delete("origin");
      return real(url, { ...init, headers });
    };
    const results = await runSmoke("https://smoke.test", { fetchImpl: sinGuarda });
    expect(results.find((r) => r.name.includes("origen ajeno"))?.ok).toBe(false);
  });

  it("detecta que falta la SPA cuando se pide comprobarla", async () => {
    const results = await runSmoke("https://smoke.test", { fetchImpl: await appFetch(), checkSpa: true });
    expect(results.find((r) => r.name.includes("SPA"))?.ok).toBe(false);
  });

  it("la proteccion de despliegues de Vercel (302 a vercel.com/sso-api, causa del rojo desde el 6-oct) se nombra en cada fallo", async () => {
    const protegido = () =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: "https://vercel.com/sso-api?url=https%3A%2F%2Fx.vercel.app%2Fhealth&nonce=abc" } }));
    const results = await runSmoke("https://atiende-abc123.vercel.app", { fetchImpl: protegido, checkSpa: true });
    expect(results.every((r) => !r.ok)).toBe(true);
    for (const r of results.filter((x) => !x.name.startsWith("POST /auth/login con"))) {
      expect(r.detail, r.name).toContain("proteccion de despliegues de Vercel");
      // nunca se imprime la query de la redireccion (trae la URL del despliegue y un nonce)
      expect(r.detail, r.name).not.toContain("nonce");
    }
  });

  it("describirRedireccion: solo 3xx; Vercel por host; otras redirecciones sin query", () => {
    const r = (status: number, location?: string) => ({ status, headers: new Headers(location ? { location } : {}) });
    expect(describirRedireccion(r(200))).toBeNull();
    expect(describirRedireccion(r(401))).toBeNull();
    expect(describirRedireccion(r(307, "https://vercel.com/login?next=x"))).toContain("Vercel");
    expect(describirRedireccion(r(302, "https://otro.example/entrar?token=secreto"))).toBe("status 302 (redireccion a /entrar)");
    expect(describirRedireccion(r(308, "/nueva"))).toBe("status 308 (redireccion a /nueva)");
    expect(describirRedireccion(r(302))).toBe("status 302 (redireccion a ?)");
  });

  it("un fallo de red se reporta como comprobacion fallida, no como excepcion", async () => {
    const caido = () => Promise.reject(new Error("ECONNREFUSED"));
    const results = await runSmoke("https://smoke.test", { fetchImpl: caido });
    expect(results.every((r) => !r.ok && r.detail.includes("ECONNREFUSED"))).toBe(true);
  });
});

// Tras un deploy a Produccion el smoke tambien exige que la senal agregada `crons` del /health publico sea "ok":
// un deploy que deja los crons sin latido (CRON_SECRET distinto, plan sin crons) responde 200 en todo lo demas.
describe("scripts/smoke-post-deploy: /health con crons ok", () => {
  async function conHealth(cuerpo: Record<string, unknown>) {
    const real = await appFetch();
    return (url: string, init?: RequestInit) =>
      new URL(url).pathname === "/health"
        ? Promise.resolve(
            new Response(JSON.stringify(cuerpo), {
              status: 200,
              headers: { "content-type": "application/json", "x-content-type-options": "nosniff", "strict-transport-security": "max-age=63072000", "x-frame-options": "DENY" },
            }),
          )
        : real(url, init);
  }

  it("con exigirCrons, crons='sin_latido' hace fallar la comprobacion de /health y explica la causa", async () => {
    const results = await runSmoke("https://smoke.test", { fetchImpl: await conHealth({ ok: true, crons: "sin_latido" }), exigirCrons: true });
    const health = results.find((r) => r.name.startsWith("GET /health"));
    expect(health?.ok).toBe(false);
    expect(health?.detail).toContain("SIN LATIDO");
  });

  it("con exigirCrons, un /health sin el campo crons tambien falla (no se puede afirmar que corren)", async () => {
    const results = await runSmoke("https://smoke.test", { fetchImpl: await conHealth({ ok: true }), exigirCrons: true });
    expect(results.find((r) => r.name.startsWith("GET /health"))?.ok).toBe(false);
  });

  it("con exigirCrons, crons='ok' pasa", async () => {
    const results = await runSmoke("https://smoke.test", { fetchImpl: await conHealth({ ok: true, crons: "ok" }), exigirCrons: true });
    const health = results.find((r) => r.name.startsWith("GET /health"));
    expect(health?.ok).toBe(true);
    expect(health?.detail).toContain("crons ok");
  });

  it("la linea de comandos (lo que corre el workflow tras el deploy) exige crons y la SPA por omision", () => {
    expect(opcionesCli(["https://app.example"])).toMatchObject({ checkSpa: true, exigirCrons: true });
    expect(opcionesCli(["https://app.example", "--api-only"])).toMatchObject({ checkSpa: false, exigirCrons: true });
  });
});

describe(".github/workflows/smoke-post-deploy.yml", () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const yml = readFileSync(path.join(REPO, ".github", "workflows", "smoke-post-deploy.yml"), "utf8");
  const pasos = yml.slice(yml.indexOf("\njobs:"));

  it("tras un deploy a Produccion sondea PROD_BASE_URL (alias), nunca la URL unica del despliegue protegida por SSO", () => {
    expect(pasos).toContain("vars.PROD_BASE_URL");
    expect(pasos).not.toMatch(/deployment_status\.target_url|deployment_status\.environment_url/);
    expect(pasos).toContain("github.event.deployment.environment == 'Production'");
  });

  it("corre el smoke completo (sin --api-only): /health con crons, cabeceras, /auth/me 401 y la SPA", () => {
    expect(pasos).toContain("scripts/smoke-post-deploy/smoke.ts");
    expect(pasos).not.toContain("--api-only");
  });
});
