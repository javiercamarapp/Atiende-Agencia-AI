// Flujo completo de la guardia de crisis en WhatsApp y en voz: antes del LLM, mensaje de ayuda tal cual, escalacion registrada, aviso al negocio,
// el agente no sigue con la agenda, y los falsos positivos del consultorio siguen al agente de siempre.
import { describe, expect, it, vi } from "vitest";
import { createDefaultConversationGuard, handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../../src/whatsapp/turn-handler.ts";
import { CRISIS_ESCALATION_MESSAGE, CRISIS_VOICE_MESSAGE } from "../../src/vertical-config.ts";
import { crearGuardiaCrisisVoz, evaluarCrisisVoz } from "../../src/voz/guardia-crisis.ts";
import { buildCitasFixture } from "../fixtures.ts";

function llmSpy(): { handler: WhatsAppTurnHandler; calls: () => number } {
  const spy = vi.fn(async () => ({ reply: "respuesta del agente de agenda", appointmentId: null, propertyId: null }));
  return { handler: { handleInboundMessage: spy }, calls: () => spy.mock.calls.length };
}

let consecutivo = 0;
async function escribe(fixture: ReturnType<typeof buildCitasFixture>, handler: WhatsAppTurnHandler, body: string) {
  consecutivo += 1;
  return handleInboundWhatsAppMessage(fixture.repo, handler, createDefaultConversationGuard({}), { organizationId: fixture.organizationId, messageId: `wamid-crisis-${consecutivo}`, phone: "+5219981234567", body, phoneNumberId: "1234567890" });
}

describe("WhatsApp: crisis (rubro psicologo)", () => {
  for (const frase of ["Me quiero morir, ya no sé qué hacer", "Creo que me voy a suicidar", "Estoy pensando en quitarme la vida", "Me voy a matar", "me quiero  morir"]) {
    it(`"${frase}": mensaje de ayuda tal cual, sin LLM, escalación registrada y aviso al negocio`, async () => {
      const fixture = buildCitasFixture();
      fixture.repo.seedTenantConfig({ organizationId: fixture.organizationId, rubro: "psicologo", ownerNotificationPhone: "5599998888" });
      const { handler, calls } = llmSpy();
      const outcome = await escribe(fixture, handler, frase);
      expect(outcome.reply).toBe(CRISIS_ESCALATION_MESSAGE);
      expect(calls()).toBe(0);
      expect(fixture.repo.getEmergencyEscalations()).toHaveLength(1);
      const aviso = fixture.repo.getOutbox().find((o) => o.eventType === "crisis.escalated");
      expect((aviso?.payload as { to: string }).to).toBe("5599998888");
    });
  }

  it("la escalación guarda la etiqueta de la familia, nunca la frase del paciente", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedTenantConfig({ organizationId: fixture.organizationId, rubro: "psicologo", ownerNotificationPhone: "5599998888" });
    await escribe(fixture, llmSpy().handler, "Me quiero morir porque mi diagnóstico es depresión mayor");
    const [esc] = fixture.repo.getEmergencyEscalations();
    expect(esc!.keywordMatched).toBe("ideación suicida");
    const aviso = fixture.repo.getOutbox().find((o) => o.eventType === "crisis.escalated");
    expect(JSON.stringify(aviso?.payload)).not.toContain("depresi");
  });

  it("el mensaje de ayuda trae la Línea de la Vida (800 911 2000) y el 911", () => {
    expect(CRISIS_ESCALATION_MESSAGE).toContain("800 911 2000");
    expect(CRISIS_ESCALATION_MESSAGE).toContain("911");
    expect(CRISIS_ESCALATION_MESSAGE.toLowerCase()).toContain("línea de la vida");
  });
});

describe("WhatsApp: falsos positivos del consultorio dental siguen al agente de agenda", () => {
  for (const frase of ["se me cortó la llamada", "la ortodoncia me lastimó la encía", "el lunes ya no puedo más tarde de las 5", "Ya no aguanto el dolor de muela, necesito cita hoy mismo", "¿Me corto las uñas antes de la cirugía?", "Ya no puedo más con este dolor de la endodoncia, ¿hay lugar mañana?"]) {
    it(`"${frase}"`, async () => {
      const fixture = buildCitasFixture();
      fixture.repo.seedTenantConfig({ organizationId: fixture.organizationId, rubro: "dental", ownerNotificationPhone: "5599998888" });
      const { handler, calls } = llmSpy();
      const outcome = await escribe(fixture, handler, frase);
      expect(outcome.reply).toBe("respuesta del agente de agenda");
      expect(calls()).toBe(1);
      expect(fixture.repo.getEmergencyEscalations()).toHaveLength(0);
    });
  }
});

describe("Voz: la misma guardia, con la versión de voz del mensaje", () => {
  it("evaluarCrisisVoz detecta las frases comunes y dice el mensaje de voz con motivo crisis y solo la etiqueta", () => {
    for (const frase of ["me quiero morir", "me voy a suicidar", "me voy a matar", "quiero quitarme la vida", "kiero morirme", "ya no quiero estar aqui", "no aguanto mas", "quiero  morirme"]) {
      const decision = evaluarCrisisVoz(frase);
      expect(decision, frase).toMatchObject({ texto: CRISIS_VOICE_MESSAGE, motivo: "crisis" });
      expect(decision!.resumen.startsWith("palabra_clave:")).toBe(true);
      expect(decision!.resumen).not.toContain(frase);
    }
  });

  it("no dispara con los falsos positivos de la clínica", () => {
    for (const frase of ["se me cortó la llamada", "el lunes ya no puedo más tarde de las 5", "ya no aguanto el dolor de muela", "me corto el pelo el sábado"]) expect(evaluarCrisisVoz(frase), frase).toBeNull();
  });

  it("el mensaje de voz trata de usted, no trae barras que el TTS leería y conserva las líneas de ayuda", () => {
    expect(CRISIS_VOICE_MESSAGE).not.toContain("/");
    expect(CRISIS_VOICE_MESSAGE).not.toMatch(/\bsolo\/a\b/);
    expect(CRISIS_VOICE_MESSAGE).not.toMatch(/\b(?:estás|tu vida|contacta|llama al)\b/);
    expect(CRISIS_VOICE_MESSAGE).toContain("800 911 2000");
    expect(CRISIS_VOICE_MESSAGE).toContain("911");
    expect(CRISIS_VOICE_MESSAGE).toContain("No está solo ni sola");
  });

  it("la guardia de la llamada se arma en salud, sin rubro y con 'otro'; no en un rubro explícito que no es de salud", () => {
    const decir = async () => undefined;
    expect(crearGuardiaCrisisVoz("psicologo", decir)).not.toBeNull();
    expect(crearGuardiaCrisisVoz(null, decir)).not.toBeNull();
    expect(crearGuardiaCrisisVoz("otro", decir)).not.toBeNull();
    expect(crearGuardiaCrisisVoz("barberia", decir)).toBeNull();
  });
});
