// PL-31 -- el despachador consulta el catalogo de plantillas POR ORGANIZACION.
// Contra el simulador local de Meta (regla de la ventana de 24 h real): sin red externa ni credenciales.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppOutboundDispatcher } from "../src/dispatcher.ts";
import type { CatalogoPlantillas } from "../src/dispatcher.ts";
import { FakeWhatsAppGraphClient } from "../src/providers/fake-graph-client.ts";
import { MetaGraphWhatsAppClient } from "../src/providers/meta-graph-client.ts";
import type { MessagingOutboxItem, MessagingOutboxPort } from "../src/outbox-port.ts";
import { MetaCloudSimulator, serveFetchHandler } from "../src/testing/index.ts";

const ORG_A = "org-a";
const ORG_B = "org-b";
const PNID = "1234567890";
const TOKEN = "sim-access-token";
const TELEFONO = "+5219981110001";

class PuertoMemoria implements MessagingOutboxPort {
  readonly label = "test";
  estado: "pending" | "sent" | "dead" = "pending";
  clase: string | null = null;
  constructor(private readonly payload: unknown, private readonly organizationId: string | undefined) {}
  async claimBatch(): Promise<readonly MessagingOutboxItem[]> {
    return this.estado === "pending" ? [{ id: "m1", attempts: 0, payload: this.payload, ...(this.organizationId ? { organizationId: this.organizationId } : {}) }] : [];
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

const plantilla = { name: "recordatorio_cita", language: "es_MX", params: ["Ana", "10:00"] } as const;
const aviso = { to: TELEFONO, phone_number_id: PNID, body: "Recordatorio: su cita es manana a las 10:00", template: plantilla };

/** Catalogo en memoria: cada organizacion tiene sus propias plantillas aprobadas. */
function catalogo(aprobadas: Record<string, readonly string[]>): CatalogoPlantillas {
  return { estaAprobada: async (org, nombre) => (aprobadas[org] ?? []).includes(nombre) };
}

describe("PL-31: plantilla aprobada por organizacion contra el simulador de Meta", () => {
  let sim: MetaCloudSimulator;
  let client: MetaGraphWhatsAppClient;

  beforeEach(async () => {
    sim = new MetaCloudSimulator({ appSecret: "s", accessToken: TOKEN, phoneNumberId: PNID });
    await sim.start();
    // Sin lista global de plantillas: solo el catalogo por organizacion puede aprobar.
    client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, baseUrl: sim.baseUrl });
  });
  afterEach(async () => {
    await sim.stop();
  });

  it("la plantilla aprobada de la org A se envia como type=template fuera de la ventana de 24 h", async () => {
    const puerto = new PuertoMemoria(aviso, ORG_A);
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(puerto, { plantillas: catalogo({ [ORG_A]: ["recordatorio_cita"] }) });
    expect(resumen.sent).toBe(1);
    expect(sim.sentTo(TELEFONO)[0]).toMatchObject({ type: "template", templateName: "recordatorio_cita" });
  });

  it("la plantilla aprobada de la org B NO sirve a la org A: sale como texto libre y Meta lo rechaza fuera de la ventana (dead, nunca sent fingido)", async () => {
    const puerto = new PuertoMemoria(aviso, ORG_A);
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(puerto, { plantillas: catalogo({ [ORG_B]: ["recordatorio_cita"] }) });
    expect(resumen.sent).toBe(0);
    expect(resumen.dead).toBe(1);
    expect(puerto.estado).toBe("dead");
    expect(sim.accepted).toHaveLength(0);
    expect(sim.rejected[0]?.code).toBe(131047);
  });

  it("sin catalogo ni lista global (comportamiento anterior): texto libre, rechazado fuera de la ventana", async () => {
    const puerto = new PuertoMemoria(aviso, ORG_A);
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(puerto);
    expect(resumen.dead).toBe(1);
  });

  it("dentro de la ventana de 24 h el texto libre sale aunque no haya plantilla", async () => {
    const webhook = await serveFetchHandler(async () => new Response('{"ok":true}', { status: 200 }));
    try {
      sim.setWebhookUrl(`${webhook.baseUrl}/hook`);
      await sim.deliverInbound({ from: TELEFONO, body: "hola" });
    } finally {
      await webhook.close();
    }
    const puerto = new PuertoMemoria(aviso, ORG_A);
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(puerto, { plantillas: catalogo({}) });
    expect(resumen.sent).toBe(1);
    expect(sim.sentTo(TELEFONO)[0]?.type).toBe("text");
  });

  it("la lista global del entorno sigue funcionando como respaldo (compatibilidad)", async () => {
    const conGlobal = new MetaGraphWhatsAppClient({ accessToken: TOKEN, baseUrl: sim.baseUrl, approvedTemplates: ["recordatorio_cita"] });
    const puerto = new PuertoMemoria(aviso, ORG_A);
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: conGlobal }).dispatchPending(puerto, { plantillas: catalogo({}) });
    expect(resumen.sent).toBe(1);
    expect(sim.sentTo(TELEFONO)[0]?.type).toBe("template");
  });

  it("un catalogo que LANZA (base sin migrar) no tumba el envio: decide la lista global", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const roto: CatalogoPlantillas = {
      estaAprobada: async () => {
        throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      },
    };
    const conGlobal = new MetaGraphWhatsAppClient({ accessToken: TOKEN, baseUrl: sim.baseUrl, approvedTemplates: ["recordatorio_cita"] });
    const puerto = new PuertoMemoria(aviso, ORG_A);
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: conGlobal }).dispatchPending(puerto, { plantillas: roto });
    expect(resumen.sent).toBe(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("el despachador pasa templateApproved al cliente solo cuando el catalogo de ESA organizacion la aprueba", async () => {
    const fake = new FakeWhatsAppGraphClient();
    await new WhatsAppOutboundDispatcher({ graphClient: fake }).dispatchPending(new PuertoMemoria(aviso, ORG_A), { plantillas: catalogo({ [ORG_A]: ["recordatorio_cita"] }) });
    await new WhatsAppOutboundDispatcher({ graphClient: fake }).dispatchPending(new PuertoMemoria(aviso, ORG_B), { plantillas: catalogo({ [ORG_A]: ["recordatorio_cita"] }) });
    expect(fake.sent[0]?.templateApproved).toBe(true);
    expect("templateApproved" in (fake.sent[1] ?? {})).toBe(false);
  });
});
