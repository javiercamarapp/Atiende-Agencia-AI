// Regresiones QA R1 (citas): el agente (WhatsApp y voz) ofrece la lista de espera al cancelar/reagendar y el aviso de hueco llega con contexto.
// Ids: QA-citas-R1-viaje-03, viaje-04, viaje-09, viaje-10. Usa el arnes de viajes (LLM guionado, repositorio en memoria).
import { describe, expect, it } from "vitest";
import { createAppointment } from "../../src/appointments.ts";
import { zonedTimeToUtc } from "../../src/availability.ts";
import { runOptimizadorCore } from "../../src/reminders.ts";
import { ejecutarToolVozCitas } from "../../src/voz/tools-servidor.ts";
import { TEL_ESPERA, TEL_PACIENTE, ZONA, canalWhatsapp, clinicaDental, herramienta, proximoDia, texto } from "./support.ts";

async function citaDeAna(mundo: ReturnType<typeof clinicaDental>, hora = "10:00") {
  const martes = proximoDia(2, 2);
  const cita = await createAppointment(mundo.repo, { organizationId: mundo.organizationId, providerId: mundo.drPaola, serviceId: mundo.limpieza, customerName: "Ana Pech", customerPhone: TEL_PACIENTE, startsAt: zonedTimeToUtc(martes, hora, ZONA).toISOString(), source: "whatsapp" });
  mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: TEL_ESPERA, customerName: "Mario Chan", providerId: mundo.drPaola, serviceId: mundo.limpieza, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any" });
  return { cita, martes };
}

describe("QA R1 citas -- el agente avisa a la lista de espera", () => {
  it("QA-citas-R1-viaje-03: cancelar POR EL AGENTE de WhatsApp ofrece el horario liberado al primero de la lista de espera", async () => {
    const mundo = clinicaDental();
    const { cita } = await citaDeAna(mundo);
    const wa = canalWhatsapp(mundo);
    await wa.escribe(TEL_PACIENTE, "Necesito cancelar mi cita del martes", (_req, paso) => {
      if (paso === 0) return herramienta("x1", "buscar_mis_citas", {});
      if (paso === 1) return herramienta("x2", "cancelar_cita", { appointment_id: cita.id });
      return texto("Listo, cancelada.");
    });
    expect((await mundo.repo.findAppointmentForOrganization(mundo.organizationId, cita.id))?.status).toBe("cancelled");
    const ofertas = mundo.repo.getOutbox().filter((o) => o.eventType === "waitlist.slot_offered");
    expect(ofertas).toHaveLength(1);
    expect((ofertas[0]!.payload as { to: string }).to).toBe(TEL_ESPERA);
  });

  it("QA-citas-R1-viaje-03b: cancelar POR VOZ tambien avisa a la lista de espera", async () => {
    const mundo = clinicaDental();
    const { cita } = await citaDeAna(mundo);
    const r = await ejecutarToolVozCitas({ repo: mundo.repo, organizationId: mundo.organizationId, telefono: TEL_PACIENTE }, "cancelar_cita", { appointment_id: cita.id });
    expect(JSON.stringify(r.resultado)).not.toContain("error");
    expect(mundo.repo.getOutbox().filter((o) => o.eventType === "waitlist.slot_offered")).toHaveLength(1);
  });

  it("QA-citas-R1-viaje-04: reagendar POR EL AGENTE ofrece el horario VIEJO a la lista de espera", async () => {
    const mundo = clinicaDental();
    const { cita, martes } = await citaDeAna(mundo);
    const wa = canalWhatsapp(mundo);
    const nuevo = zonedTimeToUtc(martes, "12:00", ZONA).toISOString();
    await wa.escribe(TEL_PACIENTE, "Mejor muevela a las 12", (_req, paso) => {
      if (paso === 0) return herramienta("x1", "buscar_mis_citas", {});
      if (paso === 1) return herramienta("x2", "reagendar_cita", { appointment_id: cita.id, new_starts_at: nuevo });
      return texto("Listo, movida.");
    });
    const ofertas = mundo.repo.getOutbox().filter((o) => o.eventType === "waitlist.slot_offered");
    expect(ofertas).toHaveLength(1);
    expect(JSON.stringify(ofertas[0]!.payload)).toMatch(/10:00/);
  });
});

describe("QA R1 citas -- el aviso del hueco liberado", () => {
  it("QA-citas-R1-viaje-10: el aviso nombra servicio, dia y hora, y el agente recibe la oferta en la conversacion", async () => {
    const mundo = clinicaDental();
    const martes = proximoDia(2, 2);
    const inicio = zonedTimeToUtc(martes, "10:00", ZONA).toISOString();
    mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: TEL_ESPERA, customerName: "Mario Chan", providerId: mundo.drPaola, serviceId: mundo.limpieza, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any" });
    await runOptimizadorCore(mundo.repo, mundo.organizationId, ZONA, { providerId: mundo.drPaola, serviceId: mundo.limpieza, startsAt: inicio });
    const cuerpo = (mundo.repo.getOutbox().find((o) => o.eventType === "waitlist.slot_offered")!.payload as { body: string }).body;
    expect(cuerpo).toMatch(/Limpieza dental/);
    expect(cuerpo).toMatch(/10:00/);

    const wa = canalWhatsapp(mundo);
    await wa.escribe(TEL_ESPERA, "Sí", () => texto("¿En qué le puedo ayudar?"));
    const contexto = JSON.stringify(wa.requests[0]!.messages);
    expect(contexto).toContain("Oferta de lista de espera");
    expect(contexto).toContain(inicio);
    expect(contexto).toContain(mundo.limpieza);
  });

  it("QA-citas-R1-viaje-09: un hueco de la tarde (19:00 en Merida = dia siguiente en UTC) se ofrece a quien pidio ESE dia", async () => {
    const mundo = clinicaDental({ hastaLas: "20:00" });
    const martes = proximoDia(2, 2);
    const miercoles = new Date(Date.parse(`${martes}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: "+529995550311", customerName: "Quiere miércoles", providerId: mundo.drPaola, serviceId: mundo.limpieza, preferredDateFrom: miercoles, preferredDateTo: miercoles, preferredTimeWindow: "any", createdAt: "2026-01-01T00:00:00.000Z" });
    mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: "+529995550312", customerName: "Quiere martes", providerId: mundo.drPaola, serviceId: mundo.limpieza, preferredDateFrom: martes, preferredDateTo: martes, preferredTimeWindow: "any", createdAt: "2026-01-02T00:00:00.000Z" });
    const r = await runOptimizadorCore(mundo.repo, mundo.organizationId, ZONA, { providerId: mundo.drPaola, serviceId: mundo.limpieza, startsAt: zonedTimeToUtc(martes, "19:00", ZONA).toISOString() });
    expect(r.customerPhone).toBe("+529995550312");
  });
});
