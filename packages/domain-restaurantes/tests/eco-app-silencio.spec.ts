// Coexistencia PR-2: el eco de la app silencia al asistente en esa conversacion; el cliente que escribe se guarda y avisa al panel; carrera sin perder mensajes.
import { describe, expect, it } from "vitest";
import { handleInboundWhatsAppMessage, responderTrasEspera, recibirMensajeConEspera } from "../src/whatsapp/inbound.ts";
import { extractMetaEchoes, registrarEcoDeApp } from "../src/whatsapp/eco-app.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate } from "../src/index.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const CLIENTE = "5219991234567";
const PHONE = `+${CLIENTE}`;
const STAFF = "00000000-0000-4000-8000-0000000000f1";
const PROPERTY = "00000000-0000-4000-8000-0000000000a1";
const CONV = "00000000-0000-4000-8000-0000000000c1";
const echoPayload = (id: string, text: string) => ({ entry: [{ changes: [{ field: "smb_message_echoes", value: { message_echoes: [{ from: "5219990000000", to: CLIENTE, id, timestamp: "1790000000", type: "text", text: { body: text } }] } }] }] });

function setup(conConversacion = true) {
  const f = buildRestaurantFixture();
  const store = new InMemoryConversacionesRepository({ actorUserId: STAFF });
  const gate = new InMemoryHandoffAgentGate(store);
  // El eco nunca crea la conversacion de WhatsApp: tiene que existir (la crea el primer mensaje del cliente).
  if (conConversacion) f.repo.seedWhatsAppConversation(f.organizationId, PHONE, { messages: [], status: "active", orderId: null, propertyId: PROPERTY });
  if (conConversacion) store.conversaciones.push({ canal: "whatsapp", id: CONV, organizationId: f.organizationId, propertyId: PROPERTY, telefono: PHONE, mensajes: [], actividadAt: new Date().toISOString() });
  let turnos = 0;
  let durante: (() => Promise<void>) | null = null;
  const turnHandler: WhatsAppTurnHandler = {
    async handleInboundMessage() {
      turnos += 1;
      if (durante) await durante();
      return { reply: "Respuesta del asistente", orderId: null, propertyId: null };
    },
  };
  const eco = (id: string, text: string) => registrarEcoDeApp(f.repo, { organizationId: f.organizationId, propertyId: PROPERTY, eco: extractMetaEchoes(echoPayload(id, text)).ecos[0]!, handoffGate: gate });
  const cliente = (messageId: string, body: string) =>
    handleInboundWhatsAppMessage(f.repo, turnHandler, { organizationId: f.organizationId, messageId, phone: PHONE, body, phoneNumberId: "700", propertyId: PROPERTY, handoffGate: gate });
  const hilo = () => f.repo.whatsappAppendTurn(f.organizationId, PHONE, [], null, null, null);
  return { f, store, gate, eco, cliente, hilo, turnos: () => turnos, duranteElTurno: (fn: () => Promise<void>) => (durante = fn), turnHandler };
}

describe("el eco de la app silencia al asistente", () => {
  it("tras el eco, el asistente calla; el mensaje del cliente queda guardado y el panel recibe aviso", async () => {
    const t = setup();
    expect(await t.eco("wamid.E1", "Ya le atiendo yo")).toBe("guardado");
    const h = t.store.handoffs.find((x) => x.conversationId === CONV);
    expect(h).toEqual(expect.objectContaining({ estado: "tomada", tomadaPorApp: true, tomadaPor: null, motivo: "personal_app" }));
    const out = await t.cliente("wamid.C1", "Gracias, y cuanto tarda?");
    expect(out).toEqual({ ok: true, retryable: false });
    expect(t.turnos()).toBe(0);
    expect((await t.hilo()).map((m) => [m.role, m.content])).toEqual([["assistant", "Ya le atiendo yo"], ["user", "Gracias, y cuanto tarda?"]]);
    expect(t.gate.avisosClienteConTomaApp).toEqual([{ handoffId: h!.id, propertyId: PROPERTY }]);
  });

  it("un segundo eco no abre otra toma: la misma sigue tomada y refresca la ultima actividad humana", async () => {
    const t = setup();
    await t.eco("wamid.E1", "uno");
    await t.eco("wamid.E2", "dos");
    expect(t.store.handoffs.filter((x) => x.estado === "tomada")).toHaveLength(1);
  });

  it("un eco convierte una toma PENDIENTE (el asistente pidio una persona) en tomada por la app", async () => {
    const t = setup();
    await t.gate.solicitarHumano({ organizationId: t.f.organizationId, propertyId: PROPERTY, phone: PHONE, motivo: "queja" });
    await t.eco("wamid.E1", "Soy el gerente, ya lo veo");
    expect(t.store.handoffs).toHaveLength(1);
    expect(t.store.handoffs[0]).toEqual(expect.objectContaining({ estado: "tomada", tomadaPorApp: true, motivo: "queja" }));
  });

  it("devuelta la toma (por el panel o por inactividad) el asistente vuelve a contestar", async () => {
    const t = setup();
    await t.eco("wamid.E1", "Ya le atiendo yo");
    const id = t.store.handoffs[0]!.id;
    await t.store.devolver(t.f.organizationId, PROPERTY, id);
    expect(await t.cliente("wamid.C2", "Hola?")).toEqual(expect.objectContaining({ reply: "Respuesta del asistente" }));
    expect(t.turnos()).toBe(1);
  });

  it("una persona del panel puede tomar la conversacion que abrio el eco (no recibe 409)", async () => {
    const t = setup();
    await t.eco("wamid.E1", "Ya le atiendo yo");
    const id = await t.store.tomar(t.f.organizationId, PROPERTY, "whatsapp", CONV);
    expect(id).toBe(t.store.handoffs[0]!.id);
    expect(t.store.handoffs[0]).toEqual(expect.objectContaining({ tomadaPor: STAFF, tomadaPorApp: false }));
  });

  it("eco de un cliente sin conversacion: se acusa sin crearla ni abrir toma (P1-3)", async () => {
    const t = setup(false);
    expect(await t.eco("wamid.E1", "Hola, le escribo primero")).toBe("sin_conversacion");
    expect(t.store.handoffs).toHaveLength(0);
    expect(await t.hilo()).toHaveLength(0);
  });

  it("base sin la migracion 101 (el gate devuelve null): el eco se guarda y el asistente sigue como antes", async () => {
    const t = setup();
    t.store.disponible = false;
    expect(await t.eco("wamid.E1", "hola")).toBe("guardado");
    expect(t.store.handoffs).toHaveLength(0);
    expect(await t.cliente("wamid.C1", "hola")).toEqual(expect.objectContaining({ reply: "Respuesta del asistente" }));
  });

  it("P1-4: un gate que lanza (error real, no «no aplica») devuelve `fallo` y el reintento termina la toma sin duplicar el mensaje", async () => {
    const t = setup();
    const original = t.gate.tomarPorEcoDeApp.bind(t.gate);
    t.gate.tomarPorEcoDeApp = async () => { throw new Error("42501 simulado"); };
    expect(await t.eco("wamid.E1", "hola")).toBe("fallo");
    expect(t.store.handoffs).toHaveLength(0);
    t.gate.tomarPorEcoDeApp = original;
    expect(await t.eco("wamid.E1", "hola")).toBe("guardado");
    expect(t.store.handoffs).toHaveLength(1);
    expect(await t.hilo()).toHaveLength(1);
  });

  it("P2-9: el eco llega como 52... y el cliente como 521...: la toma se abre en SU conversacion", async () => {
    const t = setup();
    const e = extractMetaEchoes(echoPayload("wamid.E9", "hola")).ecos[0]!;
    expect(await registrarEcoDeApp(t.f.repo, { organizationId: t.f.organizationId, propertyId: PROPERTY, eco: { ...e, to: "529991234567" }, handoffGate: t.gate })).toBe("guardado");
    expect(t.store.handoffs).toHaveLength(1);
    expect(t.store.handoffs[0]).toEqual(expect.objectContaining({ estado: "tomada", tomadaPorApp: true }));
  });

  it("P2-5: un eco con hora muy vieja o muy futura fija el silencio dentro de [ahora - 5 min, ahora + 1 min], pero `at` conserva la hora de Meta", async () => {
    const t = setup();
    const visto: number[] = [];
    const original = t.gate.tomarPorEcoDeApp.bind(t.gate);
    t.gate.tomarPorEcoDeApp = async (i) => { visto.push(i.atMs); return original(i); };
    const e = extractMetaEchoes(echoPayload("wamid.EOLD", "hola")).ecos[0]!;
    const ahora = 1_800_000_000_000;
    await registrarEcoDeApp(t.f.repo, { organizationId: t.f.organizationId, propertyId: PROPERTY, eco: { ...e, atMs: ahora - 3 * 86_400_000 }, handoffGate: t.gate, ahoraMs: () => ahora });
    await registrarEcoDeApp(t.f.repo, { organizationId: t.f.organizationId, propertyId: PROPERTY, eco: { ...e, id: "wamid.EFUT", atMs: ahora + 86_400_000 }, handoffGate: t.gate, ahoraMs: () => ahora });
    expect(visto).toEqual([ahora - 5 * 60_000, ahora + 60_000]);
    expect((await t.hilo())[0]).toEqual(expect.objectContaining({ at: new Date(ahora - 3 * 86_400_000).toISOString() }));
  });

  it("el eco de lo que mando la plataforma (asistente) no abre toma ni silencia (P1-2)", async () => {
    const t = setup();
    await t.f.repo.enqueueMessagingOutbox(t.f.organizationId, "whatsapp", "whatsapp.inbound_reply", "k1", { to: PHONE, body: "x" });
    const [fila] = await t.f.repo.claimMessagingOutboxBatch(5, 60);
    await t.f.repo.markMessagingOutboxSent(fila!.id, { providerMessageId: "wamid.ASISTENTE" });
    expect(await t.eco("wamid.ASISTENTE", "Respuesta del asistente")).toBe("propio");
    expect(t.store.handoffs).toHaveLength(0);
    expect(await t.cliente("wamid.C7", "hola")).toEqual(expect.objectContaining({ reply: "Respuesta del asistente" }));
  });

  it("P2-6: un mensaje previo del personal (eco) no cuenta como contacto del asistente: el aviso de privacidad sale en el primer turno del asistente", async () => {
    const t = setup();
    const privacidad = new (await import("../src/index.ts")).InMemoryPrivacidadRepository();
    await t.eco("wamid.E1", "Hola, soy del restaurante");
    // Se devuelve la toma para que el asistente conteste.
    await t.store.devolver(t.f.organizationId, PROPERTY, t.store.handoffs[0]!.id);
    const out = await handleInboundWhatsAppMessage(t.f.repo, t.turnHandler, { organizationId: t.f.organizationId, messageId: "wamid.C1", phone: PHONE, body: "Hola", phoneNumberId: "700", propertyId: PROPERTY, handoffGate: t.gate, privacy: privacidad });
    expect(out).toEqual(expect.objectContaining({ reply: expect.stringContaining("Aviso de privacidad") }));
  });
});

describe("carrera: cliente y personal casi simultaneos", () => {
  it("el personal contesta MIENTRAS el modelo piensa: la respuesta del asistente se descarta y NO se pierde ningun mensaje", async () => {
    const t = setup();
    t.duranteElTurno(async () => {
      await t.eco("wamid.E1", "Yo me encargo, un momento");
    });
    const out = await t.cliente("wamid.C1", "Quiero cambiar mi pedido");
    expect(out).toEqual({ ok: true, retryable: false });
    expect(t.turnos()).toBe(1);
    const h = await t.hilo();
    expect(h.map((m) => [m.role, m.content])).toEqual([["user", "Quiero cambiar mi pedido"], ["assistant", "Yo me encargo, un momento"]]);
    expect(h.some((m) => m.content === "Respuesta del asistente")).toBe(false);
    expect(t.gate.avisosClienteConTomaApp).toHaveLength(1);
  });

  it("el eco llega DESPUES de que el asistente ya contesto: quedan los tres mensajes, en orden de llegada", async () => {
    const t = setup();
    await t.cliente("wamid.C1", "Hola");
    await t.eco("wamid.E1", "Buenas, soy el gerente");
    expect((await t.hilo()).map((m) => m.content)).toEqual(["Hola", "Respuesta del asistente", "Buenas, soy el gerente"]);
  });

  it("ruta de produccion (espera de rafagas): mismo descarte si el eco llega mientras el modelo piensa", async () => {
    const t = setup();
    t.duranteElTurno(async () => {
      await t.eco("wamid.E1", "Yo me encargo");
    });
    const args = { organizationId: t.f.organizationId, messageId: "wamid.C1", phone: PHONE, body: "Quiero cambiar mi pedido" };
    expect((await recibirMensajeConEspera(t.f.repo, args)).estado).toBe("responder");
    const out = await responderTrasEspera(t.f.repo, t.turnHandler, { organizationId: t.f.organizationId, messageId: "wamid.C1", phone: PHONE, phoneNumberId: "700", propertyId: PROPERTY, handoffGate: t.gate });
    expect(out.retryable).toBe(false);
    expect((await t.hilo()).map((m) => m.content)).toEqual(["Quiero cambiar mi pedido", "Yo me encargo"]);
  });

  it("P2-7: un turno con accion mutante (cancelacion, contacto, agregado) se entrega aunque el eco llegue a la vez", async () => {
    const t = setup();
    const mutante: WhatsAppTurnHandler = { async handleInboundMessage() { await t.eco("wamid.E1", "ok"); return { reply: "Ya registre su cancelacion", orderId: null, propertyId: PROPERTY, accionMutante: true as const }; } };
    const out = await handleInboundWhatsAppMessage(t.f.repo, mutante, { organizationId: t.f.organizationId, messageId: "wamid.C1", phone: PHONE, body: "cancela", phoneNumberId: "700", propertyId: PROPERTY, handoffGate: t.gate });
    expect(out).toEqual(expect.objectContaining({ reply: "Ya registre su cancelacion" }));
  });

  it("un turno que creo un pedido se entrega aunque el eco llegue a la vez (la confirmacion no se pierde)", async () => {
    const t = setup();
    const conPedido: WhatsAppTurnHandler = { async handleInboundMessage() { await t.eco("wamid.E1", "ok"); return { reply: "Pedido creado", orderId: "00000000-0000-4000-8000-0000000000d1", propertyId: PROPERTY }; } };
    const out = await handleInboundWhatsAppMessage(t.f.repo, conPedido, { organizationId: t.f.organizationId, messageId: "wamid.C1", phone: PHONE, body: "confirmo", phoneNumberId: "700", propertyId: PROPERTY, handoffGate: t.gate });
    expect(out).toEqual(expect.objectContaining({ reply: "Pedido creado" }));
  });
});
