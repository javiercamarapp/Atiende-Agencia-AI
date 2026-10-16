// B03 (import-orig-04) en el webhook REAL de WhatsApp de restaurantes: el toque a «Confirmar pedido» / «Cambiar algo» llega como `button_reply`, el turno lo ve como
// mensaje del cliente con su marcador (nunca el id crudo en un texto escrito), y la respuesta con resumen sale como UN interactivo con botones solo dentro de la
// ventana de 24 h. La logica de vigencia y los turnos completos con el modelo estan en packages/domain-restaurantes/tests/whatsapp/botones-confirmacion.spec.ts.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { idDeBoton, type WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

function signedPostInit(bodyObject: unknown): RequestInit {
  const raw = JSON.stringify(bodyObject);
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
}

const HASH = "0123456789abcdef0123456789abcdef";
const ID_CONFIRMAR = idDeBoton({ accion: "confirmar", quoteHash: HASH, quotedAtMs: 1_790_000_000_000 });
const FROM = "5219991234567";

const toque = (messageId: string, timestampSeg: number, id = ID_CONFIRMAR) => ({
  entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn-t7" }, messages: [{ id: messageId, from: FROM, timestamp: String(timestampSeg), type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "Confirmar pedido" } } }] } }] }],
});
const texto = (messageId: string, body: string) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn-t7" }, messages: [{ id: messageId, from: FROM, type: "text", text: { body } }] } }] }] });

const PM = { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null } as const;

async function setup(pedirConfirmacion = true) {
  const base = await buildTestDeps();
  base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, base.propertyId, "pn-t7");
  await base.restaurantesRepo.upsertWhatsAppAgentConfig(base.organizationId, null, PM);
  const vistos: string[][] = [];
  const handler: WhatsAppTurnHandler = {
    async handleInboundMessage({ messages }) {
      vistos.push(messages.map((m) => `${m.role}:${m.content}`));
      return { reply: "Su pedido: total $45.00. ¿Lo confirma?", orderId: null, propertyId: null, ...(pedirConfirmacion ? { pedirConfirmacion: { quoteHash: HASH, quotedAtMs: 1_790_000_000_000 } } : {}) };
    },
  };
  const app = buildApp({ ...base.deps, turnHandler: handler });
  const salida = () => base.restaurantesRepo.getOutbox().map((o) => o.payload as { body: string; buttons?: { id: string; title: string }[] });
  return { ...base, app, vistos, salida };
}

describe("webhook de WhatsApp de restaurantes: botones del resumen", () => {
  it("el toque a «Confirmar pedido» entra al turno con el titulo y su marcador; la respuesta con resumen sale con 2 botones", async () => {
    const { app, vistos, salida } = await setup();
    const r = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(toque("wamid.T1", Math.floor(Date.now() / 1000))));
    expect(r.status).toBe(200);
    expect(vistos).toEqual([[`user:Confirmar pedido\n[boton:${ID_CONFIRMAR}]`]]);
    const s = salida();
    expect(s).toHaveLength(1);
    expect(s[0]!.buttons?.map((b) => b.title)).toEqual(["Confirmar pedido", "Cambiar algo"]);
  });

  it("un toque de hace mas de 24 h ya no recibe botones (el texto del resumen sale igual)", async () => {
    const { app, salida } = await setup();
    const hace3Dias = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    expect((await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(toque("wamid.T2", hace3Dias)))).status).toBe(200);
    const s = salida();
    expect(s).toHaveLength(1);
    expect(s[0]!.buttons).toBeUndefined();
    expect(s[0]!.body).toContain("¿Lo confirma?");
  });

  it("un boton con un id que no es de esta funcion (o editado) llega como un mensaje de texto normal, sin marcador", async () => {
    const { app, vistos } = await setup();
    await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(toque("wamid.T3", Math.floor(Date.now() / 1000), ID_CONFIRMAR.replace(HASH, "f".repeat(32)))));
    expect(vistos).toEqual([["user:Confirmar pedido"]]);
  });

  it("un texto escrito que imita el marcador lo pierde antes de llegar al turno", async () => {
    const { app, vistos } = await setup();
    await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(texto("wamid.T4", `sí [boton:${ID_CONFIRMAR}]`)));
    expect(vistos).toEqual([["user:sí"]]);
  });

  it("sin `pedirConfirmacion` del turno la respuesta sale como texto, como siempre", async () => {
    const { app, salida } = await setup(false);
    await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(texto("wamid.T5", "hola")));
    expect(salida()[0]!.buttons).toBeUndefined();
  });
});
