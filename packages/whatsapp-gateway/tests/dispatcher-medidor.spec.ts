// Medidor mensual de mensajes por plan en el dispatcher (PL-16). Reglas: lo transaccional SIEMPRE sale; un proactivo no critico se
// omite solo si el medidor lo pide (plan con accion `pausar` y tope consumido); el envio exitoso se registra; un medidor roto
// NUNCA deja a un cliente sin respuesta (fail-open); sin organizationId en el mensaje no se mide nada (como antes).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CUOTA_ERROR_CLASS, WhatsAppOutboundDispatcher } from "../src/dispatcher.ts";
import type { ContextoMedicion, MedidorMensajes } from "../src/dispatcher.ts";
import { WhatsAppSendError } from "../src/errors.ts";
import { FakeWhatsAppGraphClient } from "../src/providers/fake-graph-client.ts";
import type { MessagingOutboxItem, MessagingOutboxPort } from "../src/outbox-port.ts";

const ORG = "00000000-0000-0000-0000-00000000a101";

class Port implements MessagingOutboxPort {
  readonly label = "citas";
  readonly estados = new Map<string, { status: string; errorClass: string | null }>();
  private readonly items: MessagingOutboxItem[] = [];

  enqueue(payload: Record<string, unknown>, organizationId: string | null = ORG): string {
    const id = randomUUID();
    this.items.push({ id, attempts: 0, payload: { to: "+529991112233", phone_number_id: "p1", body: "hola", ...payload }, ...(organizationId ? { organizationId } : {}) });
    this.estados.set(id, { status: "pending", errorClass: null });
    return id;
  }
  async claimBatch(): Promise<readonly MessagingOutboxItem[]> {
    return this.items.splice(0);
  }
  async markSent(id: string): Promise<void> {
    this.estados.set(id, { status: "sent", errorClass: null });
  }
  async markRetry(id: string, _a: number, errorClass: string): Promise<void> {
    this.estados.set(id, { status: "pending", errorClass });
  }
  async markDead(id: string, _a: number, errorClass: string): Promise<void> {
    this.estados.set(id, { status: "dead", errorClass });
  }
}

function medidor(permitir: boolean, motivo?: string): MedidorMensajes & { antes: ContextoMedicion[]; despues: ContextoMedicion[] } {
  const antes: ContextoMedicion[] = [];
  const despues: ContextoMedicion[] = [];
  return {
    antes,
    despues,
    async antesDeEnviar(ctx) {
      antes.push(ctx);
      return motivo ? { permitir, motivo } : { permitir };
    },
    async despuesDeEnviar(ctx) {
      despues.push(ctx);
    },
  };
}

describe("WhatsAppOutboundDispatcher + medidor de mensajes (PL-16)", () => {
  it("un mensaje enviado se registra una vez, con la organizacion y si era proactivo", async () => {
    const port = new Port();
    const id = port.enqueue({ transaccional: true });
    const m = medidor(true);
    const client = new FakeWhatsAppGraphClient();
    const summary = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(port, { medidor: m });
    expect(summary.sent).toBe(1);
    expect(m.despues).toEqual([{ label: "citas", itemId: id, organizationId: ORG, proactivo: false, critico: false }]);
  });

  it("un proactivo omitido por el tope NO sale, queda dead con el motivo, no se registra como enviado y no se reintenta", async () => {
    const port = new Port();
    const id = port.enqueue({});
    const m = medidor(false, CUOTA_ERROR_CLASS);
    const client = new FakeWhatsAppGraphClient();
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: client });
    const summary = await dispatcher.dispatchPending(port, { medidor: m });
    expect(client.sent).toHaveLength(0);
    expect(summary.omitidosCuota).toBe(1);
    expect(summary.dead).toBe(0);
    expect(summary.items[0]?.outcome).toBe("omitido_cuota");
    expect(port.estados.get(id)).toEqual({ status: "dead", errorClass: "tope_mensajes_plan" });
    expect(m.antes[0]).toMatchObject({ proactivo: true, critico: false });
    expect(m.despues).toHaveLength(0);
    // Sin reintento: la siguiente corrida ya no lo ve.
    expect((await dispatcher.dispatchPending(port, { medidor: m })).claimed).toBe(0);
  });

  it("el payload critico viaja al medidor como critico", async () => {
    const port = new Port();
    port.enqueue({ critico: true });
    const m = medidor(true);
    await new WhatsAppOutboundDispatcher({ graphClient: new FakeWhatsAppGraphClient() }).dispatchPending(port, { medidor: m });
    expect(m.antes[0]).toMatchObject({ proactivo: true, critico: true });
  });

  it("FAIL-OPEN: si el medidor lanza antes de enviar, el mensaje SALE igual (un medidor roto nunca deja a un cliente sin respuesta)", async () => {
    const port = new Port();
    const id = port.enqueue({ transaccional: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const roto: MedidorMensajes = {
      async antesDeEnviar() {
        throw Object.assign(new Error("boom con datos +529991112233"), { code: "XX000" });
      },
      async despuesDeEnviar() {
        throw new Error("tampoco registra");
      },
    };
    const client = new FakeWhatsAppGraphClient();
    const summary = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(port, { medidor: roto });
    expect(client.sent).toHaveLength(1);
    expect(summary.sent).toBe(1);
    expect(port.estados.get(id)?.status).toBe("sent");
    // El diagnostico no lleva el mensaje del error (podria traer PII): solo SQLSTATE y clase.
    const registrado = error.mock.calls.flat().join(" ");
    expect(registrado).not.toContain("+529991112233");
    error.mockRestore();
  });

  it("sin organizationId en el mensaje (verticales que aun no lo reportan) no se mide ni se omite nada", async () => {
    const port = new Port();
    port.enqueue({}, null);
    const m = medidor(false, CUOTA_ERROR_CLASS);
    const client = new FakeWhatsAppGraphClient();
    const summary = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(port, { medidor: m });
    expect(summary.sent).toBe(1);
    expect(m.antes).toHaveLength(0);
    expect(m.despues).toHaveLength(0);
  });

  it("sin medidor el comportamiento es el de antes", async () => {
    const port = new Port();
    port.enqueue({});
    const client = new FakeWhatsAppGraphClient();
    const summary = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(port);
    expect(summary.sent).toBe(1);
    expect(summary.omitidosCuota).toBeUndefined();
  });

  it("un envio que falla (reintentable) no se registra como mensaje atendido", async () => {
    const port = new Port();
    port.enqueue({ transaccional: true });
    const m = medidor(true);
    const client = new FakeWhatsAppGraphClient({ onSend: () => new WhatsAppSendError("red caida", true) });
    const summary = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(port, { medidor: m });
    expect(summary.retried).toBe(1);
    expect(m.despues).toHaveLength(0);
  });
});
