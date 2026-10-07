import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { MetaGraphWhatsAppClient } from "../src/providers/meta-graph-client.ts";
import { WhatsAppSendError } from "../src/errors.ts";
import { extractMetaStatuses } from "../src/statuses.ts";
import { createSimulatorFetch, MetaCloudSimulator, ResendSink, serveFetchHandler, WINDOW_24H_MS } from "../src/testing/index.ts";
import type { RunningServer } from "../src/testing/index.ts";

const SECRET = "sim-app-secret";
const TOKEN = "sim-access-token";
const PNID = "1234567890";

describe("MetaCloudSimulator (R-35)", () => {
  let sim: MetaCloudSimulator;
  let webhook: RunningServer;
  let received: { body: string; signature: string | null }[];
  let client: MetaGraphWhatsAppClient;

  beforeEach(async () => {
    received = [];
    webhook = await serveFetchHandler(async (req) => {
      if (req.method === "GET") {
        const u = new URL(req.url);
        return u.searchParams.get("hub.verify_token") === "vt" ? new Response(u.searchParams.get("hub.challenge") ?? "") : new Response("Forbidden", { status: 403 });
      }
      received.push({ body: await req.text(), signature: req.headers.get("x-hub-signature-256") });
      return new Response('{"ok":true}', { status: 200 });
    });
    sim = new MetaCloudSimulator({ appSecret: SECRET, accessToken: TOKEN, phoneNumberId: PNID, webhookUrl: `${webhook.baseUrl}/hook` });
    await sim.start();
    client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, baseUrl: sim.baseUrl });
  });
  afterEach(async () => {
    await sim.stop();
    await webhook.close();
  });

  it("firma el webhook entrante con HMAC-SHA256 sobre los bytes exactos enviados", async () => {
    const delivery = await sim.deliverText("+5219991230000", "hola");
    expect(delivery.status).toBe(200);
    expect(received).toHaveLength(1);
    const expected = `sha256=${createHmac("sha256", SECRET).update(received[0]!.body).digest("hex")}`;
    expect(received[0]!.signature).toBe(expected);
    const parsed = JSON.parse(received[0]!.body) as { entry: { changes: { value: { metadata: { phone_number_id: string }; messages: { from: string; text: { body: string } }[] } }[] }[] };
    expect(parsed.entry[0]!.changes[0]!.value.metadata.phone_number_id).toBe(PNID);
    expect(parsed.entry[0]!.changes[0]!.value.messages[0]).toMatchObject({ from: "5219991230000", text: { body: "hola" } });
  });

  it("replay reenvia los mismos bytes y firma; el handshake GET responde el challenge solo con el token correcto", async () => {
    const first = await sim.deliverText("5219991230000", "hola", "wamid.FIJO");
    await sim.replay(first);
    expect(received[1]!.body).toBe(received[0]!.body);
    expect(received[1]!.signature).toBe(received[0]!.signature);
    expect(await sim.verifyWebhookHandshake("vt", "abc")).toEqual({ status: 200, body: "abc" });
    expect((await sim.verifyWebhookHandshake("otro")).status).toBe(403);
  });

  it("el wamid que devuelve el envio vuelve en los statuses del webhook, incluido un failed con errors[] que extractMetaStatuses entiende", async () => {
    await sim.deliverText("5219991230000", "abre la ventana de 24 h");
    const enviado = await client.sendMessage({ to: "5219991230000", phoneNumberId: PNID, body: "hola" });
    expect(enviado.enviadoComo).toBe("texto");
    await sim.deliverStatus(enviado.providerMessageId, "delivered");
    await sim.deliverStatus(enviado.providerMessageId, "failed", { code: 131047, title: "Re-engagement message" });
    const estados = received.flatMap((r) => extractMetaStatuses(JSON.parse(r.body) as unknown));
    expect(estados.map((e) => [e.wamid, e.status, e.errorCode])).toEqual([[enviado.providerMessageId, "delivered", null], [enviado.providerMessageId, "failed", 131047]]);
  });

  it("rechaza un token invalido con 401 y el cliente real lo trata como no reintentable", async () => {
    const bad = new MetaGraphWhatsAppClient({ accessToken: "otro", baseUrl: sim.baseUrl });
    await expect(bad.sendMessage({ to: "5219991230000", phoneNumberId: PNID, body: "x" })).rejects.toMatchObject({ retryable: false });
  });

  it("regla de 24 h: sin mensaje entrante previo se rechaza con 131047; con ventana abierta pasa; vencida otra vez rechaza", async () => {
    const msg = { to: "+5219991230000", phoneNumberId: PNID, body: "tu pedido va en camino" };
    const err = await client.sendMessage(msg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect((err as WhatsAppSendError).retryable).toBe(false);
    expect(sim.rejected[0]).toMatchObject({ code: 131047, status: 400 });

    await sim.deliverText("5219991230000", "hola");
    expect(sim.isWindowOpen("+5219991230000")).toBe(true);
    const ok = await client.sendMessage(msg);
    expect(ok.providerMessageId).toMatch(/^wamid\.SIMOUT/);
    expect(sim.lastSentTo("5219991230000")?.text).toBe("tu pedido va en camino");

    sim.advanceClock(WINDOW_24H_MS + 1000);
    expect(sim.isWindowOpen("5219991230000")).toBe(false);
    await expect(client.sendMessage(msg)).rejects.toMatchObject({ retryable: false });
  });

  it("mensajes interactivos con botones se aceptan y se registran con sus ids", async () => {
    await sim.deliverText("5219991230000", "hola");
    await client.sendMessage({ to: "5219991230000", phoneNumberId: PNID, body: "Confirmas?", buttons: [{ id: "pedido:ok", title: "Si" }, { id: "pedido:no", title: "No" }] });
    expect(sim.lastSentTo("5219991230000")?.buttons).toEqual([{ id: "pedido:ok", title: "Si" }, { id: "pedido:no", title: "No" }]);
  });

  it("failNext simula un 5xx de Meta (reintentable) y despues se recupera", async () => {
    await sim.deliverText("5219991230000", "hola");
    sim.failNext({ status: 503 });
    await expect(client.sendMessage({ to: "5219991230000", phoneNumberId: PNID, body: "a" })).rejects.toMatchObject({ retryable: true });
    await expect(client.sendMessage({ to: "5219991230000", phoneNumberId: PNID, body: "a" })).resolves.toBeTruthy();
  });

  it("deliverStatus emite el estado de un mensaje aceptado y falla con uno desconocido", async () => {
    await sim.deliverText("5219991230000", "hola");
    const { providerMessageId } = await client.sendMessage({ to: "5219991230000", phoneNumberId: PNID, body: "a" });
    await sim.deliverStatus(providerMessageId, "delivered");
    const last = JSON.parse(received[received.length - 1]!.body) as { entry: { changes: { value: { statuses: { status: string; id: string }[] } }[] }[] };
    expect(last.entry[0]!.changes[0]!.value.statuses[0]).toMatchObject({ id: providerMessageId, status: "delivered" });
    await expect(sim.deliverStatus("wamid.NOEXISTE", "read")).rejects.toThrow(/no fue aceptado/);
  });
});

describe("ResendSink y createSimulatorFetch", () => {
  it("guarda el correo, respeta Idempotency-Key y bloquea cualquier host que no sea un simulador", async () => {
    const sink = new ResendSink("re_sim_key");
    await sink.start();
    try {
      const f = createSimulatorFetch({ resendBaseUrl: sink.baseUrl });
      const send = () =>
        f("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: "Bearer re_sim_key", "Content-Type": "application/json", "Idempotency-Key": "outbox/1" },
          body: JSON.stringify({ from: "a@x.test", to: "b@x.test", subject: "Pedido", html: "<p>hola</p>" }),
        });
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      expect(sink.emails).toHaveLength(1);
      expect(sink.emailsTo("B@x.test")).toHaveLength(1);
      sink.failNext(500);
      expect((await send()).status).toBe(500);
      const noAuth = await f("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer mala" }, body: "{}" });
      expect(noAuth.status).toBe(401);
      await expect(f("https://example.com/x")).rejects.toThrow(/salida bloqueada/);
    } finally {
      await sink.stop();
    }
  });
});
