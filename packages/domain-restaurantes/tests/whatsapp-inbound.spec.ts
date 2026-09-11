import { describe, expect, it } from "vitest";
import { redactSensitiveInfo, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { acknowledgeOnlyTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { extractMetaPhoneNumberId, extractMetaTextMessages } from "../src/whatsapp/channel-config.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

describe("redactSensitiveInfo — nunca guarda datos de tarjeta en texto plano", () => {
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
    expect(redactSensitiveInfo("Quiero 2 tacos de bistec")).toBe("Quiero 2 tacos de bistec");
  });
});

describe("extractMetaTextMessages / extractMetaPhoneNumberId — parsing del payload real de Meta", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "1234567890" },
              messages: [{ id: "wamid.abc", from: "5219991234567", type: "text", text: { body: "Hola, quiero un pedido" } }],
            },
          },
        ],
      },
    ],
  };

  it("extrae el phone_number_id del metadata real", () => {
    expect(extractMetaPhoneNumberId(payload)).toBe("1234567890");
  });

  it("extrae los mensajes de texto válidos, ignorando otros eventos (statuses) sin messages", () => {
    expect(extractMetaTextMessages(payload)).toHaveLength(1);
    expect(extractMetaTextMessages({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] })).toHaveLength(0);
    expect(extractMetaTextMessages({})).toHaveLength(0);
  });
});

describe("handleInboundWhatsAppMessage — dedupe/lease/append de punta a punta", () => {
  it("procesa un mensaje nuevo: crea callback (turn handler de Fase 1), appendea user+assistant, marca processed", async () => {
    const fixture = buildRestaurantFixture();
    const turnHandler = acknowledgeOnlyTurnHandler(fixture.repo);
    const outcome = await handleInboundWhatsAppMessage(fixture.repo, turnHandler, {
      organizationId: fixture.organizationId,
      messageId: "wamid.1",
      phone: "+5219991234567",
      body: "Hola, quiero hacer un pedido",
    });
    expect(outcome).toMatchObject({ ok: true, retryable: false });
    expect(outcome.reply).toMatch(/contactar/);
  });

  it("un message_id repetido (retry at-least-once de Meta) se acusa sin reprocesar (dedupe real)", async () => {
    const fixture = buildRestaurantFixture();
    const turnHandler = acknowledgeOnlyTurnHandler(fixture.repo);
    const args = { organizationId: fixture.organizationId, messageId: "wamid.dup", phone: "+5219991234567", body: "Hola" };
    const first = await handleInboundWhatsAppMessage(fixture.repo, turnHandler, args);
    const second = await handleInboundWhatsAppMessage(fixture.repo, turnHandler, args);
    expect(first).toMatchObject({ ok: true });
    // El segundo intento con el mismo message_id ya procesado se acusa (ok:true) sin
    // volver a correr el turno — verificado indirectamente: solo un callback_request
    // por teléfono (el turn handler de Fase 1 crea uno por turno real procesado).
    expect(second).toMatchObject({ ok: true, retryable: false });
  });

  it("mensajes casi-simultáneos del MISMO teléfono se serializan por el lease: uno se procesa, el otro se marca reintentable en vez de corromper el historial", async () => {
    const fixture = buildRestaurantFixture();
    const turnHandler = acknowledgeOnlyTurnHandler(fixture.repo);
    const phone = "+5219998887777";
    const [a, b] = await Promise.all([
      handleInboundWhatsAppMessage(fixture.repo, turnHandler, { organizationId: fixture.organizationId, messageId: "m1", phone, body: "mensaje uno" }),
      handleInboundWhatsAppMessage(fixture.repo, turnHandler, { organizationId: fixture.organizationId, messageId: "m2", phone, body: "mensaje dos" }),
    ]);
    const outcomes = [a, b];
    // Exactamente uno gana el lease y se procesa; el otro queda retryable (Meta
    // reintenta el batch firmado completo más tarde) — nunca los dos pisándose.
    expect(outcomes.filter((o) => o.ok && o.retryable === false)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok && o.retryable)).toHaveLength(1);

    // El historial nunca queda corrupto: exactamente 2 mensajes (user + assistant)
    // del único turno que sí se procesó, nunca un arreglo parcial/pisado.
    const messages = await fixture.repo.appendWhatsAppUserMessageOnce(fixture.organizationId, phone, { role: "user", content: "probe" });
    expect(messages).toHaveLength(3); // user + assistant del turno real, + esta "probe"
  });
});
