// Rastreo de errores no controlados (500) hacia Sentry: se activa solo con SENTRY_DSN, sale redactado
// (sin PII, sin cuerpo/cabeceras/query/usuario), nunca rompe la respuesta y tiene tope por minuto.
// Ninguna prueba hace red real: `fetchImpl` inyectado.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { crearReportadorErrores, eventoDeError, marcosDePila, rutaSinIdentificadores } from "../src/observabilidad/errores-sentry.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

afterEach(() => vi.restoreAllMocks());

const DSN = "https://clavepublica@o123.ingest.us.sentry.io/4507";
const T = new Date("2026-11-07T12:00:00.000Z");

function capturador(status = 200) {
  const llamadas: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    llamadas.push({ url, init });
    return new Response("{}", { status });
  };
  const evento = (i = 0) => JSON.parse(String(llamadas[i]!.init.body).trim().split("\n")[2]!) as Record<string, unknown>;
  return { llamadas, fetchImpl, evento };
}

describe("activacion", () => {
  it("sin DSN, vacio o invalido: no hay reportador (la API se comporta como antes)", () => {
    expect(crearReportadorErrores(undefined)).toBeUndefined();
    expect(crearReportadorErrores("")).toBeUndefined();
    expect(crearReportadorErrores("no-es-un-dsn")).toBeUndefined();
    expect(crearReportadorErrores("http://clave@sentry.example/1")).toBeUndefined();
  });
  it("con DSN valido envia un envelope al endpoint del proyecto con la clave publica", async () => {
    const c = capturador();
    const r = crearReportadorErrores(DSN, { fetchImpl: c.fetchImpl, ahora: () => T, entorno: "production", release: "abc1234" })!;
    expect(await r.reportar(new Error("fallo"), { method: "get", path: "/v1/x" })).toBe(true);
    expect(c.llamadas[0]!.url).toBe("https://o123.ingest.us.sentry.io/api/4507/envelope/");
    const headers = c.llamadas[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-sentry-envelope");
    expect(headers["X-Sentry-Auth"]).toContain("sentry_key=clavepublica");
    expect(c.evento()).toMatchObject({ level: "error", platform: "node", environment: "production", release: "abc1234", transaction: "GET /v1/x" });
  });
});

describe("redaccion", () => {
  it("el mensaje sale sin correos, telefonos ni tokens", () => {
    const ev = eventoDeError(new Error("fallo para maria@example.com tel +52 55 9876 5432 token=abcd1234efgh5678"), {}, { eventId: "e", ahora: T, entorno: null, release: null });
    const texto = JSON.stringify(ev);
    for (const s of ["maria@example.com", "9876 5432", "abcd1234efgh5678"]) expect(texto).not.toContain(s);
    expect(ev.exception.values[0]!.type).toBe("Error");
  });
  it("la ruta pierde query, UUID, numeros, correos y segmentos con pinta de token", () => {
    expect(rutaSinIdentificadores("/restaurantes/3f2c1a9e-1b2c-4d5e-8f90-1234567890ab/pedidos/42?telefono=5512345678")).toBe("/restaurantes/:id/pedidos/:id");
    expect(rutaSinIdentificadores("/portal-cliente/aB3dEf9hIj2kLm4nOp6q/documentos")).toBe("/portal-cliente/:token/documentos");
    expect(rutaSinIdentificadores("/x/ana@example.com")).toBe("/x/:token");
    expect(rutaSinIdentificadores("/health")).toBe("/health");
  });
  it("la pila solo trae funcion, archivo, linea y columna, del marco mas antiguo al mas reciente", () => {
    const stack = "Error: x\n    at handler (/var/task/api/index.js:10:5)\n    at async dispatch (/var/task/node_modules/hono/dist/compose.js:22:17)\n    at node:internal/process:1:1";
    const marcos = marcosDePila(stack);
    expect(marcos.map((m) => m.filename)).toEqual(["node:internal/process", "/var/task/node_modules/hono/dist/compose.js", "/var/task/api/index.js"]);
    expect(marcos.at(-1)).toEqual({ function: "handler", filename: "/var/task/api/index.js", lineno: 10, colno: 5, in_app: true });
    expect(marcos[1]!.in_app).toBe(false);
  });
  it("el evento no trae request, user, cabeceras ni cuerpo", () => {
    const ev = eventoDeError(new Error("x"), { requestId: "rid-1", method: "POST", path: "/auth/login" }, { eventId: "e", ahora: T, entorno: null, release: null }) as Record<string, unknown>;
    for (const clave of ["request", "user", "contexts", "breadcrumbs"]) expect(ev).not.toHaveProperty(clave);
    expect(ev["extra"]).toEqual({ requestId: "rid-1" });
  });
});

describe("robustez", () => {
  it("un fallo de red o un 5xx de Sentry devuelve false, nunca lanza", async () => {
    const r1 = crearReportadorErrores(DSN, { fetchImpl: () => Promise.reject(new Error("ECONNRESET")) })!;
    await expect(r1.reportar(new Error("x"))).resolves.toBe(false);
    const c = capturador(503);
    const r2 = crearReportadorErrores(DSN, { fetchImpl: c.fetchImpl })!;
    await expect(r2.reportar("texto suelto")).resolves.toBe(false);
  });
  it("tope por minuto por instancia; la ventana se reinicia", async () => {
    let ahora = T.getTime();
    const c = capturador();
    const r = crearReportadorErrores(DSN, { fetchImpl: c.fetchImpl, ahora: () => new Date(ahora), maxPorMinuto: 3 })!;
    for (let i = 0; i < 5; i++) await r.reportar(new Error(`e${i}`));
    expect(c.llamadas).toHaveLength(3);
    ahora += 60_000;
    await r.reportar(new Error("despues"));
    expect(c.llamadas).toHaveLength(4);
  });
});

describe("cableado en app.onError", () => {
  it("un 500 real se reporta redactado y la respuesta sigue siendo el 500 generico", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps } = await buildTestDeps();
    const coreRepo = Object.create(deps.coreRepo) as typeof deps.coreRepo;
    coreRepo.findStaffByEmail = async () => {
      throw new Error("conexion rechazada para maria@example.com con token=abcd1234efgh5678");
    };
    const c = capturador();
    const app = buildApp({ ...deps, coreRepo, reportadorErrores: crearReportadorErrores(DSN, { fetchImpl: c.fetchImpl })! });
    const res = await app.request("/auth/login?correo=ana@example.com", jsonRequestInit({ email: "x@example.com", password: "incorrecta" }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ code: "internal_error", message: "Error interno" });
    expect(c.llamadas).toHaveLength(1);
    const texto = String(c.llamadas[0]!.init.body);
    for (const s of ["maria@example.com", "abcd1234efgh5678", "ana@example.com", "incorrecta", "x@example.com"]) expect(texto).not.toContain(s);
    expect(c.evento()).toMatchObject({ transaction: "POST /auth/login", tags: { metodo: "POST", ruta: "/auth/login" } });
  });

  it("si Sentry falla, el cliente recibe el mismo 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps } = await buildTestDeps();
    const coreRepo = Object.create(deps.coreRepo) as typeof deps.coreRepo;
    coreRepo.findStaffByEmail = async () => {
      throw new Error("x");
    };
    const app = buildApp({ ...deps, coreRepo, reportadorErrores: crearReportadorErrores(DSN, { fetchImpl: () => Promise.reject(new Error("caido")) })! });
    const res = await app.request("/auth/login", jsonRequestInit({ email: "x@example.com", password: "incorrecta" }));
    expect(res.status).toBe(500);
  });
});
