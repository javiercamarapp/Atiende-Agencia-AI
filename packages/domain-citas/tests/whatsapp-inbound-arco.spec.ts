// C-02 -- el fast-path ARCO dentro de `handleInboundWhatsAppMessage`: antes del LLM,
// después del guardrail de crisis, y compatible con la base sin migrar.
import { describe, expect, it, vi } from "vitest";
import { createDefaultConversationGuard, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { buildCitasFixture } from "./fixtures.ts";

function llmSpy(): { handler: WhatsAppTurnHandler; calls: () => number } {
  const spy = vi.fn(async () => ({ reply: "respuesta del agente LLM", appointmentId: null, propertyId: null }));
  return { handler: { handleInboundMessage: spy }, calls: () => spy.mock.calls.length };
}

async function send(fixture: ReturnType<typeof buildCitasFixture>, handler: WhatsAppTurnHandler, id: string, body: string, phone = "+5219981234567") {
  return handleInboundWhatsAppMessage(fixture.repo, handler, createDefaultConversationGuard({}), { organizationId: fixture.organizationId, messageId: id, phone, body, phoneNumberId: "1234567890" });
}

describe("handleInboundWhatsAppMessage + fast-path ARCO", () => {
  it("una solicitud ARCO NO llega al LLM, se responde con el guion guiado y se encola el envío real", async () => {
    const fixture = buildCitasFixture();
    const { handler, calls } = llmSpy();
    const outcome = await send(fixture, handler, "wamid-arco-1", "Quiero acceso a mis datos personales");
    expect(outcome.ok).toBe(true);
    expect(outcome.reply).toContain("CONFIRMO");
    expect(calls()).toBe(0);
    expect(fixture.repo.dataRightsRequests).toHaveLength(1);
    expect(fixture.repo.dataRightsRequests[0]!.customerPhone).toBe("+5219981234567");
  });

  it("flujo de dos turnos: solicitud -> CONFIRMO -> recibida, sin pasar nunca por el LLM", async () => {
    const fixture = buildCitasFixture();
    const { handler, calls } = llmSpy();
    await send(fixture, handler, "wamid-arco-2", "Quiero que eliminen mis datos personales");
    const second = await send(fixture, handler, "wamid-arco-3", "CONFIRMO");
    expect(second.reply).toContain("quedó registrada");
    expect(fixture.repo.dataRightsRequests[0]!.status).toBe("recibida");
    expect(calls()).toBe(0);
  });

  it("un mensaje normal de citas sigue al LLM", async () => {
    const fixture = buildCitasFixture();
    const { handler, calls } = llmSpy();
    const outcome = await send(fixture, handler, "wamid-arco-4", "Hola, quiero agendar una cita");
    expect(outcome.reply).toBe("respuesta del agente LLM");
    expect(calls()).toBe(1);
    expect(fixture.repo.dataRightsRequests).toHaveLength(0);
  });

  it("'CONFIRMO' sin solicitud pendiente sigue al LLM (puede ser la confirmación de otra cosa)", async () => {
    const fixture = buildCitasFixture();
    const { handler, calls } = llmSpy();
    const outcome = await send(fixture, handler, "wamid-arco-5", "CONFIRMO");
    expect(outcome.reply).toBe("respuesta del agente LLM");
    expect(calls()).toBe(1);
  });

  it("base sin migrar: el mensaje ARCO cae al camino anterior (LLM), sin error ni promesa vacía", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.dataRightsMigrationPending = true;
    const { handler, calls } = llmSpy();
    const outcome = await send(fixture, handler, "wamid-arco-6", "Quiero acceso a mis datos personales");
    expect(outcome.ok).toBe(true);
    expect(outcome.reply).toBe("respuesta del agente LLM");
    expect(calls()).toBe(1);
  });

  it("la crisis tiene prioridad sobre ARCO (rubro de salud)", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedTenantConfig({ organizationId: fixture.organizationId, rubro: "psicologo" });
    const { handler, calls } = llmSpy();
    const outcome = await send(fixture, handler, "wamid-arco-7", "Quiero acceso a mis datos personales, quiero suicidarme");
    expect(outcome.reply).not.toContain("CONFIRMO");
    expect(fixture.repo.dataRightsRequests).toHaveLength(0);
    expect(calls()).toBe(0);
  });
});
