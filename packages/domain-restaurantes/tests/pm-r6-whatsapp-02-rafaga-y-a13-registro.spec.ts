// Huecos de pruebas de #551 confirmados por mutacion (revision Opus):
//  * QA-PM-R6-whatsapp-02 por la ruta de RAFAGA (`responderTrasEspera`): un turno con falla del sistema queda `processed` con la clase FallaDelSistema.
//  * QA-PM-R6 A13 por el REGISTRO (`confirmar_resumen`): un rechazo del resumen en el ultimo mensaje del cliente impide confirmar. Reloj fijo, sin LLM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLASE_FALLA_DEL_SISTEMA } from "../src/alertas-duenio/timeouts-agente.ts";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { recibirMensajeConEspera, responderTrasEspera } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const TELEFONO = "+5219991234567";
const PN = "1234567890";

describe("whatsapp-02 por la ruta de rafaga (responderTrasEspera)", () => {
  async function correr(escalacion?: { motivo: string }) {
    const f = buildRestaurantFixture();
    const finish = vi.spyOn(f.repo, "finishWhatsAppMessage");
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        return { reply: "En este momento tenemos un problema técnico. Ya avisé al equipo.", orderId: null, propertyId: null, ...(escalacion ? { escalacion } : {}) } as never;
      },
    };
    await recibirMensajeConEspera(f.repo, { organizationId: f.organizationId, messageId: "wamid.1", phone: TELEFONO, body: "hola" });
    await responderTrasEspera(f.repo, handler, { organizationId: f.organizationId, messageId: "wamid.1", phone: TELEFONO, phoneNumberId: PN });
    return finish.mock.calls.map((c) => [c[3], c[4]]);
  }
  it("falla_sistema: processed con la clase FallaDelSistema", async () => {
    expect(await correr({ motivo: "falla_sistema" })).toContainEqual(["processed", CLASE_FALLA_DEL_SISTEMA]);
  });
  it("un turno normal o con otro motivo de escalacion: processed sin clase", async () => {
    expect(await correr()).toContainEqual(["processed", null]);
    const otra = await correr({ motivo: "queja" });
    expect(otra).toContainEqual(["processed", null]);
    expect(otra).not.toContainEqual(["processed", CLASE_FALLA_DEL_SISTEMA]);
  });
});

describe("A13: confirmar_resumen por el registro respeta el rechazo del cliente", () => {
  beforeEach(() => {
    resetOrderFlowWarningForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
  });
  afterEach(() => vi.useRealTimers());

  function setup(channel: "whatsapp" | "voz", ultimo?: string) {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
    void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
    let turn = 1;
    const conversacionReciente = ultimo === undefined ? undefined : [{ role: "user" as const, content: "3 tacos" }, { role: "assistant" as const, content: "Resumen... ¿Confirma?" }, { role: "user" as const, content: ultimo }];
    const ctx = () => ({ organizationId: f.organizationId, channel, phone: "9991234567", flow: { key: `k:${channel}`, turn: String(turn), now: () => Date.now() }, ...(conversacionReciente ? { conversacionReciente } : {}) });
    const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
    const quote = () => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items });
    const confirm = () => invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
    return { quote, confirm, nextTurn: () => void (turn += 1) };
  }

  it.each(["No, así no", "no es correcto, son 4", "Eso está mal"])("whatsapp: tras «%s» NO se confirma", async (rechazo) => {
    const s = setup("whatsapp", rechazo);
    await s.quote();
    s.nextTurn();
    await expect(s.confirm()).rejects.toMatchObject({ code: "cliente_rechazo_resumen" });
  });
  it.each(["Sí, confirmo", "No está mal, confírmelo", "Perfecto, no cambia nada", "no, nada más"])("whatsapp: tras «%s» SI se confirma", async (si) => {
    const s = setup("whatsapp", si);
    await s.quote();
    s.nextTurn();
    await expect(s.confirm()).resolves.toMatchObject({ result: { confirmado: true } });
  });
  it("sin historial de conversacion (o en voz) el rechazo no se evalua y se confirma como siempre", async () => {
    for (const [canal, ultimo] of [["whatsapp", undefined], ["voz", "No, así no"]] as const) {
      const s = setup(canal, ultimo);
      await s.quote();
      s.nextTurn();
      await expect(s.confirm()).resolves.toMatchObject({ result: { confirmado: true } });
    }
  });
});
