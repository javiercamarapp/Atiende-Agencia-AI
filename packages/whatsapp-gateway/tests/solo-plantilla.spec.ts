// Mensajes solo-plantilla (codigo de acceso del repartidor, docs/LOGIN-CHOFER-WHATSAPP.md): o salen como plantilla APROBADA o no salen.
// Nunca degradan a texto libre. Deterministas: fetch falso, sin red.
import { describe, expect, it, vi } from "vitest";
import { WhatsAppOutboundDispatcher } from "../src/dispatcher.ts";
import { WhatsAppInvalidPayloadError } from "../src/errors.ts";
import { MetaGraphWhatsAppClient } from "../src/providers/meta-graph-client.ts";
import type { MessagingOutboxItem, MessagingOutboxPort } from "../src/outbox-port.ts";

const PLANTILLA = { name: "codigo_acceso", language: "es_MX", params: ["123456"], codigoBoton: "123456" } as const;

function cliente(aprobadas: Iterable<string> | undefined) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { client: new MetaGraphWhatsAppClient({ accessToken: "t", fetchImpl: fetchImpl as unknown as typeof fetch, approvedTemplates: aprobadas }), bodies, fetchImpl };
}

class Puerto implements MessagingOutboxPort {
  readonly label = "test";
  estado: "pending" | "sent" | "dead" = "pending";
  clase: string | null = null;
  constructor(private readonly payload: unknown) {}
  async claimBatch(): Promise<readonly MessagingOutboxItem[]> {
    return this.estado === "pending" ? [{ id: "m1", attempts: 0, payload: this.payload, organizationId: "org-a" }] : [];
  }
  async markSent(): Promise<void> {
    this.estado = "sent";
  }
  async markRetry(): Promise<void> {}
  async markDead(_id: string, _a: number, c: string): Promise<void> {
    this.estado = "dead";
    this.clase = c;
  }
}

describe("MetaGraphWhatsAppClient: soloPlantilla", () => {
  it("plantilla aprobada: type=template con el codigo en el cuerpo Y en el boton de copiar codigo", async () => {
    const { client, bodies } = cliente(["codigo_acceso"]);
    await client.sendMessage({ to: "+529990000001", phoneNumberId: "p1", body: "Codigo de acceso", template: PLANTILLA, soloPlantilla: true });
    expect(bodies[0]).toEqual({
      messaging_product: "whatsapp",
      to: "+529990000001",
      type: "template",
      template: {
        name: "codigo_acceso",
        language: { code: "es_MX" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "123456" }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] },
        ],
      },
    });
  });

  it("aprobada solo en el catalogo de la organizacion (templateApproved): tambien sale como plantilla", async () => {
    const { client, bodies } = cliente(undefined);
    await client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x", template: PLANTILLA, soloPlantilla: true, templateApproved: true });
    expect(bodies[0]?.type).toBe("template");
  });

  it("plantilla NO aprobada: lanza y NUNCA hace fetch (sin caer a texto libre)", async () => {
    for (const aprobadas of [undefined, [], ["otra"]]) {
      const { client, fetchImpl } = cliente(aprobadas);
      await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "tu codigo es 123456", template: PLANTILLA, soloPlantilla: true })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("sin plantilla, con botones, documento o ubicacion: lanza y no envia", async () => {
    const { client, fetchImpl } = cliente(["codigo_acceso"]);
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x", soloPlantilla: true })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x", template: PLANTILLA, buttons: ["a"], soloPlantilla: true })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x", template: PLANTILLA, solicitarUbicacion: true, soloPlantilla: true })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sin la bandera, el comportamiento anterior no cambia (texto libre de respaldo)", async () => {
    const { client, bodies } = cliente(undefined);
    await client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "libre", template: PLANTILLA });
    expect(bodies[0]?.type).toBe("text");
  });
});

describe("dispatcher: payload solo_plantilla", () => {
  const base = { to: "+529990000001", phone_number_id: "p1", body: "Codigo de acceso", template: PLANTILLA, solo_plantilla: true };

  it("plantilla aprobada en el catalogo de la organizacion: se envia como plantilla", async () => {
    const { client, bodies } = cliente(undefined);
    const puerto = new Puerto(base);
    const r = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(puerto, { plantillas: { estaAprobada: async () => true } });
    expect(r.sent).toBe(1);
    expect(bodies[0]?.type).toBe("template");
  });

  it("plantilla no aprobada: el mensaje muere (dead) sin llamar a Meta", async () => {
    const { client, fetchImpl } = cliente(undefined);
    const puerto = new Puerto(base);
    const r = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(puerto, { plantillas: { estaAprobada: async () => false } });
    expect(r.dead).toBe(1);
    expect(puerto.estado).toBe("dead");
    expect(puerto.clase).toBe("plantilla_no_aprobada");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("si el catalogo falla, tampoco cae a texto: dead", async () => {
    const { client, fetchImpl } = cliente(undefined);
    const puerto = new Puerto(base);
    await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(puerto, { plantillas: { estaAprobada: async () => { throw new Error("catalogo caido"); } } });
    expect(puerto.estado).toBe("dead");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("payload invalido: solo_plantilla sin plantilla, con botones o con codigoBoton malo", async () => {
    for (const malo of [
      { ...base, template: undefined },
      { ...base, buttons: ["a"] },
      { ...base, solo_plantilla: "si" },
      { ...base, template: { ...PLANTILLA, codigoBoton: "12 34" } },
    ]) {
      const { client, fetchImpl } = cliente(["codigo_acceso"]);
      const puerto = new Puerto(malo);
      await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(puerto);
      expect(puerto.estado).toBe("dead");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});
