// QA citas R1 -- lente VIAJE COMPLETO. (1) Guardia de crisis en el viaje real de un paciente de clinica (dental/psicologo): lo que SI debe
// detenerse y lo que NO debe confundirse con una crisis. (2) Desenlace de la lista de espera: el hueco liberado llega al paciente correcto y
// su "Si" tiene salida. Pipeline real del webhook con LLM guionado; nada sale a Meta.
import { describe, expect, it } from "vitest";
import { createAppointment, findAppointmentsForCustomerPhone } from "../../src/appointments.ts";
import { zonedTimeToUtc } from "../../src/availability.ts";
import { runOptimizadorCore } from "../../src/reminders.ts";
import { CRISIS_ESCALATION_MESSAGE } from "../../src/vertical-config.ts";
import { TEL_AVISOS, TEL_ESPERA, TEL_PACIENTE, ZONA, canalWhatsapp, clinicaDental, herramienta, proximoDia, texto } from "./support.ts";

describe("viaje crisis (WhatsApp, rubro de salud)", () => {
  it("una crisis real se atiende sin LLM: mensaje de ayuda tal cual, escalacion registrada, aviso al telefono del negocio", async () => {
    const mundo = clinicaDental({ rubro: "psicologo" });
    const wa = canalWhatsapp(mundo);
    const r = await wa.escribe(TEL_PACIENTE, "La verdad ya no quiero vivir", () => texto("NO DEBERIA LLAMARSE"));
    expect(r.reply).toBe(CRISIS_ESCALATION_MESSAGE);
    expect(wa.llamadasLlm).toBe(0);
    expect(mundo.repo.getEmergencyEscalations()).toHaveLength(1);
    const aviso = mundo.repo.getOutbox().find((o) => o.eventType === "crisis.escalated");
    expect((aviso?.payload as { to: string }).to).toBe(TEL_AVISOS);
  });

  it("un rubro que no es de salud (barberia) nunca dispara la guardia (decision documentada)", async () => {
    const mundo = clinicaDental({ rubro: "barberia" });
    const wa = canalWhatsapp(mundo);
    await wa.escribe(TEL_PACIENTE, "ya no aguanto el pelo largo, quiero corte hoy", () => texto("Claro, ¿a qué hora?"));
    expect(wa.llamadasLlm).toBe(1);
    expect(mundo.repo.getEmergencyEscalations()).toHaveLength(0);
  });

  // Falsos POSITIVOS: un paciente de dentista con dolor ("ya no aguanto") o que pregunta si "me corto" algo NO esta en crisis. Hoy la guardia
  // le contesta con la Linea de la Vida, registra una escalacion critica, avisa al dueno y el agente deja de agendar (su urgencia real se pierde).
  for (const [id, frase] of [
    ["QA-citas-R1-viaje-07a", "Ya no aguanto el dolor de muela, necesito cita hoy mismo"],
    ["QA-citas-R1-viaje-07b", "¿Me corto las uñas antes de la cirugía o no hace falta?"],
    ["QA-citas-R1-viaje-07c", "Ya no puedo más con este dolor de la endodoncia, ¿hay lugar mañana?"],
  ] as const) {
    it(`${id}: "${frase}" en una clinica dental sigue al agente de agenda (no es crisis)`, async () => {
      const mundo = clinicaDental({ rubro: "dental" });
      const wa = canalWhatsapp(mundo);
      const r = await wa.escribe(TEL_PACIENTE, frase, () => texto("Con gusto le busco un horario."));
      expect(r.reply).not.toBe(CRISIS_ESCALATION_MESSAGE);
      expect(mundo.repo.getEmergencyEscalations()).toHaveLength(0);
    });
  }

  // Falsos NEGATIVOS: formas comunes en es-MX que la lista fija no cubre. El mensaje llega al LLM como si fuera de agenda.
  for (const [id, frase] of [
    ["QA-citas-R1-viaje-08a", "Me quiero morir, ya no sé qué hacer"],
    ["QA-citas-R1-viaje-08b", "Creo que me voy a suicidar"],
    ["QA-citas-R1-viaje-08c", "Estoy pensando en quitarme la vida"],
    ["QA-citas-R1-viaje-08d", "Me voy a matar"],
  ] as const) {
    it(`${id}: "${frase}" a un psicologo dispara la guardia de crisis`, async () => {
      const mundo = clinicaDental({ rubro: "psicologo" });
      const wa = canalWhatsapp(mundo);
      const r = await wa.escribe(TEL_PACIENTE, frase, () => texto("¿Para qué día quiere su cita?"));
      expect(r.reply).toBe(CRISIS_ESCALATION_MESSAGE);
      expect(wa.llamadasLlm).toBe(0);
    });
  }

  it("con la conversacion en manos de una persona (handoff) la crisis IGUAL se atiende (prioridad de la guardia)", async () => {
    const mundo = clinicaDental({ rubro: "psicologo" });
    const wa = canalWhatsapp(mundo);
    // Primer mensaje de crisis abre el handoff (sin puerto de handoff en memoria: la escalacion queda registrada igual).
    await wa.escribe(TEL_PACIENTE, "quiero morirme", () => texto("x"));
    const r = await wa.escribe(TEL_PACIENTE, "sigo pensando en acabar con mi vida", () => texto("x"));
    expect(r.reply).toBe(CRISIS_ESCALATION_MESSAGE);
    expect(mundo.repo.getEmergencyEscalations()).toHaveLength(2);
  });
});

describe("viaje lista de espera: del hueco liberado al paciente que espera", () => {
  it("un hueco liberado por la manana se ofrece al primero de la fila que pidio ese dia", async () => {
    const mundo = clinicaDental();
    const martes = proximoDia(2, 2);
    mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: TEL_ESPERA, customerName: "Mario Chan", providerId: mundo.drPaola, serviceId: mundo.limpieza, preferredDateFrom: martes, preferredDateTo: martes, preferredTimeWindow: "any" });
    const r = await runOptimizadorCore(mundo.repo, mundo.organizationId, ZONA, { providerId: mundo.drPaola, serviceId: mundo.limpieza, startsAt: zonedTimeToUtc(martes, "10:00", ZONA).toISOString() });
    expect(r.matched).toBe(true);
    expect(r.customerPhone).toBe(TEL_ESPERA);
  });

  it.fails("QA-citas-R1-viaje-09: un hueco de la TARDE (19:00 Merida = dia siguiente en UTC) se ofrece a quien pidio ESE dia, no al que pidio el dia siguiente", async () => {
    const mundo = clinicaDental({ hastaLas: "20:00" });
    const martes = proximoDia(2, 2);
    const miercoles = new Date(Date.parse(`${martes}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    // Primero en la fila: quiere SOLO el miercoles. Segundo: quiere SOLO el martes.
    mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: "+529995550311", customerName: "Quiere miércoles", providerId: mundo.drPaola, serviceId: mundo.limpieza, preferredDateFrom: miercoles, preferredDateTo: miercoles, preferredTimeWindow: "any", createdAt: "2026-01-01T00:00:00.000Z" });
    mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: "+529995550312", customerName: "Quiere martes", providerId: mundo.drPaola, serviceId: mundo.limpieza, preferredDateFrom: martes, preferredDateTo: martes, preferredTimeWindow: "any", createdAt: "2026-01-02T00:00:00.000Z" });
    // Se libera el martes a las 19:00 hora de Merida (01:00Z del miercoles).
    const r = await runOptimizadorCore(mundo.repo, mundo.organizationId, ZONA, { providerId: mundo.drPaola, serviceId: mundo.limpieza, startsAt: zonedTimeToUtc(martes, "19:00", ZONA).toISOString() });
    // Hoy compara contra la fecha UTC (toISOString().slice(0,10)) y se lo ofrece a quien quiere el MIERCOLES.
    expect(r.customerPhone).toBe("+529995550312");
  });

  it.fails("QA-citas-R1-viaje-10: el aviso de hueco dice QUE horario se libero y el 'Si' del paciente tiene salida (el agente sabe que se le ofrecio)", async () => {
    const mundo = clinicaDental();
    const martes = proximoDia(2, 2);
    const inicio = zonedTimeToUtc(martes, "10:00", ZONA).toISOString();
    mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: TEL_ESPERA, customerName: "Mario Chan", providerId: mundo.drPaola, serviceId: mundo.limpieza, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any" });
    await runOptimizadorCore(mundo.repo, mundo.organizationId, ZONA, { providerId: mundo.drPaola, serviceId: mundo.limpieza, startsAt: inicio });
    const oferta = mundo.repo.getOutbox().find((o) => o.eventType === "waitlist.slot_offered")!;
    const cuerpo = (oferta.payload as { body: string }).body;

    // El paciente contesta "Si" como le pidio el mensaje.
    const wa = canalWhatsapp(mundo);
    await wa.escribe(TEL_ESPERA, "Sí", () => texto("¿En qué le puedo ayudar?"));
    const contexto = wa.requests[0]!.system + JSON.stringify(wa.requests[0]!.messages);
    // Lo minimo para que el desenlace funcione: el aviso nombra dia/hora (hoy: "Se liberó un espacio que coincide con lo que buscaba")
    // y el agente recibe en su contexto que horario se le ofrecio (hoy no: la oferta solo vive en el outbox, nunca en la conversacion).
    expect(cuerpo).toMatch(/10:00|10 de la ma/);
    expect(contexto).toMatch(/Limpieza|10:00|lista de espera/i);
  });

  it("control: tras el 'Si' (sin contexto) el paciente que espera sigue sin cita: nada se agenda solo", async () => {
    const mundo = clinicaDental();
    mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: TEL_ESPERA, customerName: "Mario Chan", providerId: mundo.drPaola, serviceId: mundo.limpieza, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any" });
    const martes = proximoDia(2, 2);
    const cita = await createAppointment(mundo.repo, { organizationId: mundo.organizationId, providerId: mundo.drPaola, serviceId: mundo.limpieza, customerName: "Ana Pech", customerPhone: TEL_PACIENTE, startsAt: zonedTimeToUtc(martes, "10:00", ZONA).toISOString(), source: "whatsapp" });
    const wa = canalWhatsapp(mundo);
    await wa.escribe(TEL_PACIENTE, "Cancelar", undefined, { kind: "button_reply", id: `cita:cancelar:${cita.id}`, title: "Cancelar" });
    await wa.escribe(TEL_ESPERA, "Sí", () => texto("¿En qué le puedo ayudar?"));
    expect((await findAppointmentsForCustomerPhone(mundo.repo, mundo.organizationId, TEL_ESPERA)).appointments).toHaveLength(0);
    void herramienta;
  });
});
