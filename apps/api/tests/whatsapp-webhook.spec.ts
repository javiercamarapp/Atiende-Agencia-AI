import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

function signedPostInit(bodyObject: unknown): RequestInit {
  const raw = JSON.stringify(bodyObject);
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature },
  };
}

function metaPayload(overrides: { phoneNumberId?: string; from?: string; messageId?: string; body?: string } = {}) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: overrides.phoneNumberId ?? "1234567890" },
              messages: [{ id: overrides.messageId ?? "wamid.test1", from: overrides.from ?? "5219991234567", type: "text", text: { body: overrides.body ?? "Hola, quiero un pedido" } }],
            },
          },
        ],
      },
    ],
  };
}

describe("GET /v1/restaurantes/whatsapp/webhook — handshake de verificación de Meta", () => {
  it("responde el challenge tal cual cuando el verify_token coincide", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=echo-123");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo-123");
  });

  it("403 cuando el verify_token no coincide", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=incorrecto&hub.challenge=echo-123");
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/restaurantes/whatsapp/webhook — verificación HMAC sobre bytes crudos", () => {
  it("401 con firma inválida/ausente (nunca procesa un payload no firmado por Meta)", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const raw = JSON.stringify(metaPayload());
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) },
    });
    expect(res.status).toBe(401);
  });

  it("200 y procesa el mensaje cuando la firma es válida, rutea por phone_number_id, y crea el callback_request del turn handler de Fase 1", async () => {
    const { deps, restaurantesRepo, organizationId } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verifica que de verdad corrió el flujo completo (dedupe -> lease -> append ->
    // turn handler -> callback_request), no solo que respondió 200.
    const conversation = await restaurantesRepo.appendWhatsAppUserMessageOnce(organizationId, "+5219991234567", { role: "user", content: "probe" });
    expect(conversation.length).toBeGreaterThanOrEqual(3); // user real + assistant real + esta "probe"
  });

  it("200 con ack silencioso (sin reintento) cuando el phone_number_id no está configurado en la plataforma", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload({ phoneNumberId: "numero-no-configurado" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("un message_id reenviado (retry at-least-once real de Meta) se acusa 200 sin duplicar el turno procesado", async () => {
    const { deps, restaurantesRepo, organizationId } = await buildTestDeps();
    const app = buildApp(deps);
    const payload = metaPayload({ messageId: "wamid.dup-http" });
    const first = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload));
    const second = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const conversation = await restaurantesRepo.appendWhatsAppUserMessageOnce(organizationId, "+5219991234567", { role: "user", content: "probe" });
    // 1 user + 1 assistant del único turno real procesado + esta "probe" = 3, nunca 5.
    expect(conversation).toHaveLength(3);
  });
});

// Hallazgo de auditoría (ALTO, "packages/core-ratelimit cataloga la categoría
// 'conversation:inbound-webhook' pero ningún webhook real la invocaba" -- ver
// packages/core-ratelimit/src/endpoint-policy.ts y el comentario de cabecera de
// apps/api/src/routes/verticals/restaurantes/whatsapp.ts). El backend en memoria de
// @atiende/core-ratelimit se resetea antes de cada test (ver
// test-setup/reset-rate-limiter.ts) para que este límite no interfiera con el resto
// de la suite.
describe("rate limiting real en conversation:inbound-webhook (POST /v1/restaurantes/whatsapp/webhook)", () => {
  it("más de 120 llamadas en la misma ventana desde el mismo phone_number_id+IP responde 429 -- antes de este fix nunca limitaba nada", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const payload = metaPayload();

    let lastStatus = 0;
    for (let i = 0; i < 121; i += 1) {
      const res = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload));
      lastStatus = res.status;
      if (i < 120) expect(res.status).toBe(200);
    }
    expect(lastStatus).toBe(429);
  });

  it("un número de WhatsApp DISTINTO tiene su propio cupo -- no se agota por la ráfaga de otro phone_number_id", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);

    for (let i = 0; i < 120; i += 1) {
      await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload({ phoneNumberId: "numero-agotado" })));
    }
    expect((await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload({ phoneNumberId: "numero-agotado" })))).status).toBe(429);

    // phone_number_id distinto (aunque no configurado en la plataforma -- 200 ack
    // silencioso): su propio cupo sigue intacto.
    const otroNumero = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload({ phoneNumberId: "numero-no-configurado" })));
    expect(otroNumero.status).toBe(200);
  });
});
