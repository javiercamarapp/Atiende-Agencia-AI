// PM PR-9 -- el aviso de privacidad simplificado / "asistente virtual" en el PRIMER mensaje de WhatsApp
// y el fast-path ARCO dentro de `handleInboundWhatsAppMessage`.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { InMemoryPrivacidadRepository } from "../src/privacidad/in-memory-repository.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PHONE = "+5219981234567";

function setup() {
  const { repo, organizationId } = buildRestaurantFixture();
  const privacy = new InMemoryPrivacidadRepository();
  const handle = vi.fn<WhatsAppTurnHandler["handleInboundMessage"]>(async () => ({ reply: "Buenas tardes, ¿qué se te antoja?", orderId: null, propertyId: null }));
  const turnHandler: WhatsAppTurnHandler = { handleInboundMessage: handle };
  const send = (body: string, opts: { privacy?: InMemoryPrivacidadRepository | null; phone?: string } = {}) =>
    handleInboundWhatsAppMessage(repo, turnHandler, {
      organizationId,
      messageId: randomUUID(),
      phone: opts.phone ?? PHONE,
      body,
      phoneNumberId: "pn-1",
      ...(opts.privacy === null ? {} : { privacy: opts.privacy ?? privacy }),
    });
  return { repo, organizationId, privacy, handle, send };
}

describe("aviso de privacidad en el primer mensaje de WhatsApp", () => {
  it("el PRIMER mensaje lleva el aviso simplificado (asistente virtual + ARCO) antes de la respuesta del agente", async () => {
    const { send, privacy, organizationId } = setup();
    privacy.configs.set(organizationId, {
      responsibleName: "Los Taquitos de PM",
      noticeUrl: "https://ejemplo.mx/aviso",
      noticeVersion: "v1",
      conversationRetentionDays: 90,
      voiceRetentionDays: 30,
      recordingConsentRequired: true,
      configurada: true,
    });
    const outcome = await send("hola");
    expect(outcome.ok).toBe(true);
    expect(outcome.reply).toContain("asistente virtual");
    expect(outcome.reply).toContain("https://ejemplo.mx/aviso");
    expect(outcome.reply).toContain("90 días");
    expect(outcome.reply!.indexOf("asistente virtual")).toBeLessThan(outcome.reply!.indexOf("¿qué se te antoja?"));
    expect(privacy.notices.size).toBe(1);
  });

  it("el segundo mensaje del mismo telefono NO repite el aviso", async () => {
    const { send } = setup();
    await send("hola");
    const second = await send("quiero 3 tacos");
    expect(second.reply).toBe("Buenas tardes, ¿qué se te antoja?");
  });

  it("otro telefono recibe su propio aviso", async () => {
    const { send } = setup();
    await send("hola");
    const other = await send("hola", { phone: "+5219990000000" });
    expect(other.reply).toContain("asistente virtual");
  });

  it("subir la version del aviso lo vuelve a mostrar una vez", async () => {
    const { send, privacy, organizationId } = setup();
    await send("hola");
    privacy.configs.set(organizationId, { responsibleName: null, noticeUrl: null, noticeVersion: "v2", conversationRetentionDays: 180, voiceRetentionDays: 30, recordingConsentRequired: true, configurada: true });
    const again = await send("hola otra vez");
    expect(again.reply).toContain("asistente virtual");
    const third = await send("gracias");
    expect(third.reply).not.toContain("asistente virtual");
  });

  it("la respuesta con aviso es la que se guarda en el historial y la que se encola para enviar", async () => {
    const { send, repo, organizationId } = setup();
    const outcome = await send("hola");
    const messages = await repo.whatsappAppendTurn(organizationId, PHONE, [], null, null, null);
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(last.content).toBe(outcome.reply);
  });

  it("sin repositorio de privacidad (despliegue anterior) el comportamiento no cambia: sin aviso", async () => {
    const { send } = setup();
    const outcome = await send("hola", { privacy: null });
    expect(outcome.reply).toBe("Buenas tardes, ¿qué se te antoja?");
  });

  it("base sin migrar: sin evidencia disponible, el aviso sale solo en el primer mensaje de la conversacion", async () => {
    const { send, privacy } = setup();
    privacy.migrada = false;
    const first = await send("hola");
    expect(first.reply).toContain("asistente virtual");
    const second = await send("quiero tacos");
    expect(second.reply).toBe("Buenas tardes, ¿qué se te antoja?");
  });
});

describe("fast-path ARCO dentro del webhook", () => {
  it("una solicitud ARCO se atiende SIN pasar por el agente (LLM) y registra la solicitud del telefono que escribe", async () => {
    const { send, handle, privacy } = setup();
    await send("hola"); // primer mensaje: aviso
    handle.mockClear();
    const outcome = await send("quiero acceso a mis datos personales");
    expect(handle).not.toHaveBeenCalled();
    expect(outcome.reply).toContain("CONFIRMO");
    expect(privacy.requests).toHaveLength(1);
    expect(privacy.requests[0]).toMatchObject({ customerPhone: PHONE, rightType: "acceso", status: "pendiente_confirmacion", channel: "whatsapp" });
  });

  it("CONFIRMO desde el mismo numero arranca los plazos", async () => {
    const { send, privacy } = setup();
    await send("quiero que borren mis datos personales");
    const outcome = await send("CONFIRMO");
    expect(outcome.reply).toContain("quedó registrada");
    expect(privacy.requests[0]!.status).toBe("recibida");
    expect(privacy.requests[0]!.responseDueAt).not.toBeNull();
  });

  it("si es el primer mensaje, la respuesta ARCO tambien lleva el aviso", async () => {
    const { send } = setup();
    const outcome = await send("quiero acceso a mis datos personales");
    expect(outcome.reply).toContain("asistente virtual");
    expect(outcome.reply).toContain("CONFIRMO");
  });

  it("un pedido normal que dice 'cancelar' sigue al agente (no es ARCO)", async () => {
    const { send, handle } = setup();
    await send("cancelar mi pedido por favor");
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("base sin migrar: la solicitud ARCO cae al agente (nunca promete un seguimiento inexistente)", async () => {
    const { send, handle, privacy } = setup();
    privacy.migrada = false;
    await send("quiero acceso a mis datos personales");
    expect(handle).toHaveBeenCalledTimes(1);
    expect(privacy.requests).toHaveLength(0);
  });

  it("el mensaje guardado en el historial sigue redactado (tarjetas) aunque sea una solicitud ARCO", async () => {
    const { send, repo, organizationId } = setup();
    await send("quiero acceso a mis datos personales, tarjeta 4111 1111 1111 1111");
    const messages = await repo.whatsappAppendTurn(organizationId, PHONE, [], null, null, null);
    expect(JSON.stringify(messages)).not.toContain("4111");
  });
});

describe("convivencia con el handoff a humano (R-21)", () => {
  const gate = { estadoParaAgente: async () => "tomada" as const, solicitarHumano: async () => null };

  it("con una toma de handoff abierta el agente calla ante un mensaje normal (sin aviso ni respuesta)", async () => {
    const { repo, organizationId, handle, privacy } = setup();
    const outcome = await handleInboundWhatsAppMessage(
      repo,
      { handleInboundMessage: handle },
      { organizationId, messageId: randomUUID(), phone: PHONE, body: "hola, sigo esperando", phoneNumberId: "pn-1", handoffGate: gate, privacy },
    );
    expect(outcome).toEqual({ ok: true, retryable: false });
    expect(handle).not.toHaveBeenCalled();
    expect(privacy.notices.size).toBe(0);
  });

  it("aun con handoff abierto, una solicitud ARCO explicita SI se atiende (obligacion legal, no pasa por el agente)", async () => {
    const { repo, organizationId, handle, privacy } = setup();
    const outcome = await handleInboundWhatsAppMessage(
      repo,
      { handleInboundMessage: handle },
      { organizationId, messageId: randomUUID(), phone: PHONE, body: "quiero acceso a mis datos personales", phoneNumberId: "pn-1", handoffGate: gate, privacy },
    );
    expect(outcome.reply).toContain("CONFIRMO");
    expect(handle).not.toHaveBeenCalled();
    expect(privacy.requests).toHaveLength(1);
  });
});
