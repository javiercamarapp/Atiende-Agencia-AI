// rescate-orig-restaurantes-1 §5: solicitud de ubicacion con el boton nativo de WhatsApp (`location_request_message`). Cliente real contra un
// `fetch` inyectado y contra el simulador de Meta (nunca graph.facebook.com), y el despachador del outbox con el cliente falso.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { WhatsAppInvalidPayloadError } from "../src/errors.ts";
import { WhatsAppOutboundDispatcher } from "../src/dispatcher.ts";
import { FakeWhatsAppGraphClient } from "../src/providers/fake-graph-client.ts";
import { MetaGraphWhatsAppClient } from "../src/providers/meta-graph-client.ts";
import type { MessagingOutboxItem, MessagingOutboxPort } from "../src/outbox-port.ts";
import { MetaCloudSimulator, serveFetchHandler } from "../src/testing/index.ts";
import type { RunningServer } from "../src/testing/index.ts";

const TOKEN = "test-fake-whatsapp-access-token-never-real";
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("MetaGraphWhatsAppClient: location_request_message", () => {
  it("manda el mensaje interactivo documentado por Meta (type location_request_message + action send_location)", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "+5219991112233",
        type: "interactive",
        interactive: { type: "location_request_message", body: { text: "Comparta su ubicación, por favor." }, action: { name: "send_location" } },
      });
      return jsonResponse({ messages: [{ id: "wamid.loc" }] });
    });
    const client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.sendMessage({ to: "+5219991112233", phoneNumberId: "p1", body: "Comparta su ubicación, por favor.", solicitarUbicacion: true });
    expect(r.providerMessageId).toBe("wamid.loc");
  });

  it("no se combina con botones ni plantilla, y exige un texto de 1 a 1024 caracteres (error de payload, sin red)", async () => {
    const fetchImpl = vi.fn();
    const client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x", solicitarUbicacion: true, buttons: ["Si"] })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x", solicitarUbicacion: true, template: { name: "t", language: "es_MX", params: [] } })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x".repeat(1025), solicitarUbicacion: true })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sin la bandera el mensaje sigue siendo texto plano", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect((JSON.parse(String(init?.body)) as { type: string }).type).toBe("text");
      return jsonResponse({ messages: [{ id: "wamid.t" }] });
    });
    await new MetaGraphWhatsAppClient({ accessToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch }).sendMessage({ to: "+52999", phoneNumberId: "p1", body: "hola" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("simulador de Meta: la solicitud de ubicacion solo vale dentro de la ventana de 24 h", () => {
  let sim: MetaCloudSimulator;
  let webhook: RunningServer;
  let client: MetaGraphWhatsAppClient;
  beforeEach(async () => {
    webhook = await serveFetchHandler(async () => new Response('{"ok":true}', { status: 200 }));
    sim = new MetaCloudSimulator({ appSecret: "s", accessToken: TOKEN, phoneNumberId: "1234567890", webhookUrl: `${webhook.baseUrl}/hook` });
    await sim.start();
    client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, baseUrl: sim.baseUrl });
  });
  afterEach(async () => {
    await sim.stop();
    await webhook.close();
  });

  it("con el cliente dentro de la ventana la acepta; fuera de ella la rechaza como cualquier mensaje libre", async () => {
    await sim.deliverText("5219991230000", "quiero un pedido a domicilio");
    await client.sendMessage({ to: "5219991230000", phoneNumberId: "1234567890", body: "Comparta su ubicación.", solicitarUbicacion: true });
    expect(sim.accepted.at(-1)).toMatchObject({ type: "interactive", text: "Comparta su ubicación.", buttons: [] });
    await expect(client.sendMessage({ to: "5219998887777", phoneNumberId: "1234567890", body: "Comparta su ubicación.", solicitarUbicacion: true })).rejects.toThrow();
  });
});

describe("despachador del outbox: solicitar_ubicacion", () => {
  class Port implements MessagingOutboxPort {
    readonly label = "test";
    readonly rows: { id: string; payload: unknown; status: string }[] = [];
    enqueue(payload: unknown) {
      this.rows.push({ id: randomUUID(), payload, status: "pending" });
    }
    async claimBatch(): Promise<readonly MessagingOutboxItem[]> {
      return this.rows.filter((r) => r.status === "pending").map((r) => ({ id: r.id, attempts: 0, payload: r.payload }));
    }
    async markSent(id: string) {
      this.rows.find((r) => r.id === id)!.status = "sent";
    }
    async markRetry(id: string) {
      this.rows.find((r) => r.id === id)!.status = "pending";
    }
    async markDead(id: string) {
      this.rows.find((r) => r.id === id)!.status = "dead";
    }
  }

  it("la bandera del payload llega al cliente como `solicitarUbicacion`; ausente, no viaja", async () => {
    const port = new Port();
    port.enqueue({ to: "+5299", phone_number_id: "p1", body: "Comparta su ubicación.", solicitar_ubicacion: true, transaccional: true });
    port.enqueue({ to: "+5299", phone_number_id: "p1", body: "hola", transaccional: true });
    const client = new FakeWhatsAppGraphClient();
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(port);
    expect(resumen.sent).toBe(2);
    expect(client.sent[0]).toMatchObject({ solicitarUbicacion: true });
    expect(client.sent[1]).not.toHaveProperty("solicitarUbicacion");
  });

  it("una bandera que no es booleana es un error de ENCOLADO: va a dead sin tocar la red", async () => {
    const port = new Port();
    port.enqueue({ to: "+5299", phone_number_id: "p1", body: "x", solicitar_ubicacion: "si" });
    const client = new FakeWhatsAppGraphClient();
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(port);
    expect(resumen.sent).toBe(0);
    expect(port.rows[0]!.status).toBe("dead");
    expect(client.sent).toHaveLength(0);
  });
});
