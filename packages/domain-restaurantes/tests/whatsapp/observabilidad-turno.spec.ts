// R-PM-15: un evento estructurado por turno y por tool de WhatsApp, sin texto del cliente, sin PAN/CVV y
// sin telefono en claro (equivalente a `observability.test.ts` del original atiende-restaurantes).
import { describe, expect, it, vi } from "vitest";
import { FakeLlmProvider } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { hashTelefonoParaLogs } from "../../src/whatsapp/observabilidad-turno.ts";
import type { EventoObservabilidadWhatsApp, EventoTurnoWhatsApp, ObservabilidadTurno } from "../../src/whatsapp/observabilidad-turno.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import { makeGateway, NEW_CUSTOMER, result } from "../pm/harness.ts";
import { seedConfirmedOrderFlow } from "../support/order-flow-seed.ts";
import type { ScriptStep } from "../pm/harness.ts";

const PHONE = "+5219991234567";
const TEXTO_SENSIBLE = "Mi tarjeta 4111 1111 1111 1111 cvv 123 vence 12/29 y mi cel es 999 123 4567";

function armar(steps: readonly ScriptStep[], opts: { llave?: string; fallar?: boolean; escalada?: ScriptStep[] } = {}) {
  const f = buildRestaurantFixture();
  const gateway = makeGateway();
  let n = 0;
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", script: () => { const s = steps[Math.min(n, steps.length - 1)]!; return result(s, n++); } })]);
  let m = 0;
  const esc = opts.escalada ?? [{ text: "listo" }];
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e", script: () => { const s = esc[Math.min(m, esc.length - 1)]!; return result(s, 100 + m++); } })]);
  const eventos: EventoObservabilidadWhatsApp[] = [];
  const llave = opts.llave ?? "llave-de-prueba";
  const obs: ObservabilidadTurno = {
    emitir: (e) => { if (opts.fallar) throw new Error("sumidero roto"); eventos.push(e); },
    hashTelefono: (t) => hashTelefonoParaLogs(t, llave),
  };
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", observabilidad: obs });
  const correr = (contenido: string) => handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: contenido }], customer: NEW_CUSTOMER, propertyId: null });
  return { f, eventos, correr };
}

const turno = (eventos: EventoObservabilidadWhatsApp[]) => eventos.find((e): e is EventoTurnoWhatsApp => e.evento === "whatsapp_turno")!;

describe("R-PM-15 observabilidad por turno de WhatsApp", () => {
  it("emite un evento por tool y uno por turno con vueltas, rol, latencias y correlation_id comun", async () => {
    const { eventos, correr, f } = armar([
      { calls: [{ name: "consultar_sucursal", args: { branch_slug: "fco-montejo" } }] },
      { text: "La sucursal abre a las 12. ¿Algo más?" },
    ]);
    await correr("a que hora abren?");
    const t = turno(eventos);
    const tools = eventos.filter((e) => e.evento === "whatsapp_tool");
    expect(tools).toHaveLength(1);
    expect(t).toMatchObject({ organizationId: f.organizationId, vueltas: 2, rolModelo: "default", resultado: "ok", motivoEscalacion: null, motivoEscaladaDeRol: null });
    expect(t.tools.map((x) => x.tool)).toEqual(["consultar_sucursal"]);
    expect(tools[0]!.correlationId).toBe(t.correlationId);
    expect(t.latenciaTotalMs).toBeGreaterThanOrEqual(0);
  });

  it("clasifica un rechazo de regla como error_regla y no como error_sistema", async () => {
    const { eventos, correr } = armar([
      { calls: [{ name: "cotizar_pedido", args: { branch_slug: "no-existe", canal: "recoger", items: [] } }] },
      { text: "No pude cotizar. ¿Me repite su pedido?" },
    ]);
    await correr("quiero algo");
    const tool = eventos.find((e) => e.evento === "whatsapp_tool");
    expect(tool && "resultado" in tool ? tool.resultado : null).toBe("error_regla");
    expect(turno(eventos).resultado).toBe("ok");
  });

  it("un turno con tarjeta y telefono en el texto produce eventos sin PAN, sin CVV, sin telefono y sin el texto del cliente", async () => {
    const { eventos, correr } = armar([{ text: "Gracias, ¿qué le gustaría pedir?" }]);
    await correr(TEXTO_SENSIBLE);
    expect(eventos.length).toBeGreaterThan(0);
    const serial = JSON.stringify(eventos);
    for (const prohibido of ["4111", "1111 1111", "cvv", "12/29", "999 123 4567", "9991234567", "5219991234567", "tarjeta", "qué le gustaría"]) {
      expect(serial.toLowerCase(), prohibido).not.toContain(prohibido.toLowerCase());
    }
    expect(turno(eventos).telefonoHash).toMatch(/^tel_[0-9a-f]{16}$/);
  });

  it("sin llave del servidor el telefono se omite (null), nunca se hashea sin llave", async () => {
    const { eventos, correr } = armar([{ text: "Hola, ¿qué desea?" }], { llave: "" });
    await correr("hola");
    expect(turno(eventos).telefonoHash).toBeNull();
    expect(hashTelefonoParaLogs(PHONE, "")).toBeNull();
  });

  it("el mismo telefono da el mismo hash con la misma llave y distinto con otra llave", () => {
    expect(hashTelefonoParaLogs("+52 999 123 4567", "k1")).toBe(hashTelefonoParaLogs("+529991234567", "k1"));
    expect(hashTelefonoParaLogs(PHONE, "k1")).not.toBe(hashTelefonoParaLogs(PHONE, "k2"));
  });

  it("un sumidero de eventos roto no tumba la respuesta al cliente", async () => {
    const { correr } = armar([{ text: "Hola, ¿qué desea?" }], { fallar: true });
    const out = await correr("hola");
    expect(out.reply).toContain("¿qué desea?");
  });

  it("el clasificador de alto riesgo se reporta como escalado_alto_riesgo con su motivo, sin llamar al modelo", async () => {
    const { eventos, correr } = armar([{ text: "no deberia llamarse" }]);
    await correr("quiero cancelar mi pedido");
    const t = turno(eventos);
    expect(t.resultado).toBe("escalado_alto_riesgo");
    expect(t.motivoEscalacion).toBeTruthy();
    expect(t.vueltas).toBe(0);
    expect(t.rolModelo).toBeNull();
  });

  it("tras un fallo de sistema en crear_pedido el turno sube de rol y el evento lo reporta como fallo_crear_pedido", async () => {
    const { eventos, correr, f } = armar(
      [
        { calls: [{ name: "crear_pedido", args: { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Ana", payment_method: "efectivo", items: [{ product_name: "Coca-Cola", requested_quantity: 1 }] } }] },
        { text: "Intento de nuevo, ¿me confirma?" },
      ],
      { escalada: [{ text: "Un momento por favor, ¿me confirma su pedido?" }] },
    );
    // B04: solo un FALLO de sistema sube de rol (un rechazo de regla no): la base cae al crear el cliente.
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productName: "Coca-Cola", requestedQuantity: 1 }] });
    vi.spyOn(f.repo, "upsertCustomer").mockRejectedValue(new Error("base caida"));
    await correr("confirmo");
    const t = turno(eventos);
    expect(t.rolesUsados).toEqual(["default", "escalated"]);
    expect(t.rolModelo).toBe("escalated");
    expect(t.motivoEscaladaDeRol).toBe("fallo_crear_pedido");
  });
});
