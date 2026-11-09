// Ola 4 (H3): el medidor mensual de mensajes por plan (PL-16, apps/api/src/plan-topes/medidor.ts) solo mide los mensajes
// cuyo item del outbox trae `organizationId` (dispatcher.ts: `medidor && item.organizationId`). Citas, hoteles y restaurantes
// lo traían; licitaciones NO: sus avisos y solicitudes de decisión salían por WhatsApp sin contar contra el plan, sin aviso
// del 80 % ni del tope. La fila de `licitaciones.claim_whatsapp_outbox_batch` (setof licitaciones.whatsapp_outbox) ya trae
// `organization_id`: no hace falta migración.
import { describe, expect, it } from "vitest";
import { FakeWhatsAppGraphClient, WhatsAppOutboundDispatcher, type MedidorMensajes } from "@atiende/whatsapp-gateway";
import { InMemoryWhatsAppRepository, PostgresWhatsAppRepository, createLicitacionesMessagingOutboxPort } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000d1";

describe("licitaciones: el outbox de WhatsApp entrega la organización al medidor", () => {
  it("Postgres: el claim selecciona organization_id y el puerto lo expone como organizationId", async () => {
    const session = new AbortAwareFakeSession([
      { match: /claim_whatsapp_outbox_batch/, respond: () => [{ id: "o1", attempts: 0, organization_id: ORG, payload: { to: "+525500000000", body: "hola" } }] },
    ]);
    const [item] = await createLicitacionesMessagingOutboxPort(new PostgresWhatsAppRepository(session), "123456").claimBatch(5, 60);
    expect(item?.organizationId).toBe(ORG);
    expect(session.calls.some((q) => /select[^;]*organization_id[^;]*from licitaciones\.claim_whatsapp_outbox_batch/.test(q))).toBe(true);
  });

  it("en memoria: mismo contrato", async () => {
    const repo = new InMemoryWhatsAppRepository();
    await repo.enqueueOutbox(ORG, "aviso", "k1", { to: "+525500000000", body: "hola" });
    const [item] = await createLicitacionesMessagingOutboxPort(repo, "123456").claimBatch(5, 60);
    expect(item?.organizationId).toBe(ORG);
  });

  it("el dispatcher llama al medidor para un aviso de licitaciones enviado", async () => {
    const repo = new InMemoryWhatsAppRepository();
    await repo.enqueueOutbox(ORG, "aviso", "k2", { to: "+525500000000", body: "hola" });
    const medidos: string[] = [];
    const medidor: MedidorMensajes = {
      antesDeEnviar: async () => ({ permitir: true }),
      despuesDeEnviar: async (ctx) => {
        medidos.push(`${ctx.label}:${ctx.organizationId}`);
      },
    };
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: new FakeWhatsAppGraphClient() });
    const r = await dispatcher.dispatchPending(createLicitacionesMessagingOutboxPort(repo, "123456"), { limit: 5, medidor });
    expect(r.sent).toBe(1);
    expect(medidos).toEqual([`licitaciones:${ORG}`]);
  });
});
