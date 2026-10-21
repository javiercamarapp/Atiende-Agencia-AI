// PM Ronda 12 (Q2 y Q9, decisiones de Javier): el silencio tras escalar.
//  * Q2: con la toma PENDIENTE el cliente que vuelve a escribir recibe UN acuse breve (con el horario real si la sucursal esta cerrada)
//    y despues el bot calla; no contesta temas del pedido en escalacion. Maximo un acuse por toma cada 15 min.
//  * Q9: una falla tecnica (`falla_sistema`) o un `no_puedo_resolver` avisan al equipo pero NO callan al bot, salvo que ya exista un
//    pedido en curso. La defensa de dinero / alto riesgo / privacidad sigue callando (no se toca).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACUSE_HANDOFF_PENDIENTE, ACUSE_HANDOFF_REPETIDO, ACUSE_PENDIENTE_ESPERA_MIN, ACUSE_PENDIENTE_REPETIR_MIN, abreTomaDeHandoff, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { AGENT_TOOL_DEFINITIONS, MOTIVOS_ESCALACION } from "../src/agent-tools/registry.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { createOrder } from "../src/orders.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate } from "../src/index.ts";
import { MARTES_14H, MIERCOLES_0230, TEL_CLIENTE, nuevoViaje, type Viaje } from "./qa-viaje/arnes-viaje.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const min = (n: number) => n * 60_000;
const avanza = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const u = (content: string) => ({ role: "user" as const, content });

const ACUSE_Q2 = "Ya está avisado el equipo, quedó registrado lo que me cuenta. En cuanto lo vean le responden.";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => vi.useRealTimers());

async function escalado(): Promise<Viaje> {
  const v = await nuevoViaje();
  expect((await v.escribe("quiero hablar con una persona")).escalated).toBe(true);
  return v;
}

describe("Q2: acuse unico en toma pendiente", () => {
  it("el acuse es el texto acordado; la espera es de 1 min (minimo que admite la base sin migrar) y la repeticion de 15 min", () => {
    expect(ACUSE_HANDOFF_PENDIENTE).toBe(ACUSE_Q2);
    expect(ACUSE_PENDIENTE_ESPERA_MIN).toBe(1);
    expect(ACUSE_PENDIENTE_REPETIR_MIN).toBe(15);
  });

  it("sucursal abierta: el siguiente mensaje recibe el acuse fijo, sin hora inventada", async () => {
    const v = await escalado();
    avanza(min(2));
    const r = await v.escribe("¿no me dicen nada?");
    expect(r.reply).toBe(ACUSE_Q2);
    expect(r.reply).not.toMatch(/\d{1,2}:\d{2}|a partir de las/);
    expect(r.escalated).toBe(false);
    expect(v.conversaciones.handoffs[0]!.estado).toBe("pendiente");
  });

  it("sucursal cerrada: el acuse agrega la apertura REAL del horario (12:00), no una inventada", async () => {
    vi.setSystemTime(new Date(MIERCOLES_0230));
    const v = await escalado();
    avanza(min(2));
    const r = await v.escribe("¿ya salió?");
    expect(r.reply).toBeDefined();
    expect(r.reply!.startsWith(ACUSE_Q2)).toBe(true);
    expect(r.reply).toMatch(/12:00/);
    expect(r.reply).toMatch(/cerrad/i);
  });

  it("R16: el acuse oficial sale una vez por intervalo; dentro de los 15 min cada mensaje recibe el recordatorio breve (ya no hay silencio)", async () => {
    const v = await escalado();
    avanza(min(2));
    expect((await v.escribe("hola?")).reply).toBe(ACUSE_Q2);
    avanza(min(3));
    expect((await v.escribe("¿ya salió?")).reply).toBe(ACUSE_HANDOFF_REPETIDO);
    avanza(min(10));
    expect((await v.escribe("???")).reply).toBe(ACUSE_HANDOFF_REPETIDO);
    avanza(min(16));
    expect((await v.escribe("sigo aquí")).reply).toBe(ACUSE_Q2);
  });

  it("no contesta temas del pedido en escalacion: el modelo no se llama despues de la escalacion", async () => {
    const v = await escalado();
    const llamadas = v.requests.length;
    avanza(min(2));
    await v.escribe("no mandaron el guacamole");
    avanza(min(20));
    await v.escribe("¿cuánto es un kilo de pastor?");
    expect(v.requests.length).toBe(llamadas);
  });

  it("con la toma TOMADA por una persona no hay acuse (atiende la persona)", async () => {
    const v = await escalado();
    await v.conversaciones.tomar(v.world.organizationId, v.t7, "whatsapp", v.conversaciones.handoffs[0]!.conversationId);
    avanza(min(90));
    expect((await v.escribe("hola?")).reply).toBeUndefined();
  });
});

function escalaPorModelo(v: Viaje, motivo: string): void {
  v.guion([
    { tools: [{ name: "escalar_a_humano", args: { customer_name: "Cliente", motivo, resumen: "El asistente no pudo con la solicitud." } }] },
    { texto: "Ya avisé al equipo." },
  ]);
}

describe("Q9: falla tecnica y no_puedo_resolver avisan al equipo sin callar al bot", () => {
  it.each(["no_puedo_resolver", "falla_sistema"])("%s sin pedido en curso: avisa (callback), no abre toma y el siguiente mensaje se contesta", async (motivo) => {
    const v = await nuevoViaje();
    escalaPorModelo(v, motivo);
    const r1 = await v.escribe("¿Manejan chistorra?");
    expect(r1.escalated).toBe(false);
    expect(v.callbacks.map((c) => c.reason)).toContain(`escalada:${motivo}`);
    expect(v.conversaciones.handoffs).toHaveLength(0);
    v.guion([{ texto: "Con gusto, ¿qué le gustaría pedir?" }]);
    const r2 = await v.escribe("quiero 3 tacos de pastor");
    expect(r2.reply).toBe("Con gusto, ¿qué le gustaría pedir?");
  });

  it("timeout del proveedor (falla_sistema del turno) sin pedido: el cliente que escribe de nuevo recibe respuesta del bot", async () => {
    const f = buildRestaurantFixture();
    const PHONE = "+5219991234567";
    const store = new InMemoryConversacionesRepository({ actorUserId: "00000000-0000-4000-8000-0000000000f1" });
    const gate = new InMemoryHandoffAgentGate(store);
    const propertyId = "00000000-0000-4000-8000-0000000000a1";
    store.conversaciones.push({ canal: "whatsapp", id: "00000000-0000-4000-8000-0000000000c1", organizationId: f.organizationId, propertyId, telefono: PHONE, mensajes: [], actividadAt: new Date().toISOString() });
    let turnos = 0;
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        turnos += 1;
        return { reply: turnos === 1 ? "En este momento tenemos un problema técnico. Ya avisé al equipo." : "Claro, ¿qué le sirvo?", orderId: null, propertyId: null, ...(turnos === 1 ? { escalacion: { motivo: "falla_sistema" } } : {}) };
      },
    };
    const enviar = (id: string, body: string) => handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId: id, phone: PHONE, body, phoneNumberId: "1", propertyId, handoffGate: gate });
    expect(await enviar("m1", "hola")).toMatchObject({ ok: true, escalated: false });
    expect(store.handoffs).toHaveLength(0);
    expect(await enviar("m2", "mejor déjalo, sí quiero 2 tacos")).toMatchObject({ ok: true, reply: "Claro, ¿qué le sirvo?" });
    expect(turnos).toBe(2);
  });

  it.each(["no_puedo_resolver", "falla_sistema"])("%s CON un pedido en curso: se conserva la toma abierta (R16: recordatorio breve, sin vender)", async (motivo) => {
    const v = await nuevoViaje();
    await createOrder(v.world.repo, {
      organizationId: v.world.organizationId,
      branchSlug: "garcia-lavin",
      customerName: "Cliente Prueba",
      customerPhone: TEL_CLIENTE,
      canal: "recoger",
      paymentMethod: "efectivo",
      source: "whatsapp",
      items: [{ productId: v.producto("Bistec de Res — 1 kg"), requestedQuantity: 1 }],
    });
    escalaPorModelo(v, motivo);
    const r1 = await v.escribe("¿ya salió mi pedido?");
    expect(r1.escalated).toBe(true);
    expect(v.conversaciones.handoffs).toHaveLength(1);
    expect((await v.escribe("hola?")).reply).toBe(ACUSE_HANDOFF_REPETIDO); // R16: la toma sigue abierta (el bot no vuelve a vender) pero no calla
  });

  it("abreTomaDeHandoff: los motivos blandos solo abren con pedido en curso; sin contexto conservan la regla anterior (abren)", () => {
    for (const m of ["falla_sistema", "no_puedo_resolver"]) {
      expect(abreTomaDeHandoff(m, [u("x")], { pedidoEnCurso: false }), m).toBe(false);
      expect(abreTomaDeHandoff(m, [u("x")], { pedidoEnCurso: true }), m).toBe(true);
      expect(abreTomaDeHandoff(m, [u("x")]), m).toBe(true);
    }
  });

  it("alto riesgo (alergia, cobro doble, dinero, privacidad, queja, cancelacion...) SIGUE abriendo toma aunque no haya pedido en curso", () => {
    for (const m of ["alergia_salud", "cobro_duplicado", "privacidad_arco", "queja", "urgencia", "cancelacion_modificacion", "transferencia", "modificacion_platillo", "pedido_grande"]) {
      expect(abreTomaDeHandoff(m, [u("x")], { pedidoEnCurso: false }), m).toBe(true);
    }
  });
});

describe("no_puedo_resolver ya no se ofrece al modelo", () => {
  it("el esquema de escalar_a_humano no lista no_puedo_resolver y la descripcion no invita a escalar por 'no puedes resolver'", () => {
    const def = AGENT_TOOL_DEFINITIONS.find((t) => t.name === "escalar_a_humano")!;
    const motivo = (def.parameters.properties as Record<string, { enum: string[] }>).motivo!;
    expect(motivo.enum).not.toContain("no_puedo_resolver");
    expect(def.description).not.toMatch(/no puedes resolver/i);
    // El motivo sigue existiendo para los caminos internos (vueltas agotadas, voz): solo deja de ofrecerse al modelo.
    expect(MOTIVOS_ESCALACION).toContain("no_puedo_resolver");
  });
});

describe("el prompt ya no contradice el codigo", () => {
  const prompt = buildPmSystemPrompt({
    businessName: "Los Taquitos de PM",
    agentName: "Lupita",
    deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
    saludo: "Buenas tardes",
    branches: [],
    entryBranch: null,
    customer: { isNew: true },
    fechaHoraLocal: "13 de octubre de 2026, 14:00",
    diaSemana: "martes",
  });
  it("no manda contestar 'siempre' a quien escribe tras una escalacion que ya cedio la conversacion", () => {
    expect(prompt).not.toMatch(/Si el cliente vuelve a escribir, conteste/);
    expect(prompt).not.toMatch(/no se quede callado/);
    expect(prompt).not.toMatch(/tras escalar, no se quede en silencio/);
  });
  it("explica que tras ceder la conversacion el sistema manda el acuse y el agente ya no recibe esos mensajes", () => {
    expect(prompt).toMatch(/acuse/i);
  });
});
