// Bateria PM (F3a) -- webhook de WhatsApp de restaurantes a nivel HTTP: lotes de Meta con varios
// clientes (X32), mensajes que NO son texto (audio, ubicacion, archivos: P33/P34, nunca se ignoran en
// silencio) y reacciones/estados (si se ignoran). La firma, el reenvio del mismo message.id, el
// rate limit y el numero por sucursal ya los cubren whatsapp-webhook.spec.ts y
// restaurantes-whatsapp-por-sucursal.spec.ts.
import { createHmac } from "node:crypto";
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

const payloadCon = (messages: unknown[]) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "1234567890" }, messages } }] }] });
const texto = (id: string, from: string, body: string) => ({ id, from, type: "text", text: { body } });

async function setup() {
  const base = await buildTestDeps();
  const vistos: Array<{ phone: string; ultimo: string }> = [];
  const handler: WhatsAppTurnHandler = {
    async handleInboundMessage(args) {
      vistos.push({ phone: args.phone, ultimo: args.messages[args.messages.length - 1]!.content });
      return { reply: "ok", orderId: null, propertyId: null };
    },
  };
  return { ...base, vistos, app: buildApp({ ...base.deps, turnHandler: handler }) };
}

describe("POST /v1/restaurantes/whatsapp/webhook -- bateria PM", () => {
  it("T-CI02 / X32 [P0] un lote de Meta con 5 mensajes de 3 clientes procesa TODOS, en el orden del payload", async () => {
    const { app, vistos } = await setup();
    const res = await app.request(
      "/v1/restaurantes/whatsapp/webhook",
      signedPostInit(
        payloadCon([
          texto("wamid.1", "5219990000001", "uno-a"),
          texto("wamid.2", "5219990000002", "dos-a"),
          texto("wamid.3", "5219990000003", "tres-a"),
          texto("wamid.4", "5219990000001", "uno-b"),
          texto("wamid.5", "5219990000002", "dos-b"),
        ]),
      ),
    );
    expect(res.status).toBe(200);
    expect(vistos.map((v) => `${v.phone}:${v.ultimo}`)).toEqual([
      "+5219990000001:uno-a",
      "+5219990000002:dos-a",
      "+5219990000003:tres-a",
      "+5219990000001:uno-b",
      "+5219990000002:dos-b",
    ]);
  });

  it("T-AM / P34 [P1] una nota de voz NO se ignora en silencio: llega al turno con una nota para pedirle que escriba, y la respuesta se encola", async () => {
    const { app, vistos, restaurantesRepo } = await setup();
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payloadCon([{ id: "wamid.audio1", from: "5219990000004", type: "audio", audio: { id: "media-1" } }])));
    expect(res.status).toBe(200);
    expect(vistos).toHaveLength(1);
    expect(vistos[0]!.ultimo).toMatch(/nota de voz que este asistente no puede escuchar/);
    const salida = (await restaurantesRepo.claimMessagingOutboxBatch(10, 60)).map((r) => r.payload as { to?: string });
    expect(salida.some((p) => p.to === "+5219990000004")).toBe(true);
  });

  it("T-ZS07 / P33 [P1] un pin de ubicacion llega al turno como marcador estable con sus coordenadas (el turno las relee y las inyecta en buscar_sucursal_cercana)", async () => {
    const { app, vistos } = await setup();
    await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payloadCon([{ id: "wamid.loc1", from: "5219990000005", type: "location", location: { latitude: 21.0213, longitude: -89.5578 } }])));
    expect(vistos).toHaveLength(1);
    expect(vistos[0]!.ultimo).toMatch(/^\[Ubicación compartida por WhatsApp\] lat=21\.021300 lng=-89\.557800/);
  });

  it("un pin de ubicacion sin coordenadas utilizables pide la colonia por texto", async () => {
    const { app, vistos } = await setup();
    await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payloadCon([{ id: "wamid.loc2", from: "5219990000008", type: "location", location: {} }])));
    expect(vistos[0]!.ultimo).toMatch(/colonia o una referencia cercana/);
  });

  it("una imagen o documento tambien se acusan con una nota honesta; el mismo message.id reenviado no duplica el turno", async () => {
    const { app, vistos } = await setup();
    const payload = payloadCon([{ id: "wamid.img1", from: "5219990000006", type: "image", image: { id: "m" } }]);
    await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload));
    await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload));
    expect(vistos).toHaveLength(1);
    expect(vistos[0]!.ultimo).toMatch(/imagen que el asistente no puede ver/);
  });

  it("reacciones, mensajes de sistema, ids vacios y remitentes invalidos se ignoran (no hay a quien contestar)", async () => {
    const { app, vistos } = await setup();
    const res = await app.request(
      "/v1/restaurantes/whatsapp/webhook",
      signedPostInit(payloadCon([{ id: "wamid.r1", from: "5219990000007", type: "reaction", reaction: { emoji: "👍" } }, { id: "wamid.s1", from: "5219990000007", type: "system" }, { id: "", from: "5219990000007", type: "audio" }, { id: "wamid.bad", from: "no-es-telefono", type: "audio" }]))
    );
    expect(res.status).toBe(200);
    expect(vistos).toHaveLength(0);
  });

  it("T-AB11 [P1] un body mas grande que el limite responde 413 y un JSON invalido (pero firmado) responde 400: nunca se procesa ni se lanza un 500", async () => {
    const { app, vistos } = await setup();
    const grande = await app.request("/v1/restaurantes/whatsapp/webhook", { method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": String(300 * 1024) } });
    expect(grande.status).toBe(413);
    const raw = "{no es json";
    const bytes = new TextEncoder().encode(raw);
    const firma = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
    const invalido = await app.request("/v1/restaurantes/whatsapp/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": firma } });
    expect(invalido.status).toBe(400);
    expect(vistos).toHaveLength(0);
  });
});
