// QA citas R1 -- lente VIAJE COMPLETO: el DESENLACE de privacidad de un paciente. Pide por WhatsApp que borren sus datos (ARCO,
// cancelacion), confirma con CONFIRMO, la clinica la atiende en el panel y la marca resuelta. Datos de salud: lo que importa es que
// "resuelta" signifique que los datos ya no estan, sin un paso manual oculto.
import { describe, expect, it } from "vitest";
import { createAppointment } from "../../src/appointments.ts";
import { zonedTimeToUtc } from "../../src/availability.ts";
import { lookupCitasCustomer } from "../../src/customers.ts";
import { TEL_PACIENTE, ZONA, canalWhatsapp, clinicaDental, proximoDia, texto } from "./support.ts";

async function pacienteConHistorial() {
  const mundo = clinicaDental({ rubro: "psicologo" });
  await createAppointment(mundo.repo, {
    organizationId: mundo.organizationId,
    providerId: mundo.drPaola,
    serviceId: mundo.limpieza,
    customerName: "Ana Pech",
    customerPhone: TEL_PACIENTE,
    startsAt: zonedTimeToUtc(proximoDia(2, 2), "10:00", ZONA).toISOString(),
    notes: "Motivo de consulta: ansiedad",
    source: "whatsapp",
  });
  const wa = canalWhatsapp(mundo);
  await wa.escribe(TEL_PACIENTE, "Hola, tengo cita con la doctora", () => texto("Sí, la veo agendada."));
  return { mundo, wa };
}

describe("viaje ARCO: el paciente pide borrar sus datos", () => {
  it("la solicitud entra por WhatsApp sin LLM, se confirma con CONFIRMO y el panel la ve con plazos", async () => {
    const { mundo, wa } = await pacienteConHistorial();
    const antes = wa.llamadasLlm;
    const r1 = await wa.escribe(TEL_PACIENTE, "Quiero que borren mis datos personales", () => texto("NO DEBERIA LLAMARSE"));
    expect(r1.reply).toMatch(/CONFIRMO/);
    const r2 = await wa.escribe(TEL_PACIENTE, "CONFIRMO", () => texto("NO DEBERIA LLAMARSE"));
    expect(r2.ok).toBe(true);
    expect(wa.llamadasLlm).toBe(antes);
    const panel = await mundo.repo.listDataRightsRequests(mundo.organizationId, {}, {});
    expect(panel.items).toHaveLength(1);
    expect(panel.items[0]!.rightType).toBe("cancelacion");
    expect(panel.items[0]!.status).toBe("recibida");
    const res = await mundo.repo.updateDataRightsRequestStatus(mundo.organizationId, panel.items[0]!.id, "resuelta", "Datos eliminados");
    expect(res.outcome).toBe("updated");
  });

  it.fails("QA-citas-R1-viaje-18: marcar 'resuelta' una cancelacion ARCO no borra ni anonimiza nada (no hay ninguna herramienta para ejecutarla): el paciente sigue identificado con su nota de salud", async () => {
    const { mundo, wa } = await pacienteConHistorial();
    await wa.escribe(TEL_PACIENTE, "Quiero que borren mis datos personales", () => texto("x"));
    await wa.escribe(TEL_PACIENTE, "CONFIRMO", () => texto("x"));
    const solicitud = (await mundo.repo.listDataRightsRequests(mundo.organizationId, {}, {})).items[0]!;
    await mundo.repo.updateDataRightsRequestStatus(mundo.organizationId, solicitud.id, "resuelta", "Datos eliminados");
    // Tras "resuelta" el paciente debe quedar anonimizado (o la resolucion debe exigir ejecutar el borrado). Hoy sigue todo igual.
    const cliente = await lookupCitasCustomer(mundo.repo, mundo.organizationId, TEL_PACIENTE);
    expect(cliente.fullName).not.toBe("Ana Pech");
  });
});
