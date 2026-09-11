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
    const { deps, organizationId } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verifica que de verdad corrió el flujo completo (dedupe -> lease -> append ->
    // turn handler -> callback_request), no solo que respondió 200.
    const conversation = await deps.restaurantesRepo.appendWhatsAppUserMessageOnce(organizationId, "+5219991234567", { role: "user", content: "probe" });
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
    const { deps, organizationId } = await buildTestDeps();
    const app = buildApp(deps);
    const payload = metaPayload({ messageId: "wamid.dup-http" });
    const first = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload));
    const second = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const conversation = await deps.restaurantesRepo.appendWhatsAppUserMessageOnce(organizationId, "+5219991234567", { role: "user", content: "probe" });
    // 1 user + 1 assistant del único turno real procesado + esta "probe" = 3, nunca 5.
    expect(conversation).toHaveLength(3);
  });
});
