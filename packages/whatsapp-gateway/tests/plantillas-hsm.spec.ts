// R-27 -- plantillas HSM de WhatsApp (`type: "template"`). SIN red: `fetchImpl` falso y puerto en memoria; el
// token es un valor fijo de prueba, nunca uno real de Meta.
import { describe, expect, it, vi } from "vitest";
import { WhatsAppOutboundDispatcher } from "../src/dispatcher.ts";
import { FakeWhatsAppGraphClient } from "../src/providers/fake-graph-client.ts";
import { MetaGraphWhatsAppClient } from "../src/providers/meta-graph-client.ts";
import type { MessagingOutboxItem, MessagingOutboxPort } from "../src/outbox-port.ts";

const FAKE_TOKEN = "test-fake-whatsapp-access-token-never-real";
const PLANTILLA = { name: "pedido_en_camino", language: "es_MX", params: ["Ana", "Centro", "$250.00 MXN"] } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clienteConFetch(approvedTemplates: Iterable<string> | undefined) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return jsonResponse({ messages: [{ id: "wamid.tpl" }] });
  });
  const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch, approvedTemplates });
  return { client, bodies, fetchImpl };
}

describe("MetaGraphWhatsAppClient: plantillas HSM", () => {
  it("plantilla declarada aprobada: arma type=template con idioma y variables del cuerpo en orden", async () => {
    const { client, bodies } = clienteConFetch(["pedido_en_camino"]);
    await client.sendMessage({ to: "+5219991112233", phoneNumberId: "p1", body: "texto libre de respaldo", template: PLANTILLA });
    expect(bodies[0]).toEqual({
      messaging_product: "whatsapp",
      to: "+5219991112233",
      type: "template",
      template: {
        name: "pedido_en_camino",
        language: { code: "es_MX" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "Centro" }, { type: "text", text: "$250.00 MXN" }] }],
      },
    });
  });

  it("plantilla SIN variables: no manda components", async () => {
    const { client, bodies } = clienteConFetch(["sin_variables"]);
    await client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x", template: { name: "sin_variables", language: "es_MX", params: [] } });
    expect(bodies[0]).toEqual({ messaging_product: "whatsapp", to: "+52999", type: "template", template: { name: "sin_variables", language: { code: "es_MX" } } });
  });

  it("plantilla NO declarada aprobada (default): cae al texto libre, nunca type=template", async () => {
    for (const aprobadas of [undefined, [], ["otra_plantilla"]]) {
      const { client, bodies } = clienteConFetch(aprobadas);
      await client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "hola libre", template: PLANTILLA });
      expect(bodies[0]).toEqual({ messaging_product: "whatsapp", to: "+52999", type: "text", text: { body: "hola libre", preview_url: false } });
    }
  });

  it("sin plantilla en el mensaje: comportamiento anterior intacto aunque haya plantillas aprobadas", async () => {
    const { client, bodies } = clienteConFetch(["pedido_en_camino"]);
    await client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "hola" });
    expect(bodies[0]?.type).toBe("text");
  });

  it("un rechazo 4xx de Meta con plantilla sigue siendo error NO reintentable (el dispatcher lo manda a dead)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "template not found", code: 132001 } }, 400));
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch, approvedTemplates: ["pedido_en_camino"] });
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x", template: PLANTILLA })).rejects.toMatchObject({ retryable: false });
  });
});

class PuertoMemoria implements MessagingOutboxPort {
  readonly label = "test";
  estado: "pending" | "sent" | "dead" = "pending";
  clase: string | null = null;
  constructor(private readonly payload: unknown) {}
  async claimBatch(): Promise<readonly MessagingOutboxItem[]> {
    return this.estado === "pending" ? [{ id: "m1", attempts: 0, payload: this.payload }] : [];
  }
  async markSent(): Promise<void> {
    this.estado = "sent";
  }
  async markRetry(): Promise<void> {}
  async markDead(_id: string, _attempts: number, errorClass: string): Promise<void> {
    this.estado = "dead";
    this.clase = errorClass;
  }
}

const base = { to: "+529991112233", phone_number_id: "phone-1", body: "hola" };

describe("WhatsAppOutboundDispatcher: payload con template", () => {
  it("pasa la plantilla al cliente y marca sent", async () => {
    const puerto = new PuertoMemoria({ ...base, template: PLANTILLA });
    const client = new FakeWhatsAppGraphClient();
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(puerto);
    expect(resumen.sent).toBe(1);
    expect(client.sent[0]?.template).toEqual(PLANTILLA);
    expect(client.sent[0]?.body).toBe("hola");
  });

  it("sin template el mensaje no lleva el campo (comportamiento anterior)", async () => {
    const puerto = new PuertoMemoria(base);
    const client = new FakeWhatsAppGraphClient();
    await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(puerto);
    expect("template" in (client.sent[0] ?? {})).toBe(false);
  });

  it.each([
    ["nombre con mayusculas", { ...PLANTILLA, name: "Pedido-EnCamino" }],
    ["nombre vacio", { ...PLANTILLA, name: "" }],
    ["idioma invalido", { ...PLANTILLA, language: "espanol" }],
    ["mas de 10 variables", { ...PLANTILLA, params: Array.from({ length: 11 }, () => "x") }],
    ["variable vacia", { ...PLANTILLA, params: ["Ana", ""] }],
    ["variable con salto de linea", { ...PLANTILLA, params: ["Ana\nLopez"] }],
    ["variable demasiado larga", { ...PLANTILLA, params: ["x".repeat(1025)] }],
    ["variable que no es texto", { ...PLANTILLA, params: [42] }],
    ["template que no es objeto", "pedido_en_camino"],
  ])("template invalido (%s): dead de inmediato, nunca se envia", async (_nombre, template) => {
    const puerto = new PuertoMemoria({ ...base, template });
    const client = new FakeWhatsAppGraphClient();
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(puerto);
    expect(resumen.dead).toBe(1);
    expect(puerto.estado).toBe("dead");
    expect(client.sent).toHaveLength(0);
  });
});
