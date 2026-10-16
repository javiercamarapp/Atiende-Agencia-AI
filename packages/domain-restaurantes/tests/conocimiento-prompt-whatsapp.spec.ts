// El conocimiento del negocio llega al prompt de WhatsApp ANTES de las reglas duras (que van despues y ganan), solo lo vigente HOY segun la
// fecha local de la sucursal, y sin entradas el prompt es identico al de antes. Incluye el caso de eval "cliente pregunta por el estacionamiento".
import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler, buildSystemPrompt, PM_CONFIG_POR_OMISION, FALLBACK_CONFIG } from "../src/whatsapp/llm-turn-handler.ts";
import { bloqueConocimientoPrompt, CONOCIMIENTO_ENCABEZADO, validarEntradaConocimiento, type ConocimientoEntrada } from "../src/conocimiento/index.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PHONE = "+5219990000000";

function entrada(p: Partial<ConocimientoEntrada>): ConocimientoEntrada {
  return {
    id: "e1",
    organizationId: "org",
    propertyId: null,
    reemplazaId: null,
    titulo: "Estacionamiento",
    texto: "Hay estacionamiento gratuito para clientes en todas las sucursales.",
    tipo: "faq",
    prioridad: 50,
    vigenteDesde: null,
    vigenteHasta: null,
    activo: true,
    estado: "publicado",
    origen: "manual",
    version: 1,
    creadoPor: null,
    actualizadoPor: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...p,
  };
}

describe("buildSystemPrompt con conocimiento del negocio", () => {
  const ahora = new Date("2026-10-06T20:00:00Z");
  const sucursales = [{ propertyId: "p1", slug: "t1", name: "Prolongación Montejo", address: null }];
  const bloque = bloqueConocimientoPrompt([entrada({})]);

  it("PM: el bloque va ANTES de las reglas duras (las reglas van despues y ganan)", () => {
    const prompt = buildSystemPrompt(PM_CONFIG_POR_OMISION, sucursales, { isNew: true }, ahora, null, bloque);
    const iConocimiento = prompt.indexOf(CONOCIMIENTO_ENCABEZADO);
    const iReglas = prompt.indexOf("# REGLAS DURAS");
    expect(iConocimiento).toBeGreaterThan(0);
    expect(iReglas).toBeGreaterThan(iConocimiento);
    expect(prompt.indexOf("# VOZ Y TRATO")).toBeLessThan(iConocimiento);
    expect(prompt).toContain("- [Pregunta frecuente] Estacionamiento: Hay estacionamiento gratuito");
    // Orden de las secciones (snapshot estructural): rol, voz y trato, conocimiento, reglas duras, flujo.
    const encabezados = ["# VOZ Y TRATO", CONOCIMIENTO_ENCABEZADO.slice(0, 30), "# REGLAS DURAS", "# FLUJO"].map((h) => prompt.indexOf(h));
    expect(encabezados.every((i) => i >= 0)).toBe(true);
    expect([...encabezados].sort((a, b) => a - b)).toEqual(encabezados);
  });

  it("PM y generico: sin conocimiento el prompt es IDENTICO al de antes", () => {
    expect(buildSystemPrompt(PM_CONFIG_POR_OMISION, sucursales, { isNew: true }, ahora)).toBe(buildSystemPrompt(PM_CONFIG_POR_OMISION, sucursales, { isNew: true }, ahora, null, ""));
    expect(buildSystemPrompt(FALLBACK_CONFIG, sucursales, { isNew: true }, ahora)).not.toContain("CONOCIMIENTO DEL NEGOCIO");
  });

  it("generico: el bloque va antes de las reglas de negocio", () => {
    const prompt = buildSystemPrompt(FALLBACK_CONFIG, sucursales, { isNew: true }, ahora, null, bloque);
    expect(prompt.indexOf(CONOCIMIENTO_ENCABEZADO)).toBeGreaterThan(0);
    expect(prompt.indexOf("REGLAS DE NEGOCIO:")).toBeGreaterThan(prompt.indexOf(CONOCIMIENTO_ENCABEZADO));
  });
});

describe("turno de WhatsApp con conocimiento cargado (eval)", () => {
  async function turno(preparar: (f: ReturnType<typeof buildRestaurantFixture>) => Promise<void>, ahora = new Date("2026-10-06T20:00:00Z")) {
    const f = buildRestaurantFixture();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" });
    await preparar(f);
    let system = "";
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: (req) => {
          system = req.system;
          return { text: "Sí, hay estacionamiento gratuito para clientes.", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", now: () => ahora });
    const r = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: "¿Tienen estacionamiento?" }], customer: { isNew: true }, propertyId: f.propertyId });
    return { system, reply: r.reply, f };
  }

  it("la FAQ cargada llega al modelo (el agente puede contestar 'hay estacionamiento')", async () => {
    const { system, reply } = await turno(async (f) => {
      await f.repo.crearConocimiento(f.organizationId, "u1", { titulo: "Estacionamiento", texto: "Hay estacionamiento gratuito para clientes.", tipo: "faq" });
    });
    expect(system).toContain("[Pregunta frecuente] Estacionamiento: Hay estacionamiento gratuito para clientes.");
    expect(system.indexOf("CONOCIMIENTO DEL NEGOCIO")).toBeLessThan(system.indexOf("# REGLAS DURAS"));
    expect(reply).toMatch(/estacionamiento/i);
  });

  it("un aviso temporal solo aplica dentro de su vigencia segun la fecha LOCAL de la sucursal", async () => {
    // 2026-10-07 03:00 UTC = 6 de octubre 21:00 en Merida: el aviso del 6 sigue vigente aunque en UTC ya sea 7.
    const preparar = async (f: ReturnType<typeof buildRestaurantFixture>) => {
      await f.repo.crearConocimiento(f.organizationId, "u1", { titulo: "Cierre", texto: "Hoy cerramos a las 10 de la noche.", tipo: "aviso_temporal", vigenteDesde: "2026-10-06", vigenteHasta: "2026-10-06" });
    };
    expect((await turno(preparar, new Date("2026-10-07T03:00:00Z"))).system).toContain("Hoy cerramos a las 10 de la noche.");
    expect((await turno(preparar, new Date("2026-10-08T18:00:00Z"))).system).not.toContain("Hoy cerramos a las 10");
  });

  it("borradores, apagadas y entradas de otra sucursal u organizacion no llegan al modelo", async () => {
    const { system } = await turno(async (f) => {
      await f.repo.crearConocimiento(f.organizationId, "u1", { titulo: "Borrador", texto: "Texto de borrador importado.", tipo: "faq", estado: "borrador", origen: "importado" });
      await f.repo.crearConocimiento(f.organizationId, "u1", { titulo: "Apagada", texto: "Texto apagado.", tipo: "faq", activo: false });
      await f.repo.crearConocimiento("otra-org", "u2", { titulo: "Ajena", texto: "Texto de otra organizacion.", tipo: "faq" });
    });
    expect(system).not.toContain("CONOCIMIENTO DEL NEGOCIO");
    expect(system).not.toContain("Texto de borrador");
    expect(system).not.toContain("Texto de otra organizacion");
  });

  it("base sin migrar o fallo al leer: el turno NO se cae y el prompt queda sin el bloque", async () => {
    const { system, reply } = await turno(async (f) => {
      f.repo.conocimiento.noDisponible = true;
    });
    expect(system).not.toContain("CONOCIMIENTO DEL NEGOCIO");
    expect(reply).toContain("estacionamiento");
  });
});

describe("eval: el validador rechaza la FAQ con precio", () => {
  it("'el pastor cuesta $10' no se guarda: el precio sale de cotizar_pedido", () => {
    const r = validarEntradaConocimiento({ titulo: "Pastor", texto: "El pastor cuesta $10." }, ["Tacos de Bistec de Res (orden de 3)", "Coca-Cola"]);
    expect(r.ok).toBe(false);
  });
});
