// Pruebas de orquestación del guardrail de crisis (Fase 6 §1) contra
// InMemoryCitasRepository: (1) solo se activa para rubros de salud, (2) siempre
// deja un registro real en emergency_escalations cuando se activa, (3) avisa al
// dueño por WhatsApp SOLO si configuró owner_notification_phone Y tiene un número
// de WhatsApp activo — sin romperse si falta cualquiera de los dos.
import { describe, expect, it } from "vitest";
import { runCrisisGuardrail } from "../src/crisis-guardrail.ts";
import { buildCitasFixture } from "./fixtures.ts";
import { ThrowsOnStaffWhatsAppRepo } from "./support/throws-on-staff-whatsapp-repo.ts";

describe("runCrisisGuardrail", () => {
  it("un mensaje normal en un rubro de salud no dispara nada", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedTenantConfig({ organizationId: fixture.organizationId, rubro: "psicologo" });

    const result = await runCrisisGuardrail(fixture.repo, fixture.organizationId, "5512345678", "Quiero agendar una cita para el jueves");

    expect(result.triggered).toBe(false);
    expect(fixture.repo.getEmergencyEscalations()).toHaveLength(0);
  });

  it("un rubro que NO es de salud nunca se activa, aunque el mensaje traiga la palabra clave", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedTenantConfig({ organizationId: fixture.organizationId, rubro: "barberia" });

    const result = await runCrisisGuardrail(fixture.repo, fixture.organizationId, "5512345678", "ya no aguanto más, quiero terminar con todo");

    expect(result.triggered).toBe(false);
    expect(fixture.repo.getEmergencyEscalations()).toHaveLength(0);
  });

  it("sin citas.tenant_config seedeado, no revienta y nunca se activa", async () => {
    const fixture = buildCitasFixture();
    const result = await runCrisisGuardrail(fixture.repo, fixture.organizationId, "5512345678", "quiero morirme");
    expect(result.triggered).toBe(false);
  });

  it("en un rubro de salud, una palabra clave real registra la escalación y regresa el mensaje de crisis tal cual", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedTenantConfig({ organizationId: fixture.organizationId, rubro: "psicologo" });

    const result = await runCrisisGuardrail(fixture.repo, fixture.organizationId, "5512345678", "Ya no puedo más, siento que ya no le veo sentido a nada");

    expect(result.triggered).toBe(true);
    expect(result.reply).toContain("911");
    const escalations = fixture.repo.getEmergencyEscalations();
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.organizationId).toBe(fixture.organizationId);
    expect(escalations[0]!.customerPhone).toBe("5512345678");
    expect(escalations[0]!.keywordMatched).toBe("no le veo sentido");
  });

  it("sin owner_notification_phone configurado, no intenta avisar (pero SÍ registró la escalación)", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedTenantConfig({ organizationId: fixture.organizationId, rubro: "medico" });

    const result = await runCrisisGuardrail(fixture.repo, fixture.organizationId, "5512345678", "quiero morirme");

    expect(result.triggered).toBe(true);
    expect(fixture.repo.getEmergencyEscalations()).toHaveLength(1);
    expect(fixture.repo.getOutbox().filter((m) => m.eventType === "crisis.escalated")).toHaveLength(0);
  });

  it("con owner_notification_phone Y WhatsApp activo, encola un aviso real al dueño", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedTenantConfig({ organizationId: fixture.organizationId, rubro: "dental", ownerNotificationPhone: "5599998888" });
    // buildCitasFixture ya seedea whatsapp config activo (ver fixtures.ts).

    await runCrisisGuardrail(fixture.repo, fixture.organizationId, "5512345678", "me quiero matar");

    const calls = fixture.repo.getOutbox().filter((m) => m.eventType === "crisis.escalated");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.organizationId).toBe(fixture.organizationId);
    const payload = calls[0]!.payload as { to: string; phone_number_id: string; body: string };
    expect(payload.to).toBe("5599998888");
    expect(payload.phone_number_id).toBe("1234567890");
    expect(payload.body).toContain("5512345678");
  });

  it("con owner_notification_phone pero SIN WhatsApp activo configurado, no revienta y no encola nada", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedTenantConfig({ organizationId: fixture.organizationId, rubro: "veterinaria", ownerNotificationPhone: "5599998888" });
    // Ningún WhatsApp configurado para esta organización distinta de la del fixture.
    const orgSinWhatsapp = "org-sin-whatsapp";
    fixture.repo.seedOrganization({ id: orgSinWhatsapp, slug: "clinica-sin-whatsapp", name: "Clínica Sin WhatsApp" });
    fixture.repo.seedTenantConfig({ organizationId: orgSinWhatsapp, rubro: "veterinaria", ownerNotificationPhone: "5599998888" });

    const result = await runCrisisGuardrail(fixture.repo, orgSinWhatsapp, "5512345678", "suicidio");

    expect(result.triggered).toBe(true);
    expect(fixture.repo.getOutbox().filter((m) => m.eventType === "crisis.escalated")).toHaveLength(0);
  });

  // f2-citas-whatsapp-config-sesion-sistema — el ÚNICO caller real de
  // `runCrisisGuardrail` (`whatsapp/inbound.ts::handleInboundWhatsAppMessage`,
  // webhook entrante) abre SIEMPRE una sesión de SISTEMA. Contra Postgres real,
  // `resolveActiveWhatsAppPhoneNumberId` (variante de STAFF) SIEMPRE devuelve 0
  // filas ahí -- el aviso de crisis al dueño/staff NUNCA salía, invisible
  // contra `InMemoryCitasRepository` a secas. `ThrowsOnStaffWhatsAppRepo` (lanza
  // si se llama la variante de STAFF) afirma el EFECTO real: si
  // `notifyOwnerOfEscalation` todavía llamara la variante de STAFF, este test
  // explotaría con el error BLOQUEANTE del doble.
  it("REGLA DURA (sesión de sistema): notifyOwnerOfEscalation usa la variante de SISTEMA para resolver el phone_number_id -- nunca la de STAFF, que en producción devuelve 0 filas bajo auth.uid() null", async () => {
    const fixture = buildCitasFixture(new ThrowsOnStaffWhatsAppRepo());
    fixture.repo.seedTenantConfig({ organizationId: fixture.organizationId, rubro: "dental", ownerNotificationPhone: "5599998888" });

    await runCrisisGuardrail(fixture.repo, fixture.organizationId, "5512345678", "me quiero matar");

    const calls = fixture.repo.getOutbox().filter((m) => m.eventType === "crisis.escalated");
    expect(calls).toHaveLength(1);
    const payload = calls[0]!.payload as { to: string; phone_number_id: string };
    expect(payload.to).toBe("5599998888");
    expect(payload.phone_number_id).toBe("1234567890");
  });
});
