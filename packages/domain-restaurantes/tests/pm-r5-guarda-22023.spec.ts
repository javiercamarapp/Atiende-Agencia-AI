// QA-PM-R5-reglas-10: el SQLSTATE 22023 se trata como regla de negocio SOLO para la guarda conocida de pedidos programados; cualquier otro 22023 es un error interno.
import { describe, expect, it, vi } from "vitest";
import { esGuardaSqlDeNegocioDePedido, OrderValidationError } from "../src/errors.ts";
import { executeAgentToolSafely } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("esGuardaSqlDeNegocioDePedido", () => {
  it("la guarda de programado_para con 22023 es regla de negocio", () => {
    expect(esGuardaSqlDeNegocioDePedido(pgError("22023", "programado_para debe ser una hora futura"))).toBe(true);
  });
  it.each([
    ["22023 de otra funcion", pgError("22023", "invalid input syntax for type uuid: x")],
    ["22023 con mensaje vacio", pgError("22023", "  ")],
    ["la guarda con otro codigo", pgError("23514", "programado_para debe ser una hora futura")],
    ["sin codigo", new Error("programado_para debe ser una hora futura")],
    ["no es Error", { code: "22023", message: "programado_para debe ser una hora futura" }],
    ["OrderValidationError (ya es regla por su clase)", new OrderValidationError("x")],
  ])("negativo: %s", (_n, err) => {
    expect(esGuardaSqlDeNegocioDePedido(err)).toBe(false);
  });
});

describe("executeAgentToolSafely con 22023", () => {
  const ctx = (f: ReturnType<typeof buildRestaurantFixture>) => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567" });
  it("la guarda conocida llega al agente con su mensaje y sin marcar falla de sistema", async () => {
    const f = buildRestaurantFixture();
    vi.spyOn(f.repo, "runWithRowSavepoint").mockRejectedValueOnce(pgError("22023", "programado_para debe ser una hora futura"));
    const r = await executeAgentToolSafely(f.repo, ctx(f), "buscar_cliente", {});
    expect(r.result).toEqual({ error: "programado_para debe ser una hora futura" });
    expect(r.fallaSistema).toBeUndefined();
  });
  it("otro 22023 es error interno (mensaje generico y falla de sistema)", async () => {
    const f = buildRestaurantFixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(f.repo, "runWithRowSavepoint").mockRejectedValueOnce(pgError("22023", "invalid input syntax for type uuid: x"));
    const r = await executeAgentToolSafely(f.repo, ctx(f), "buscar_cliente", {});
    expect(r.result).toEqual({ error: "Error interno al ejecutar la herramienta" });
    expect(r.fallaSistema).toBe(true);
    log.mockRestore();
  });
});
