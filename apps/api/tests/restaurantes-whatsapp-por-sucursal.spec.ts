// Modelo PM (migracion 023): un numero de WhatsApp POR SUCURSAL. El webhook resuelve la
// sucursal desde el `phone_number_id` que recibio el mensaje y se la pasa al turn handler;
// los numeros por defecto de la organizacion siguen funcionando igual (propertyId null).
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

function signedPostInit(bodyObject: unknown): RequestInit {
  const raw = JSON.stringify(bodyObject);
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
}

function metaPayload(phoneNumberId: string, messageId: string) {
  return {
    entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId }, messages: [{ id: messageId, from: "5219991234567", type: "text", text: { body: "Hola, quiero un pedido" } }] } }] }],
  };
}

async function setup() {
  const base = await buildTestDeps();
  const propertyB = randomUUID();
  base.restaurantesRepo.seedBranch({ propertyId: propertyB, organizationId: base.organizationId, name: "Victory Altabrisa", slug: "altabrisa", status: "active", phone: null, address: null, lat: null, lng: null });
  base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, base.propertyId, "pn-sucursal-a");
  base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, propertyB, "pn-sucursal-b");

  const seen: Array<{ propertyId: string | null | undefined; organizationId: string }> = [];
  const recording: WhatsAppTurnHandler = {
    async handleInboundMessage(args) {
      seen.push({ propertyId: args.propertyId, organizationId: args.organizationId });
      return { reply: "ok", orderId: null, propertyId: null };
    },
  };
  const app = buildApp({ ...base.deps, turnHandler: recording });
  return { ...base, propertyB, seen, app };
}

describe("POST /v1/restaurantes/whatsapp/webhook — un WhatsApp por sucursal", () => {
  it("el numero de la sucursal A resuelve organizacion y sucursal A", async () => {
    const { app, seen, organizationId, propertyId } = await setup();
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload("pn-sucursal-a", "wamid.a1")));
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ propertyId, organizationId }]);
  });

  it("el numero de la sucursal B resuelve la sucursal B (no la A)", async () => {
    const { app, seen, propertyB, propertyId } = await setup();
    await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload("pn-sucursal-b", "wamid.b1")));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.propertyId).toBe(propertyB);
    expect(seen[0]!.propertyId).not.toBe(propertyId);
  });

  it("el numero por defecto de la organizacion sigue funcionando y no fija sucursal", async () => {
    const { app, seen, organizationId } = await setup();
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload("1234567890", "wamid.org1")));
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ propertyId: null, organizationId }]);
  });

  it("un numero desconocido se acusa con 200 silencioso y nunca llega al turn handler", async () => {
    const { app, seen } = await setup();
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload("pn-desconocido", "wamid.x1")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toHaveLength(0);
  });

  it("la respuesta saliente se encola con el MISMO phone_number_id de la sucursal que recibio el mensaje", async () => {
    const { app, restaurantesRepo } = await setup();
    await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(metaPayload("pn-sucursal-b", "wamid.b2")));
    const batch = await restaurantesRepo.claimMessagingOutboxBatch(10, 60);
    const payloads = batch.map((row) => row.payload as { phone_number_id?: string; to?: string });
    expect(payloads.some((p) => p.phone_number_id === "pn-sucursal-b" && p.to === "+5219991234567")).toBe(true);
  });
});
