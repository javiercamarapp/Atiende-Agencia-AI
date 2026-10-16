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

describe("MetaCloudSimulator multinumero, ecos e historial", () => {
  const A = "1000000001";
  const B = "1000000002";
  const C = "1000000003";
  let sim: MetaCloudSimulator;
  let webhook: RunningServer;
  let received: { body: string; signature: string | null }[];
  let client: MetaGraphWhatsAppClient;
  type Change = { field: string; value: { metadata: { phone_number_id: string }; messages?: { from: string }[]; message_echoes?: { from: string; to: string; id: string; timestamp: string; type: string; text: { body: string } }[]; history?: unknown[]; state_sync?: unknown[] } };
  const changesOf = (i: number) => (JSON.parse(received[i]!.body) as { entry: { changes: Change[] }[] }).entry.flatMap((e) => e.changes);

  beforeEach(async () => {
    received = [];
    webhook = await serveFetchHandler(async (req) => {
      received.push({ body: await req.text(), signature: req.headers.get("x-hub-signature-256") });
      return new Response('{"ok":true}', { status: 200 });
    });
    sim = new MetaCloudSimulator({ appSecret: SECRET, accessToken: TOKEN, phoneNumberIds: [A, B], webhookUrl: `${webhook.baseUrl}/hook` });
    await sim.start();
    client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, baseUrl: sim.baseUrl });
  });
  afterEach(async () => {
    await sim.stop();
    await webhook.close();
  });

  const firmaValida = (i: number) => received[i]!.signature === `sha256=${createHmac("sha256", SECRET).update(received[i]!.body).digest("hex")}`;

  it("acepta cualquiera de los numeros, registra por cual salio cada mensaje y rechaza uno desconocido", async () => {
    await sim.inbound({ from: "5219991230000", body: "hola", phoneNumberId: A });
    await sim.inbound({ from: "5219991230000", body: "hola", phoneNumberId: B });
    await client.sendMessage({ to: "5219991230000", phoneNumberId: A, body: "por A" });
    await client.sendMessage({ to: "5219991230000", phoneNumberId: B, body: "por B" });
    expect(sim.accepted.map((m) => [m.phoneNumberId, m.text])).toEqual([[A, "por A"], [B, "por B"]]);
    expect(sim.lastSentTo("5219991230000", A)?.text).toBe("por A");
    expect(sim.sentTo("5219991230000", B)).toHaveLength(1);
    await expect(client.sendMessage({ to: "5219991230000", phoneNumberId: C, body: "x" })).rejects.toBeInstanceOf(WhatsAppSendError);
    sim.addPhoneNumberId(C);
    expect(sim.phoneNumberIds).toEqual([A, B, C]);
  });

  it("phoneNumberId solo equivale a un arreglo de uno; sin ningun numero el constructor falla", () => {
    const solo = new MetaCloudSimulator({ appSecret: SECRET, accessToken: TOKEN, phoneNumberId: PNID });
    expect(solo.phoneNumberIds).toEqual([PNID]);
    expect(solo.phoneNumberId).toBe(PNID);
    expect(() => new MetaCloudSimulator({ appSecret: SECRET, accessToken: TOKEN })).toThrow(/phoneNumberId/);
  });

  it("la ventana de 24 h es POR PAR numero-cliente: escribirle a A no abre ventana en B (texto libre por B da 131047)", async () => {
    await sim.inbound({ from: "5219991230000", body: "hola", phoneNumberId: A });
    expect(sim.isWindowOpen("5219991230000", A)).toBe(true);
    expect(sim.isWindowOpen("5219991230000", B)).toBe(false);
    await expect(client.sendMessage({ to: "5219991230000", phoneNumberId: A, body: "ok" })).resolves.toBeTruthy();
    await expect(client.sendMessage({ to: "5219991230000", phoneNumberId: B, body: "no" })).rejects.toMatchObject({ retryable: false });
    expect(sim.rejected.at(-1)).toMatchObject({ code: 131047, status: 400 });
    // Otro cliente en A tampoco hereda la ventana, y vencer el reloj la cierra solo para su par.
    expect(sim.isWindowOpen("5219990000099", A)).toBe(false);
    sim.advanceClock(WINDOW_24H_MS + 1000);
    expect(sim.isWindowOpen("5219991230000", A)).toBe(false);
  });

  it("inbound sin phoneNumberId usa el primero (compatibilidad) y el destino viaja en metadata", async () => {
    await sim.deliverText("5219991230000", "hola");
    await sim.inbound({ from: "5219991230000", body: "a B", phoneNumberId: B });
    expect(changesOf(0)[0]!.value.metadata.phone_number_id).toBe(A);
    expect(changesOf(1)[0]!.value.metadata.phone_number_id).toBe(B);
  });

  it("inboundLote arma UN solo POST firmado con un change por numero y abre la ventana de cada par", async () => {
    const d = await sim.inboundLote([
      { from: "5219991230001", body: "uno", phoneNumberId: A },
      { from: "5219991230002", body: "dos", phoneNumberId: B },
      { from: "5219991230003", body: "tres", phoneNumberId: A },
      { from: "5219991230004", body: "cuatro", phoneNumberId: C },
    ]);
    expect(d.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(firmaValida(0)).toBe(true);
    const changes = changesOf(0);
    expect(changes.map((c) => [c.value.metadata.phone_number_id, c.value.messages!.map((m) => m.from)])).toEqual([[A, ["5219991230001", "5219991230003"]], [B, ["5219991230002"]], [C, ["5219991230004"]]]);
    expect(sim.isWindowOpen("5219991230002", B)).toBe(true);
    expect(sim.isWindowOpen("5219991230002", A)).toBe(false);
  });

  it("ecoDeApp arma smb_message_echoes firmado, hacia el numero indicado, y NO abre la ventana del cliente", async () => {
    const d = await sim.ecoDeApp({ phoneNumberId: B, to: "+52 999 123 0000", text: "Ya va su pedido", id: "wamid.ECO1", timestampSeconds: 1760000000 });
    expect(d.status).toBe(200);
    expect(firmaValida(0)).toBe(true);
    const [change] = changesOf(0);
    expect(change!.field).toBe("smb_message_echoes");
    expect(change!.value.metadata.phone_number_id).toBe(B);
    expect(change!.value.message_echoes).toEqual([{ from: "5219990000000", to: "529991230000", id: "wamid.ECO1", timestamp: "1760000000", type: "text", text: { body: "Ya va su pedido" } }]);
    expect(change!.value.messages).toBeUndefined();
    expect(sim.isWindowOpen("529991230000", B)).toBe(false);
  });

  it("history y stateSync arman sus campos firmados con el numero indicado", async () => {
    await sim.history({ phoneNumberId: A, threads: [{ customer: "5219991230000", messages: [{ text: "hola" }, { fromBusiness: true, text: "bienvenido", id: "wamid.H2" }] }] });
    await sim.stateSync({ phoneNumberId: B, contacts: [{ fullName: "Ana Perez", phone: "+52 999 111 2222" }] });
    expect(firmaValida(0) && firmaValida(1)).toBe(true);
    const [h] = changesOf(0);
    expect(h!.field).toBe("history");
    expect(h!.value.metadata.phone_number_id).toBe(A);
    const hist = h!.value.history as { metadata: Record<string, number>; threads: { id: string; messages: { from: string; id: string; text: { body: string } }[] }[] }[];
    expect(hist[0]!.metadata).toEqual({ phase: 0, chunk_order: 1, progress: 100 });
    expect(hist[0]!.threads[0]!.id).toBe("5219991230000");
    expect(hist[0]!.threads[0]!.messages.map((m) => [m.from, m.text.body])).toEqual([["5219991230000", "hola"], ["5219990000000", "bienvenido"]]);
    const [s] = changesOf(1);
    expect(s!.field).toBe("smb_app_state_sync");
    expect(s!.value.metadata.phone_number_id).toBe(B);
    expect(s!.value.state_sync).toEqual([expect.objectContaining({ type: "contact", action: "add", contact: { full_name: "Ana Perez", phone_number: "529991112222" } })]);
  });

  it("firma: una firma falsa y una ausente llegan tal cual (postRaw) y la firma de todos los helpers usa el secreto del simulador", async () => {
    await sim.postRaw('{"a":1}', "sha256=falsa");
    await sim.postRaw('{"a":1}', null);
    expect(received[0]!.signature).toBe("sha256=falsa");
    expect(received[1]!.signature).toBeNull();
    await sim.ecoDeApp({ to: "5219991230000", text: "x" });
    expect(firmaValida(2)).toBe(true);
    expect(sim.sign(received[2]!.body)).toBe(received[2]!.signature);
  });

  it("deliverStatus de un mensaje saliente por B viaja con el phone_number_id de B", async () => {
    await sim.inbound({ from: "5219991230000", body: "hola", phoneNumberId: B });
    const { providerMessageId } = await client.sendMessage({ to: "5219991230000", phoneNumberId: B, body: "a" });
    await sim.deliverStatus(providerMessageId, "delivered");
    expect(changesOf(received.length - 1)[0]!.value.metadata.phone_number_id).toBe(B);
  });
});
