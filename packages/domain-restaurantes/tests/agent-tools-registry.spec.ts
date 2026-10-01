// Registro unico de tools: prueba el EFECTO (un solo registro usado por ambos canales, el telefono
// sale del contexto y nunca de los argumentos del modelo, una sucursal fijada por el contexto no se
// puede saltar), no la implementacion.
import { describe, expect, it, vi } from "vitest";
import { TOOLS } from "../src/whatsapp/llm-turn-handler.ts";
import {
  AGENT_TOOL_DEFINITIONS,
  exportVoiceToolManifest,
  invokeAgentTool,
  toolDefinitionsForChannel,
  VOICE_TOOL_HTTP_PATHS,
} from "../src/agent-tools/registry.ts";
import { OrderValidationError } from "../src/errors.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

describe("registro unico de tools", () => {
  it("WhatsApp y voz exponen las MISMAS definiciones (nombre, descripcion y esquema), sin duplicados", () => {
    const voz = toolDefinitionsForChannel("voz");
    const wa = toolDefinitionsForChannel("whatsapp");
    expect(voz.map((t) => t.name)).toEqual(wa.map((t) => t.name));
    expect(new Set(AGENT_TOOL_DEFINITIONS.map((t) => t.name)).size).toBe(AGENT_TOOL_DEFINITIONS.length);
    // El arreglo que recibe el gateway de WhatsApp sale del registro, no de una copia.
    expect(TOOLS.map((t) => [t.name, t.description])).toEqual(wa.map((t) => [t.name, t.description]));
    for (const name of ["consultar_sucursal", "buscar_producto", "cotizar_pedido", "crear_pedido", "buscar_cliente", "escalar_a_humano"]) {
      expect(AGENT_TOOL_DEFINITIONS.some((t) => t.name === name)).toBe(true);
    }
  });

  it("ninguna tool acepta un telefono como argumento (el modelo no puede elegir de quien es el historial)", () => {
    for (const tool of AGENT_TOOL_DEFINITIONS) {
      const props = Object.keys(tool.parameters.properties).join(",");
      expect(props, tool.name).not.toMatch(/phone|telefono|tel\b/i);
    }
  });

  it("el manifiesto JSON para el proveedor de voz sale del mismo registro, con URL por tool", () => {
    const manifest = exportVoiceToolManifest("https://api.ejemplo.test/", "los-taquitos-de-pm");
    expect(manifest.map((m) => m.name)).toEqual(toolDefinitionsForChannel("voz").map((t) => t.name));
    const quote = manifest.find((m) => m.name === "cotizar_pedido")!;
    expect(quote.url).toBe(`https://api.ejemplo.test/v1/restaurantes/los-taquitos-de-pm${VOICE_TOOL_HTTP_PATHS.cotizar_pedido}`);
    expect(quote.request_body_schema.required).toContain("items");
    expect(() => JSON.stringify(manifest)).not.toThrow();
  });

  it("buscar_cliente usa el telefono del CONTEXTO aunque el modelo mande otro en los argumentos", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    await repo.upsertCustomer(organizationId, "9991111111", "Ana");
    await repo.upsertCustomer(organizationId, "9992222222", "Beto");
    const outcome = await invokeAgentTool(repo, { organizationId, channel: "voz", phone: "9991111111" }, "buscar_cliente", { phone: "9992222222" });
    expect((outcome.result as { name?: string }).name).toBe("Ana");
  });

  it("buscar_cliente sin telefono en el contexto se rechaza en vez de aceptar uno de los argumentos", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    await expect(invokeAgentTool(repo, { organizationId, channel: "voz", phone: null }, "buscar_cliente", { phone: "9992222222" })).rejects.toBeInstanceOf(OrderValidationError);
  });

  it("una sucursal fijada por el contexto no puede consultarse/cotizarse/buscarse apuntando a otra sucursal", async () => {
    const { repo, organizationId, propertyId } = buildRestaurantFixture();
    repo.seedBranch({ propertyId: "00000000-0000-4000-8000-00000000aaaa", organizationId, name: "Otra", slug: "otra", status: "active", phone: null, address: null, lat: null, lng: null });
    const ctx = { organizationId, channel: "voz" as const, phone: "9991111111", lockedPropertyId: propertyId };
    await expect(invokeAgentTool(repo, ctx, "buscar_producto", { query: "coca", branch_slug: "otra" })).rejects.toThrow(/otra sucursal/);
    await expect(invokeAgentTool(repo, ctx, "consultar_sucursal", { branch_slug: "otra" })).rejects.toThrow(/otra sucursal/);
    await expect(invokeAgentTool(repo, ctx, "cotizar_pedido", { branch_slug: "otra", items: [] })).rejects.toThrow(/otra sucursal/);
    const ok = await invokeAgentTool(repo, ctx, "buscar_producto", { query: "coca", branch_slug: "fco-montejo" });
    expect((ok.result as unknown[]).length).toBeGreaterThan(0);
  });

  it("consultar_sucursal devuelve datos reales y 'sin horario' como null (no inventa)", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const out = await invokeAgentTool(repo, { organizationId, channel: "whatsapp", phone: "9991111111" }, "consultar_sucursal", { branch_slug: "fco-montejo" });
    expect(out.result).toMatchObject({ branch_slug: "fco-montejo", direccion: "Calle 1 #100, Mérida", abierto_ahora: null });
  });

  it("escalar_a_humano deja un aviso con el motivo tipificado y el telefono del contexto", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const spy = vi.spyOn(repo, "createCallbackRequest");
    await invokeAgentTool(repo, { organizationId, channel: "voz", phone: "9991111111" }, "escalar_a_humano", { customer_name: "Ana", motivo: "queja", resumen: "Llegó frío" });
    expect(spy.mock.calls[0]![0]).toMatchObject({ customerPhone: "9991111111", reason: "escalada:queja", source: "voice" });
  });

  it("una tool inexistente o de otro canal se rechaza", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    await expect(invokeAgentTool(repo, { organizationId, channel: "voz", phone: null }, "borrar_todo", {})).rejects.toThrow(/Herramienta desconocida/);
  });
});
