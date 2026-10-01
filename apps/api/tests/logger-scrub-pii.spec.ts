// PL-10: el logger y el error handler real de la app no filtran PII/secretos (telefonos,
// correos, tarjetas, tokens, JWT) a stdout/stderr, y las alertas usan la MISMA fuente de patrones.
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrubTexto } from "@atiende/core-pii";
import { redactarTexto } from "../src/alertas/redaccion.ts";
import { buildApp } from "../src/app.ts";
import { logEvent } from "../src/logger.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const jwtFalso = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from('{"sub":"1"}').toString("base64url")}.firma_abcdefgh`;
const requestId = "00000000-0000-0000-0000-0000000000a1";

afterEach(() => vi.restoreAllMocks());

describe("logEvent", () => {
  it("redacta telefonos, correos, tarjetas, tokens y JWT de los campos, conserva el requestId y los numeros", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logEvent({ get: () => requestId }, "error", "prueba", {
      message: `fallo para ana@example.com tel +52 55 1234 5678 tarjeta 4242 4242 4242 4242 jwt ${jwtFalso}`,
      token: "abc",
      inputTokens: 300,
      anidado: { password: "hunter2", nota: "ok" },
    });
    const linea = String(spy.mock.calls[0]?.[0]);
    for (const secreto of ["ana@example.com", "1234 5678", "4242", jwtFalso.slice(0, 12), "hunter2"]) expect(linea).not.toContain(secreto);
    const parsed = JSON.parse(linea) as { requestId: string; evento: string; inputTokens: number; anidado: { nota: string } };
    expect(parsed.requestId).toBe(requestId);
    expect(parsed.evento).toBe("prueba");
    expect(parsed.inputTokens).toBe(300);
    expect(parsed.anidado.nota).toBe("ok");
  });
});

describe("error handler de la app", () => {
  it("un error interno con PII responde 500 generico y su log sale redactado", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps } = await buildTestDeps();
    const coreRepo = Object.create(deps.coreRepo) as typeof deps.coreRepo;
    coreRepo.findStaffByEmail = async () => {
      throw new Error("conexion rechazada para maria@example.com desde +52 55 9876 5432 con token=abcd1234efgh5678");
    };
    const app = buildApp({ ...deps, coreRepo });
    const res = await app.request("/auth/login", jsonRequestInit({ email: "x@example.com", password: "incorrecta" }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ code: "internal_error", message: "Error interno" });
    const salida = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(salida).toContain("apps_api_error_interno");
    for (const secreto of ["maria@example.com", "9876 5432", "abcd1234efgh5678"]) expect(salida).not.toContain(secreto);
  });
});

describe("fuente unica de patrones", () => {
  it("la redaccion de alertas es la misma de @atiende/core-pii", () => {
    const sucio = `falla ana@example.com +52 55 1234 5678 4242 4242 4242 4242 jwt ${jwtFalso}`;
    expect(redactarTexto(sucio)).toBe(scrubTexto(sucio, { maxLargo: 500 }));
  });
});
