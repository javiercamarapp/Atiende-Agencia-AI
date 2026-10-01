// PL-11: el smoke post-deploy se ejecuta contra la app Hono REAL en proceso, para que el script no pueda
// quedar desalineado de la API (si cambia una ruta o una guarda, esta prueba falla antes del deploy).
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { runSmoke } from "../../../scripts/smoke-post-deploy/smoke.ts";
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

  it("un fallo de red se reporta como comprobacion fallida, no como excepcion", async () => {
    const caido = () => Promise.reject(new Error("ECONNREFUSED"));
    const results = await runSmoke("https://smoke.test", { fetchImpl: caido });
    expect(results.every((r) => !r.ok && r.detail.includes("ECONNREFUSED"))).toBe(true);
  });
});
