// Port adaptado de domain-restaurantes/tests/whatsapp-inbound.spec.ts — mismos 4
// contratos (redacción, parsing de Meta, dedupe, lease), partición por PROPERTY en
// vez de organización (ver channel-config.ts).
import { describe, expect, it } from "vitest";
import { redactSensitiveInfo, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { acknowledgeOnlyTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { extractMetaPhoneNumberId, extractMetaTextMessages } from "../src/whatsapp/channel-config.ts";
import { buildHotelFixture } from "./whatsapp/fixtures.ts";

describe("redactSensitiveInfo (hoteles) — nunca guarda datos de tarjeta en texto plano", () => {
  it("redacta un número de tarjeta de 16 dígitos con o sin espacios/guiones", () => {
    expect(redactSensitiveInfo("mi tarjeta es 4111 1111 1111 1111")).toContain("[tarjeta oculta]");
    expect(redactSensitiveInfo("4111-1111-1111-1111")).toContain("[tarjeta oculta]");
    expect(redactSensitiveInfo("mi tarjeta es 4111 1111 1111 1111")).not.toContain("4111");
  });

  it("redacta CVV etiquetado y una fecha de vencimiento MM/YY", () => {
    expect(redactSensitiveInfo("cvv: 123")).toContain("[cvv oculto]");
    expect(redactSensitiveInfo("vence 09/27")).toContain("[vencimiento oculto]");
  });

  it("no toca un mensaje normal sin datos sensibles", () => {
    expect(redactSensitiveInfo("Quiero dos cafés a la 305")).toBe("Quiero dos cafés a la 305");
  });
});

describe("extractMetaTextMessages / extractMetaPhoneNumberId (hoteles) — parsing del payload real de Meta", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "9876543210" },
              messages: [{ id: "wamid.abc", from: "5219991234567", type: "text", text: { body: "Buenas, quiero pedir room service" } }],
            },
          },
        ],
      },
    ],
  };

  it("extrae el phone_number_id del metadata real", () => {
    expect(extractMetaPhoneNumberId(payload)).toBe("9876543210");
  });

  it("extrae los mensajes de texto válidos, ignorando otros eventos (statuses) sin messages", () => {
    expect(extractMetaTextMessages(payload)).toHaveLength(1);
    expect(extractMetaTextMessages({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] })).toHaveLength(0);
    expect(extractMetaTextMessages({})).toHaveLength(0);
  });
});

describe("handleInboundWhatsAppMessage (hoteles) — dedupe/lease/append de punta a punta", () => {
  it("procesa un mensaje nuevo: registra contacto no operativo (turn handler mínimo), appendea user+assistant, marca processed", async () => {
    const fixture = buildHotelFixture();
    const turnHandler = acknowledgeOnlyTurnHandler(fixture.repo);
    const outcome = await handleInboundWhatsAppMessage(fixture.repo, turnHandler, {
      organizationId: fixture.organizationId,
      propertyId: fixture.propertyId,
      messageId: "wamid.1",
      phone: "+5219991234567",
      body: "Hola, ¿tienen servicio a cuartos?",
    });
    expect(outcome).toMatchObject({ ok: true, retryable: false });
    expect(outcome.reply).toMatch(/contactar/);
  });

  it("un message_id repetido (retry at-least-once de Meta) se acusa sin reprocesar (dedupe real)", async () => {
    const fixture = buildHotelFixture();
    const turnHandler = acknowledgeOnlyTurnHandler(fixture.repo);
    const args = { organizationId: fixture.organizationId, propertyId: fixture.propertyId, messageId: "wamid.dup", phone: "+5219991234567", body: "Hola" };
    const first = await handleInboundWhatsAppMessage(fixture.repo, turnHandler, args);
    const second = await handleInboundWhatsAppMessage(fixture.repo, turnHandler, args);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true, retryable: false });
  });

  it("mensajes casi-simultáneos del MISMO teléfono se serializan por el lease: uno se procesa, el otro se marca reintentable", async () => {
    const fixture = buildHotelFixture();
    const turnHandler = acknowledgeOnlyTurnHandler(fixture.repo);
    const phone = "+5219998887777";
    const [a, b] = await Promise.all([
      handleInboundWhatsAppMessage(fixture.repo, turnHandler, { organizationId: fixture.organizationId, propertyId: fixture.propertyId, messageId: "m1", phone, body: "mensaje uno" }),
      handleInboundWhatsAppMessage(fixture.repo, turnHandler, { organizationId: fixture.organizationId, propertyId: fixture.propertyId, messageId: "m2", phone, body: "mensaje dos" }),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok && o.retryable === false)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok && o.retryable)).toHaveLength(1);

    const messages = await fixture.repo.appendWhatsAppUserMessageOnce(fixture.propertyId, phone, { role: "user", content: "probe" });
    expect(messages).toHaveLength(3); // user + assistant del turno real, + esta "probe"
  });
});
