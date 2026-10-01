import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { buildApp } from "../src/app.ts";
import { CABECERAS_SEGURIDAD_API, cabecerasSeguridadApi } from "../src/cabeceras-seguridad.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

function esperarCabeceras(res: Response): void {
  for (const [nombre, valor] of Object.entries(CABECERAS_SEGURIDAD_API)) {
    expect(res.headers.get(nombre), nombre).toBe(valor);
  }
}

describe("cabeceras de seguridad de la API", () => {
  it("el conjunto exigido está completo y es enforcing (HSTS, nosniff, anti-framing, referrer, permissions, COOP, CSP)", () => {
    expect(Object.keys(CABECERAS_SEGURIDAD_API).sort()).toEqual(
      [
        "Content-Security-Policy",
        "Cross-Origin-Opener-Policy",
        "Permissions-Policy",
        "Referrer-Policy",
        "Strict-Transport-Security",
        "X-Content-Type-Options",
        "X-Frame-Options",
      ].sort(),
    );
    expect(CABECERAS_SEGURIDAD_API["Strict-Transport-Security"]).toMatch(/max-age=\d{8,}/);
    expect(CABECERAS_SEGURIDAD_API["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("las rutas reales de la API las devuelven: /health (200), login (200 y 401), ruta protegida sin token (401) y ruta inexistente (404)", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    const respuestas = [
      await app.request("/health"),
      await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword })),
      await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: "incorrecta" })),
      await app.request("/auth/me"),
      await app.request("/superadmin/salud"),
      await app.request("/ruta-que-no-existe"),
    ];
    expect(respuestas.map((r) => r.status)).toEqual([expect.any(Number), 200, 401, 401, 401, 404]);
    for (const res of respuestas) esperarCabeceras(res);
  });

  it("también en un 500 (error interno no controlado) y en /health degradado (503)", async () => {
    const { deps } = await buildTestDeps();
    const conBdCaida = buildApp({
      ...deps,
      engine: {
        async withAppSession() {
          throw new Error("bd caida");
        },
      },
    });
    const health = await conBdCaida.request("/health");
    expect(health.status).toBe(503);
    esperarCabeceras(health);

    const app = new Hono();
    app.use("*", cabecerasSeguridadApi());
    app.onError((_e, c) => c.json({ code: "internal_error" }, 500));
    app.get("/boom", () => {
      throw new Error("x");
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    esperarCabeceras(res);
  });

  it("no pisa una cabecera que la ruta fijó a propósito", async () => {
    const app = new Hono();
    app.use("*", cabecerasSeguridadApi());
    app.get("/x", (c) => {
      c.header("X-Frame-Options", "SAMEORIGIN");
      return c.text("ok");
    });
    const res = await app.request("/x");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
