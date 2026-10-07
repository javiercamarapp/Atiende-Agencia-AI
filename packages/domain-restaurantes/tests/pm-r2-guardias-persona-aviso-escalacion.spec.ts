// QA-PM-R2 (WhatsApp y voz): guardia de "hablar con una persona" sin falsos positivos (voz-02, whatsapp-06), "ya avise al gerente" solo si el aviso existe
// (whatsapp-04), escalar_a_humano con nombre vacio registra el aviso (whatsapp-03) y una escalacion informativa no congela el pedido (whatsapp-05).
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { afirmaHaberAvisado, classifyHighRiskIntent, pideUnaPersona, quitarAfirmacionDeAviso } from "../src/whatsapp/guards.ts";
import { MOTIVOS_QUE_NO_ABREN_TOMA } from "../src/whatsapp/inbound.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { evaluarPersonaVoz } from "../src/voz/guardia-persona.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

type Script = (request: LlmCompletionRequest) => LlmCompletionResult;
const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (id: string, name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
function handlerGuionado(repo: InMemoryRestaurantesRepository, script: Script) {
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "guion", script })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "esc", script })]);
  return createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
}
const PHONE = "+5219990001111";
const entrada = (organizationId: string, contenido: string) => ({ organizationId, phone: PHONE, messages: [{ role: "user" as const, content: contenido }], customer: { isNew: true as const }, propertyId: null });

describe("pideUnaPersona: sin falsos positivos (QA-PM-R2-voz-02 / whatsapp-06)", () => {
  it("las peticiones reales siguen detectandose", () => {
    for (const t of ["quiero hablar con una persona", "comuníqueme con el gerente", "pásame con alguien", "pásame con un humano", "necesito hablar con un asesor", "quiero pasar con el gerente"]) {
      expect(pideUnaPersona(t), t).toBe(true);
    }
  });
  it("la negacion no cuenta (VX16)", () => {
    expect(pideUnaPersona("No, no quiero hablar con una persona, con usted está bien")).toBe(false);
    expect(pideUnaPersona("no necesito hablar con alguien, gracias")).toBe(false);
    expect(evaluarPersonaVoz("No, no quiero hablar con una persona, con usted está bien. Quiero tres tacos de pastor")).toBeNull();
  });
  it("'voy a pasar con alguien a recogerlo' es una visita, no una transferencia (VX17)", () => {
    expect(pideUnaPersona("Voy a pasar con alguien a recogerlo como en cuarenta minutos")).toBe(false);
    expect(evaluarPersonaVoz("Voy a pasar con alguien a recogerlo como en cuarenta minutos")).toBeNull();
  });
  it("una peticion mezclada con un pedido SIEMPRE escala (la persona retoma el pedido)", () => {
    for (const t of [
      "quiero 3 tacos y que me hable una persona",
      "quiero hablar con alguien de recursos humanos por la vacante, y de paso me apartas 4 tacos de pastor para recoger",
      "ponme dos kilos de pastor y pásame con el gerente",
      "páseme con alguien, no quiero el bot",
      "no quiero el bot pásame con alguien",
      "no sé si quiero hablar con alguien o seguir con el bot, mejor sí, pásame con una persona",
      "no quiero hablar con un bot",
    ]) {
      expect(pideUnaPersona(t), t).toBe(true);
      expect(classifyHighRiskIntent(t)?.intent, t).toBe("cliente_lo_pide");
      expect(evaluarPersonaVoz(t)?.motivo, t).toBe("cliente_lo_pide");
    }
  });
  it("la negacion pegada al verbo sigue sin escalar aunque venga con un pedido", () => {
    for (const t of ["no quiero hablar con una persona, con usted está bien, quiero 3 tacos", "no necesito que me hable nadie, ponme 2 tacos", "no hace falta que me pases con el gerente"]) {
      expect(pideUnaPersona(t), t).toBe(false);
    }
  });
  it("una peticion pura escala con el motivo cliente_lo_pide", () => {
    expect(classifyHighRiskIntent("quiero hablar con una persona")?.intent).toBe("cliente_lo_pide");
    expect(evaluarPersonaVoz("pásame con el gerente para felicitarlos")?.motivo).toBe("cliente_lo_pide");
  });
});

describe("afirmaHaberAvisado y la guardia de honestidad (QA-PM-R2-whatsapp-04)", () => {
  it("detecta 'ya avise al gerente' y variantes, no otras frases", () => {
    for (const t of ["Ya avisé al gerente.", "Avisaré a la sucursal para que lo confirme.", "ya avise al equipo", "Le avisé al encargado de turno"]) expect(afirmaHaberAvisado(t), t).toBe(true);
    for (const t of ["Le aviso a la sucursal para que tenga listo su pedido.", "Ya avisé a la sucursal para que su pedido esté listo a las 3.", "Le aviso que el total es de $126.", "No tengo forma de avisar a nadie.", "¿Desea que avise?"]) expect(afirmaHaberAvisado(t), t).toBe(false);
  });
  it("quitarAfirmacionDeAviso no deja la mentira", () => {
    const r = quitarAfirmacionDeAviso("No puedo darle ese descuento. Ya avisé al gerente. ¿Algo más?");
    expect(r).not.toMatch(/avis[ée] al gerente/);
    expect(r).toContain("No puedo darle ese descuento.");
  });
  it("si el modelo dice 'ya avise al gerente' SIN llamar la herramienta, el servidor deja el aviso de verdad", async () => {
    const f = buildRestaurantFixture();
    const handler = handlerGuionado(f.repo, () => texto("Con gusto. Ya avisé al gerente para que le dé una respuesta."));
    const out = await handler.handleInboundMessage(entrada(f.organizationId, "me pueden dar descuento"));
    expect(out.reply).toContain("Ya avisé al gerente");
    expect(out.escalacion?.motivo).toBe("otro");
    const avisos = await f.repo.listCallbackRequests(f.organizationId);
    expect(avisos.some((a) => (a.reason ?? "").startsWith("escalada:otro"))).toBe(true);
  });
  it("si el modelo SI llamo escalar_a_humano en el turno no se duplica el aviso", async () => {
    const f = buildRestaurantFixture();
    let paso = 0;
    const handler = handlerGuionado(f.repo, () => {
      paso += 1;
      return paso === 1 ? llamada("e1", "escalar_a_humano", { customer_name: "Nora", motivo: "reposicion_descuento", resumen: "pide descuento" }) : texto("Ya avisé al gerente.");
    });
    await handler.handleInboundMessage(entrada(f.organizationId, "quiero un descuento"));
    const avisos = await f.repo.listCallbackRequests(f.organizationId);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.reason).toBe("escalada:reposicion_descuento");
  });
});

describe("escalar_a_humano con customer_name vacio (QA-PM-R2-whatsapp-03)", () => {
  it("usa 'Cliente' y registra el aviso (antes: 'Error interno al ejecutar la herramienta')", async () => {
    const f = buildRestaurantFixture();
    const ctx = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567" };
    for (const nombre of ["", "   ", undefined]) {
      const r = await invokeAgentTool(f.repo, ctx, "escalar_a_humano", { customer_name: nombre, motivo: "cliente_lo_pide", resumen: "x" });
      expect(r.result).toEqual({ ok: true });
    }
    const avisos = await f.repo.listCallbackRequests(f.organizationId);
    expect(avisos.length).toBeGreaterThan(0);
    expect(avisos.every((a) => a.customerName === "Cliente")).toBe(true);
  });
});

describe("escalaciones informativas no congelan el pedido (QA-PM-R2-whatsapp-05)", () => {
  it("reposicion_descuento y producto_agotado no abren la toma; queja, alergia y 'una persona' si", () => {
    for (const m of ["reposicion_descuento", "producto_agotado", "tiempos_entrega"]) expect(MOTIVOS_QUE_NO_ABREN_TOMA.has(m), m).toBe(true);
    for (const m of ["queja", "no_puedo_resolver", "alergia_salud", "cliente_lo_pide", "cancelacion_modificacion", "cobro_duplicado", "privacidad_arco", "falla_sistema", "pedido_grande", "transferencia"]) {
      expect(MOTIVOS_QUE_NO_ABREN_TOMA.has(m), m).toBe(false);
    }
  });
});
