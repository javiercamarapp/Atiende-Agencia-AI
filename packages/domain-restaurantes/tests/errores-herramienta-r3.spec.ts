// QA-PM-R3-reglas-10 (P3): executeAgentToolSafely tragaba la causa ("Error interno", sin rastro) y la guarda SQL de errcode 22023 salia como falla del sistema.
import { describe, expect, it, vi } from "vitest";
import { executeAgentToolSafely } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const ctx = (f: ReturnType<typeof buildRestaurantFixture>) => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567" });
const quote = (f: ReturnType<typeof buildRestaurantFixture>) =>
  executeAgentToolSafely(f.repo, ctx(f), "cotizar_pedido", { branch_slug: "fco-montejo", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }], canal: "recoger" });

describe("executeAgentToolSafely", () => {
  it("una excepcion SQL con errcode 22023 es una regla de negocio: el agente recibe su mensaje y no se marca falla del sistema", async () => {
    const f = buildRestaurantFixture();
    f.repo.findBranch = async () => {
      throw Object.assign(new Error("programado_para debe ser una hora futura"), { code: "22023" });
    };
    const out = await quote(f);
    expect(out.result).toEqual({ error: "programado_para debe ser una hora futura" });
    expect(out.fallaSistema).toBeUndefined();
  });

  it("un error interno de verdad sigue siendo falla del sistema, pero deja la causa en el log (sin argumentos de la herramienta)", async () => {
    const f = buildRestaurantFixture();
    f.repo.findBranch = async () => {
      throw Object.assign(new Error("relation restaurantes.algo does not exist"), { code: "42P01" });
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await quote(f);
    expect(out.result).toEqual({ error: "Error interno al ejecutar la herramienta" });
    expect(out.fallaSistema).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    const linea = String(log.mock.calls[0]![0]);
    expect(linea).toContain("cotizar_pedido");
    expect(linea).toContain("42P01");
    expect(linea).toContain("does not exist");
    expect(linea).not.toContain("9991234567");
    log.mockRestore();
  });
});
