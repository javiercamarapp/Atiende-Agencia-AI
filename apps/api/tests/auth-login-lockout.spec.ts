// PL-09: bloqueo temporal por intentos de login fallidos (IP+correo) con backoff y respuestas uniformes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const IP_A = { "x-forwarded-for": "198.51.100.10" };
const IP_B = { "x-forwarded-for": "198.51.100.20" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

async function fail(app: ReturnType<typeof buildApp>, email: string, headers = IP_A) {
  return app.request("/auth/login", jsonRequestInit({ email, password: "incorrecta" }, headers));
}

describe("POST /auth/login -- bloqueo por intentos fallidos", () => {
  it("a los 5 fallos la llave IP+correo queda bloqueada: 429 con Retry-After, incluso con la contraseña correcta", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    for (let i = 0; i < 5; i += 1) expect((await fail(app, ownerEmail)).status).toBe(401);

    const bloqueado = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }, IP_A));
    expect(bloqueado.status).toBe(429);
    expect(Number(bloqueado.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(((await bloqueado.json()) as { code: string }).code).toBe("too_many_requests");
  });

  it("no enumera cuentas: correo inexistente se bloquea igual y con la MISMA respuesta que uno existente", async () => {
    const { deps, ownerEmail } = await buildTestDeps();
    const app = buildApp(deps);
    for (let i = 0; i < 5; i += 1) {
      await fail(app, ownerEmail);
      await fail(app, "no-existe@x.mx");
    }
    const real = await fail(app, ownerEmail);
    const fantasma = await fail(app, "no-existe@x.mx");
    expect(real.status).toBe(429);
    expect(fantasma.status).toBe(429);
    expect(await real.json()).toEqual(await fantasma.json());
    expect(real.headers.get("retry-after")).toBe(fantasma.headers.get("retry-after"));
  });

  it("el bloqueo es por IP+correo: otra IP u otro correo no quedan bloqueados", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    for (let i = 0; i < 5; i += 1) await fail(app, ownerEmail, IP_A);
    const otraIp = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }, IP_B));
    expect(otraIp.status).toBe(200);
    expect((await fail(app, "otro@x.mx", IP_A)).status).toBe(401);
  });

  it("backoff: tras vencer el primer bloqueo (30 s) un nuevo fallo bloquea el doble; el login correcto reinicia", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    for (let i = 0; i < 5; i += 1) await fail(app, ownerEmail);
    expect((await fail(app, ownerEmail)).status).toBe(429);

    vi.setSystemTime(Date.now() + 31_000);
    expect((await fail(app, ownerEmail)).status).toBe(401); // el 6º fallo: 401 y ahora bloquea 60 s
    const segundo = await fail(app, ownerEmail);
    expect(segundo.status).toBe(429);
    expect(Number(segundo.headers.get("retry-after"))).toBeGreaterThan(30);

    vi.setSystemTime(Date.now() + 61_000);
    const ok = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }, IP_A));
    expect(ok.status).toBe(200);
    // El éxito borró el conteo: hacen falta otros 5 fallos para volver a bloquear (se avanza el reloj
    // fuera de la ventana de 5 min del rate limit, que cuenta TODOS los intentos y es otra defensa).
    vi.setSystemTime(Date.now() + 6 * 60_000);
    for (let i = 0; i < 4; i += 1) expect((await fail(app, ownerEmail)).status).toBe(401);
  });

  it("no-regresion: 4 fallos seguidos de un login correcto no bloquean y la sesión emitida funciona en /auth/me", async () => {
    const { deps, ownerEmail, ownerPassword } = await buildTestDeps();
    const app = buildApp(deps);
    for (let i = 0; i < 4; i += 1) await fail(app, ownerEmail);
    const ok = await app.request("/auth/login", jsonRequestInit({ email: ownerEmail, password: ownerPassword }, IP_A));
    expect(ok.status).toBe(200);
    const { token } = (await ok.json()) as { token: string };
    expect((await app.request("/auth/me", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});
