// QA-PM-R6-whatsapp-02: un turno que termina en «problema tecnico» (LLM sin credito) responde al cliente y queda `processed`, pero la bitacora lo marca FallaDelSistema para que la alerta
// de racha (5 fallos seguidos, migracion 085) lo cuente. Un turno normal no lleva clase.
import { describe, expect, it, vi } from "vitest";
import { CLASE_FALLA_DEL_SISTEMA, evaluarTimeoutsAgente } from "../src/alertas-duenio/timeouts-agente.ts";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const turnoCon = (escalacion?: { motivo: string }) => ({
  async handleInboundMessage() {
    return { reply: "En este momento tenemos un problema técnico. Ya avisé al equipo.", orderId: null, propertyId: null, ...(escalacion ? { escalacion } : {}) };
  },
});

describe("turno con falla del sistema", () => {
  it("marca el evento procesado con la clase FallaDelSistema; un turno normal no", async () => {
    const f = buildRestaurantFixture();
    const finish = vi.spyOn(f.repo, "finishWhatsAppMessage");
    const args = (id: string) => ({ organizationId: f.organizationId, messageId: id, phone: "9991234567", body: "hola", phoneNumberId: "1" });
    await handleInboundWhatsAppMessage(f.repo, turnoCon({ motivo: "falla_sistema" }), args("m1"));
    await handleInboundWhatsAppMessage(f.repo, turnoCon(), args("m2"));
    await handleInboundWhatsAppMessage(f.repo, turnoCon({ motivo: "queja" }), args("m3"));
    const porMensaje = new Map(finish.mock.calls.map((c) => [c[1], [c[3], c[4]]]));
    expect(porMensaje.get("m1")).toEqual(["processed", CLASE_FALLA_DEL_SISTEMA]);
    expect(porMensaje.get("m2")).toEqual(["processed", null]);
    expect(porMensaje.get("m3")).toEqual(["processed", null]);
  });
  it("cinco turnos FallaDelSistema seguidos de una organizacion disparan la racha de la alerta", () => {
    const ahora = new Date("2026-10-07T18:00:00Z");
    const turnos = Array.from({ length: 5 }, (_, i) => ({ organizationId: "org-a", at: new Date(ahora.getTime() - (i + 1) * 60_000), resultado: "fallo" as const }));
    const d = evaluarTimeoutsAgente(turnos, ahora);
    expect(JSON.stringify(d)).toContain("org-a");
  });
});
