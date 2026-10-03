// C-11 -- bandeja de conversaciones de WhatsApp de citas con handoff a humano. Cada caso afirma el EFECTO (que se guardo, que NO se
// guardo, a quien le llego): tomar una conversacion hace que el agente CALLE (el LLM no se invoca y nada sale por el outbox), devolver lo
// reactiva, una escalacion de crisis abre un handoff pendiente marcado, y contra la base sin migrar todo degrada sin romper nada.
// Las reglas de RLS/GRANT las verifica scripts/verify-citas-conversaciones-handoff/ contra Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDefaultConversationGuard, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { runCrisisGuardrail } from "../src/crisis-guardrail.ts";
import {
  ConversacionesNoDisponibleError,
  ConversacionesRechazadaError,
  InMemoryConversacionesRepository,
  InMemoryHandoffAgentGate,
  PostgresConversacionesRepository,
  PostgresHandoffAgentGate,
} from "../src/conversaciones/index.ts";
import { buildCitasFixture } from "./fixtures.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const PHONE = "+5219981234567";
const PNID = "1234567890";

function montar() {
  const fixture = buildCitasFixture();
  const staffA = randomUUID();
  const staffB = randomUUID();
  const admin = randomUUID();
  const store = new InMemoryConversacionesRepository({ actorUserId: staffA, nombres: { [staffA]: "Staff A", [staffB]: "Staff B", [admin]: "Admin" } });
  const gate = new InMemoryHandoffAgentGate(store);
  const conversationId = randomUUID();
  const propertyId = randomUUID();
  store.conversaciones.push({ id: conversationId, organizationId: fixture.organizationId, propertyId: null, telefono: PHONE, mensajes: [{ rol: "cliente", texto: "Hola" }], actividadAt: new Date().toISOString() });
  store.organizacionesConNumero.add(fixture.organizationId);
  let llamadasAlAgente = 0;
  const turnHandler: WhatsAppTurnHandler = {
    async handleInboundMessage() {
      llamadasAlAgente += 1;
      return { reply: "Claro, ¿qué día te gustaría agendar?", appointmentId: null, propertyId: null };
    },
  };
  const guard = createDefaultConversationGuard({});
  let n = 0;
  const entrante = (body: string) =>
    handleInboundWhatsAppMessage(fixture.repo, turnHandler, guard, { organizationId: fixture.organizationId, messageId: `wamid-${++n}-${randomUUID()}`, phone: PHONE, body, phoneNumberId: PNID, handoffGate: gate });
  const mensajes = async () => fixture.repo.whatsappAppendTurn(fixture.organizationId, PHONE, [], null, null, null);
  const pendientesEnOutbox = async () => (await fixture.repo.claimMessagingOutboxBatch(50, 60)).length;
  return { fixture, store, gate, conversationId, propertyId, staffA, staffB, admin, entrante, mensajes, pendientesEnOutbox, llamadas: () => llamadasAlAgente };
}

describe("agente silenciado mientras un humano tiene la conversacion", () => {
  it("control: sin handoff el agente responde y la respuesta sale por el outbox", async () => {
    const t = montar();
    const r = await t.entrante("Quiero una cita");
    expect(r).toMatchObject({ ok: true, reply: "Claro, ¿qué día te gustaría agendar?" });
    expect(t.llamadas()).toBe(1);
    expect(await t.pendientesEnOutbox()).toBe(1);
  });

  it("tomar: el SIGUIENTE mensaje entrante NO genera respuesta del agente (sin LLM, sin outbox) pero SI queda guardado", async () => {
    const t = montar();
    await t.entrante("Quiero una cita");
    await t.fixture.repo.claimMessagingOutboxBatch(50, 60); // vacia el outbox del primer turno
    const antes = (await t.mensajes()).length;

    await t.store.tomar(t.fixture.organizationId, t.propertyId, t.conversationId);
    const r = await t.entrante("¿Hay alguien ahi?");

    expect(r).toEqual({ ok: true, retryable: false, silenciado: true });
    expect(t.llamadas()).toBe(1); // el LLM NO se invoco para el segundo mensaje
    expect(await t.pendientesEnOutbox()).toBe(0); // nada sale hacia el cliente
    const despues = await t.mensajes();
    expect(despues).toHaveLength(antes + 1); // solo se guardo el mensaje del cliente
    expect(despues.at(-1)).toMatchObject({ role: "user", content: "¿Hay alguien ahi?" });
  });

  it("devolver reactiva al agente: el siguiente mensaje vuelve a responder", async () => {
    const t = montar();
    const handoffId = await t.store.tomar(t.fixture.organizationId, t.propertyId, t.conversationId);
    expect((await t.entrante("hola")).silenciado).toBe(true);
    expect(t.llamadas()).toBe(0);

    expect(await t.store.devolver(t.fixture.organizationId, t.propertyId, handoffId)).toBe(true);
    const r = await t.entrante("gracias, ahora quiero agendar");
    expect(r).toMatchObject({ ok: true, reply: "Claro, ¿qué día te gustaría agendar?" });
    expect(t.llamadas()).toBe(1);
  });

  it("cerrar tambien deja al agente libre", async () => {
    const t = montar();
    const handoffId = await t.store.tomar(t.fixture.organizationId, t.propertyId, t.conversationId);
    await t.store.cerrar(t.fixture.organizationId, t.propertyId, handoffId);
    expect((await t.entrante("hola")).reply).toBeDefined();
  });

  it("una toma PENDIENTE (el agente pidio un humano y nadie la ha tomado) tambien lo silencia y registra el ping del cliente", async () => {
    const t = montar();
    const id = await t.gate.solicitarHumano({ organizationId: t.fixture.organizationId, phone: PHONE, motivo: "pide una persona", crisis: false });
    expect(id).not.toBeNull();
    expect((await t.entrante("sigo esperando")).silenciado).toBe(true);
    expect(t.llamadas()).toBe(0);
    expect(t.store.handoffs[0]!.ultimoClienteAt).not.toBeNull();
  });

  it("un handoff de OTRA organizacion o de OTRO telefono no silencia al agente", async () => {
    const t = montar();
    const otraConv = randomUUID();
    t.store.conversaciones.push({ id: otraConv, organizationId: randomUUID(), propertyId: null, telefono: PHONE, mensajes: [], actividadAt: new Date().toISOString() });
    const otroTel = randomUUID();
    t.store.conversaciones.push({ id: otroTel, organizationId: t.fixture.organizationId, propertyId: null, telefono: "+5219990000000", mensajes: [], actividadAt: new Date().toISOString() });
    await t.store.comoActor(t.staffA).tomar(t.store.conversaciones[1]!.organizationId, t.propertyId, otraConv);
    await t.store.comoActor(t.staffA).tomar(t.fixture.organizationId, t.propertyId, otroTel);
    expect((await t.entrante("hola")).reply).toBeDefined();
    expect(t.llamadas()).toBe(1);
  });

  it("sin el puerto (despliegue sin migrar o sin cablear) el agente responde como siempre", async () => {
    const t = montar();
    await t.store.tomar(t.fixture.organizationId, t.propertyId, t.conversationId);
    const r = await handleInboundWhatsAppMessage(t.fixture.repo, { handleInboundMessage: async () => ({ reply: "ok", appointmentId: null, propertyId: null }) }, createDefaultConversationGuard({}), {
      organizationId: t.fixture.organizationId, messageId: "wamid-sin-gate", phone: PHONE, body: "hola", phoneNumberId: PNID,
    });
    expect(r).toMatchObject({ ok: true, reply: "ok" });
  });

  it("base sin migrar (disponible=false): el gate devuelve null y el agente responde", async () => {
    const t = montar();
    await t.store.tomar(t.fixture.organizationId, t.propertyId, t.conversationId);
    t.store.disponible = false;
    expect((await t.entrante("hola")).reply).toBeDefined();
  });
});

describe("escalacion de crisis abre un handoff", () => {
  async function conCrisis() {
    const t = montar();
    t.fixture.repo.seedTenantConfig({ organizationId: t.fixture.organizationId, rubro: "psicologo" });
    return t;
  }

  it("una palabra clave real abre un handoff PENDIENTE marcado como crisis, con motivo fijo (sin la palabra clave ni el mensaje) y una notificacion critica", async () => {
    const t = await conCrisis();
    const r = await t.entrante("Ya no puedo más, siento que ya no le veo sentido a nada");
    expect(r.reply).toContain("911"); // el mensaje de crisis tal cual (determinista), nunca el agente
    expect(t.llamadas()).toBe(0);
    expect(t.store.handoffs).toHaveLength(1);
    expect(t.store.handoffs[0]).toMatchObject({ estado: "pendiente", solicitadoPor: "agente", crisis: true });
    expect(t.store.handoffs[0]!.motivo).not.toMatch(/sentido|puedo/i);
    expect(t.store.notificaciones).toEqual([{ evento: "citas.conversacion.handoff", organizationId: t.fixture.organizationId, clave: t.store.handoffs[0]!.id, critica: true }]);
  });

  it("aparece en la bandeja marcada y primera; despues de la crisis el agente calla hasta que una persona la atienda", async () => {
    const t = await conCrisis();
    t.store.conversaciones.push({ id: randomUUID(), organizationId: t.fixture.organizationId, propertyId: null, telefono: "+5219990000009", mensajes: [{ rol: "cliente", texto: "otra" }], actividadAt: new Date(Date.now() + 1000).toISOString() });
    await t.entrante("quiero morirme");
    const bandeja = await t.store.listarBandeja(t.fixture.organizationId, t.propertyId, {});
    expect(bandeja.valor.items[0]).toMatchObject({ conversationId: t.conversationId, crisis: true, estado: "pendiente" });
    expect(bandeja.valor.items[1]!.crisis).toBe(false);

    expect((await t.entrante("hola?")).silenciado).toBe(true);
    expect(t.llamadas()).toBe(0);
  });

  it("repetir la crisis no duplica el handoff ni la notificacion (idempotente por conversacion)", async () => {
    const t = await conCrisis();
    await t.entrante("quiero morirme");
    await t.entrante("quiero morirme");
    expect(t.store.handoffs).toHaveLength(1);
    expect(t.store.notificaciones).toHaveLength(1);
  });

  it("una crisis con una persona ya atendiendo SIGUE respondiendo el aviso de crisis (la capa determinista no se calla)", async () => {
    const t = await conCrisis();
    await t.store.tomar(t.fixture.organizationId, t.propertyId, t.conversationId);
    const r = await t.entrante("quiero morirme");
    expect(r.reply).toContain("911");
    expect(t.fixture.repo.getEmergencyEscalations()).toHaveLength(1);
  });

  it("sin el puerto la escalacion se registra igual y no se crea ningun handoff (comportamiento anterior)", async () => {
    const t = await conCrisis();
    const result = await runCrisisGuardrail(t.fixture.repo, t.fixture.organizationId, PHONE, "quiero morirme");
    expect(result.triggered).toBe(true);
    expect(t.store.handoffs).toHaveLength(0);
  });

  it("un rubro que no es de salud no abre handoff", async () => {
    const t = montar();
    t.fixture.repo.seedTenantConfig({ organizationId: t.fixture.organizationId, rubro: "barberia" });
    await t.entrante("quiero morirme");
    expect(t.store.handoffs).toHaveLength(0);
  });
});

describe("reglas de la bandeja (espejo de la migracion 031)", () => {
  it("la segunda persona que intenta tomar recibe HandoffYaTomadoError; quien ya la tiene la retoma sin error", async () => {
    const t = montar();
    const org = t.fixture.organizationId;
    const id = await t.store.comoActor(t.staffA).tomar(org, t.propertyId, t.conversationId);
    await expect(t.store.comoActor(t.staffB).tomar(org, t.propertyId, t.conversationId)).rejects.toMatchObject({ name: "HandoffYaTomadoError" });
    expect(await t.store.comoActor(t.staffA).tomar(org, t.propertyId, t.conversationId)).toBe(id);
  });

  it("solo quien tomo (o un administrador) devuelve/cierra; devolver dos veces es idempotente (false)", async () => {
    const t = montar();
    const org = t.fixture.organizationId;
    const id = await t.store.comoActor(t.staffA).tomar(org, t.propertyId, t.conversationId);
    await expect(t.store.comoActor(t.staffB).devolver(org, t.propertyId, id)).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    expect(await t.store.comoActor(t.admin, true).devolver(org, t.propertyId, id)).toBe(true);
    expect(await t.store.comoActor(t.admin, true).devolver(org, t.propertyId, id)).toBe(false);
  });

  it("responder: solo quien la tiene tomada; sin numero de WhatsApp -> SinNumeroWhatsappError; encola SIN envio real y queda en el historial como humano", async () => {
    const t = montar();
    const org = t.fixture.organizationId;
    const id = await t.store.comoActor(t.staffA).tomar(org, t.propertyId, t.conversationId);
    await expect(t.store.comoActor(t.staffB).responder(org, t.propertyId, id, "hola")).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    t.store.organizacionesConNumero.clear();
    await expect(t.store.comoActor(t.staffA).responder(org, t.propertyId, id, "hola")).rejects.toMatchObject({ name: "SinNumeroWhatsappError" });
    t.store.organizacionesConNumero.add(org);
    await t.store.comoActor(t.staffA).responder(org, t.propertyId, id, "  Con gusto le ayudo  ");
    expect(t.store.outbox).toEqual([expect.objectContaining({ organizationId: org, to: PHONE, body: "Con gusto le ayudo" })]);
    const detalle = await t.store.detalle(org, t.propertyId, t.conversationId);
    expect(detalle.valor!.mensajes.at(-1)).toEqual({ rol: "humano", texto: "Con gusto le ayudo" });
  });

  it("notas internas: con tope de 2000 y vacia rechazada", async () => {
    const t = montar();
    const org = t.fixture.organizationId;
    const id = await t.store.tomar(org, t.propertyId, t.conversationId);
    await expect(t.store.agregarNota(org, t.propertyId, id, "   ")).rejects.toMatchObject({ name: "ConversacionesValidacionError" });
    await expect(t.store.agregarNota(org, t.propertyId, id, "x".repeat(2001))).rejects.toMatchObject({ name: "ConversacionesValidacionError" });
    await t.store.agregarNota(org, t.propertyId, id, "Pidio factura");
    expect((await t.store.detalle(org, t.propertyId, t.conversationId)).valor!.notas.map((n) => n.texto)).toEqual(["Pidio factura"]);
  });

  it("otra organizacion no ve ni toma la conversacion; el detalle de una ajena es null", async () => {
    const t = montar();
    const otraOrg = randomUUID();
    expect((await t.store.listarBandeja(otraOrg, t.propertyId, {})).valor.items).toHaveLength(0);
    await expect(t.store.tomar(otraOrg, t.propertyId, t.conversationId)).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    expect((await t.store.detalle(otraOrg, t.propertyId, t.conversationId)).valor).toBeNull();
  });

  it("base sin migrar: lecturas -> disponible=false con lista vacia; escrituras -> ConversacionesNoDisponibleError", async () => {
    const t = montar();
    t.store.disponible = false;
    expect(await t.store.listarBandeja(t.fixture.organizationId, t.propertyId, {})).toEqual({ disponible: false, valor: { items: [], total: 0 } });
    await expect(t.store.tomar(t.fixture.organizationId, t.propertyId, t.conversationId)).rejects.toBeInstanceOf(ConversacionesNoDisponibleError);
  });

  it("la bandeja pagina y filtra por estado", async () => {
    const t = montar();
    const org = t.fixture.organizationId;
    for (let i = 0; i < 4; i += 1) t.store.conversaciones.push({ id: randomUUID(), organizationId: org, propertyId: null, telefono: `+52199800000${i}`, mensajes: [{ rol: "cliente", texto: `m${i}` }], actividadAt: new Date().toISOString() });
    await t.store.tomar(org, t.propertyId, t.conversationId);
    const p1 = await t.store.listarBandeja(org, t.propertyId, { limit: 2, offset: 0 });
    expect(p1.valor.total).toBe(5);
    expect(p1.valor.items).toHaveLength(2);
    expect(p1.valor.items[0]!.estado).toBe("tomada");
    expect((await t.store.listarBandeja(org, t.propertyId, { estado: "tomada" })).valor.items).toHaveLength(1);
    expect((await t.store.listarBandeja(org, t.propertyId, { estado: "agente" })).valor.items).toHaveLength(4);
  });
});

function sqlstate(code: string): Error & { code: string } {
  const err = new Error(`error simulado ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe("adaptador Postgres: SAVEPOINT contra la base sin migrar (AbortAwareFakeSession)", () => {
  it("el gate del agente: handoff_whatsapp_estado inexistente (42883) -> null y la sesion queda utilizable (el agente responde como siempre)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.handoff_whatsapp_estado/, respond: () => sqlstate("42883") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    expect(await new PostgresHandoffAgentGate(session).estadoParaAgente(randomUUID(), PHONE)).toBeNull();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_"))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("el gate: con la funcion presente devuelve el estado de la toma", async () => {
    const session = new AbortAwareFakeSession([{ match: /citas\.handoff_whatsapp_estado/, respond: () => [{ estado: "tomada" }] }]);
    expect(await new PostgresHandoffAgentGate(session).estadoParaAgente(randomUUID(), PHONE)).toBe("tomada");
  });

  it("solicitarHumano: funcion inexistente -> null, no emite notificacion y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.handoff_solicitar_whatsapp/, respond: () => sqlstate("42P01") },
      { match: /emit_notification/, respond: () => [{ n: 1 }] },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    expect(await new PostgresHandoffAgentGate(session).solicitarHumano({ organizationId: randomUUID(), phone: PHONE, motivo: "x", crisis: true })).toBeNull();
    expect(session.calls.some((c) => c.includes("emit_notification"))).toBe(false);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("solicitarHumano: con la funcion presente emite la notificacion del catalogo con la clave = id del handoff, sin PII", async () => {
    const handoffId = randomUUID();
    const emitidas: unknown[][] = [];
    const session = new AbortAwareFakeSession([
      { match: /citas\.handoff_solicitar_whatsapp/, respond: () => [{ id: handoffId }] },
      { match: /core\.emit_notification/, respond: () => [{ emit_notification: 2 }] },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      if (/core\.emit_notification/.test(sql)) emitidas.push(params ?? []);
      return original(sql, params);
    }) as typeof session.query;
    expect(await new PostgresHandoffAgentGate(session).solicitarHumano({ organizationId: randomUUID(), phone: PHONE, motivo: "x", crisis: true })).toBe(handoffId);
    expect(emitidas).toHaveLength(1);
    const texto = JSON.stringify(emitidas[0]);
    expect(texto).toContain(`citas.conversacion.handoff:${handoffId}`);
    expect(texto).toContain("critica");
    expect(texto).not.toContain(PHONE);
  });

  it("repositorio de staff: lecturas -> disponible=false; escrituras -> ConversacionesNoDisponibleError; la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.bandeja_conversaciones/, respond: () => sqlstate("42883") },
      { match: /citas\.handoff_tomar/, respond: () => sqlstate("42883") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresConversacionesRepository(session);
    expect(await repo.listarBandeja(randomUUID(), randomUUID(), {})).toEqual({ disponible: false, valor: { items: [], total: 0 } });
    await expect(repo.tomar(randomUUID(), randomUUID(), randomUUID())).rejects.toBeInstanceOf(ConversacionesNoDisponibleError);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("repositorio de staff: 55006 -> HandoffYaTomadoError, 42501 -> rechazada, P0002 -> sin numero, 23514 -> validacion", async () => {
    const mapa: Array<[string, string]> = [["55006", "HandoffYaTomadoError"], ["42501", "ConversacionesRechazadaError"], ["P0002", "SinNumeroWhatsappError"]];
    for (const [codigo, nombre] of mapa) {
      const session = new AbortAwareFakeSession([{ match: /citas\.handoff_(tomar|responder)/, respond: () => sqlstate(codigo) }]);
      const repo = new PostgresConversacionesRepository(session);
      const llamada = codigo === "P0002" ? repo.responder(randomUUID(), randomUUID(), randomUUID(), "hola") : repo.tomar(randomUUID(), randomUUID(), randomUUID());
      await expect(llamada).rejects.toMatchObject({ name: nombre });
    }
    const session = new AbortAwareFakeSession([{ match: /citas\.handoff_agregar_nota/, respond: () => sqlstate("23514") }]);
    await expect(new PostgresConversacionesRepository(session).agregarNota(randomUUID(), randomUUID(), randomUUID(), "x")).rejects.toMatchObject({ name: "ConversacionesValidacionError" });
  });
});
