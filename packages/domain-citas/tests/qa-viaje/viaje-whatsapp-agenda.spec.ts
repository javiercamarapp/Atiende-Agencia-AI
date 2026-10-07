// QA citas R1 -- lente VIAJE COMPLETO. Un paciente nuevo recorre por WhatsApp el ciclo completo de su cita: saluda, agenda, pregunta por
// su cita, la reagenda, la cancela; despues otro paciente agenda, recibe el recordatorio de 24 h y confirma con el boton. Todo con el
// pipeline REAL del webhook (dedupe, lock, crisis, ARCO, botones, LLM guionado, outbox) sobre el motor real de agenda en memoria.
// Los `it.fails` documentan defectos reales (ids QA-citas-R1-viaje-NN): fallan en cuanto el defecto se corrija, avisando que hay que
// quitarles la marca.
import { describe, expect, it } from "vitest";
import { createAppointment, findAppointmentsForCustomerPhone } from "../../src/appointments.ts";
import { zonedTimeToUtc } from "../../src/availability.ts";
import { runConfirmacionCitaCore } from "../../src/reminders.ts";
import { TEL_ESPERA, TEL_PACIENTE, ZONA, canalWhatsapp, clinicaDental, herramienta, horaLocal, proximoDia, texto, ultimoResultado } from "./support.ts";
import type { MundoClinica, PasoGuion } from "./support.ts";

type Slot = { starts_at: string; ends_at: string } & Record<string, unknown>;

/** Turno de agenda: listar servicios -> listar proveedores -> consultar disponibilidad -> ofrecer. Devuelve los slots que vio el modelo. */
function guionConsultar(mundo: MundoClinica, fecha: string, vistos: { slots: Slot[] }): PasoGuion {
  return (req, paso) => {
    if (paso === 0) return herramienta("t1", "listar_servicios", {});
    if (paso === 1) return herramienta("t2", "listar_proveedores", { service_id: mundo.limpieza });
    if (paso === 2) return herramienta("t3", "consultar_disponibilidad", { provider_id: mundo.drPaola, service_id: mundo.limpieza, date: fecha });
    vistos.slots = (ultimoResultado(req).slots as Slot[]) ?? [];
    return texto("Ese día tengo varios horarios en la mañana. ¿Cuál le acomoda?");
  };
}

function slotLocal(slots: readonly Slot[], hhmm: string): Slot {
  const s = slots.find((x) => horaLocal(x.starts_at) === hhmm);
  if (!s) throw new Error(`no hay slot de las ${hhmm} hora local entre ${slots.length} ofrecidos`);
  return s;
}

describe("viaje WhatsApp: paciente nuevo agenda, consulta, reagenda y cancela", () => {
  it("el ciclo completo deja la cita y el historial consistentes, sin duplicados ni pasos manuales", async () => {
    const mundo = clinicaDental();
    const wa = canalWhatsapp(mundo);
    const martes = proximoDia(2, 2);
    const vistos = { slots: [] as Slot[] };

    // 1) Saluda y pide una limpieza: el agente consulta la agenda real.
    const r1 = await wa.escribe(TEL_PACIENTE, "Hola, quiero agendar una limpieza el martes en la mañana", guionConsultar(mundo, martes, vistos));
    expect(r1.ok).toBe(true);
    expect(vistos.slots.length).toBeGreaterThan(5);
    // primer horario del dia = 09:00 hora de Merida (la agenda real si convierte bien)
    expect(horaLocal(vistos.slots[0]!.starts_at)).toBe("09:00");

    // 2) Elige las 10:00 y da su nombre: el agente crea la cita.
    const diez = slotLocal(vistos.slots, "10:00");
    let creada: Record<string, unknown> = {};
    await wa.escribe(TEL_PACIENTE, "Sí, a las 10 por favor, a nombre de Ana Pech", (req, paso) => {
      if (paso === 0) return herramienta("c1", "crear_cita", { provider_id: mundo.drPaola, service_id: mundo.limpieza, customer_name: "Ana Pech", starts_at: diez.starts_at });
      creada = ultimoResultado(req);
      return texto("¡Listo! Su cita quedó agendada el martes a las 10:00.");
    });
    const cita = (creada.appointment ?? {}) as { appointment_id: string; status: string };
    expect(cita.status).toBe("pending");
    let mias = await findAppointmentsForCustomerPhone(mundo.repo, mundo.organizationId, TEL_PACIENTE);
    expect(mias.appointments).toHaveLength(1);
    expect(mias.appointments[0]!.startsAt).toBe(diez.starts_at);
    const enBase = await mundo.repo.findAppointmentForOrganization(mundo.organizationId, cita.appointment_id);
    expect(enBase?.source).toBe("whatsapp");

    // 3) Reagenda a las 11: misma cita (mismo id), nuevo horario.
    let reagendada: Record<string, unknown> = {};
    await wa.escribe(TEL_PACIENTE, "¿Me la puede mover a las 11 del mismo día?", (req, paso) => {
      if (paso === 0) return herramienta("r1", "buscar_mis_citas", {});
      if (paso === 1) return herramienta("r2", "consultar_disponibilidad", { provider_id: mundo.drPaola, service_id: mundo.limpieza, date: martes });
      if (paso === 2) {
        const slots = ultimoResultado(req).slots as Slot[];
        return herramienta("r3", "reagendar_cita", { appointment_id: cita.appointment_id, new_starts_at: slotLocal(slots, "11:00").starts_at });
      }
      reagendada = ultimoResultado(req);
      return texto("Listo, la moví a las 11:00.");
    });
    expect((reagendada.appointment as { appointment_id: string }).appointment_id).toBe(cita.appointment_id);
    mias = await findAppointmentsForCustomerPhone(mundo.repo, mundo.organizationId, TEL_PACIENTE);
    expect(mias.appointments).toHaveLength(1);
    expect(horaLocal(mias.appointments[0]!.startsAt)).toBe("11:00");

    // 4) Cancela.
    await wa.escribe(TEL_PACIENTE, "Mejor cancélela, ya no voy a ir el martes", (req, paso) => {
      if (paso === 0) return herramienta("x1", "buscar_mis_citas", {});
      if (paso === 1) return herramienta("x2", "cancelar_cita", { appointment_id: cita.appointment_id });
      return texto("Su cita quedó cancelada.");
    });
    const cancelada = await mundo.repo.findAppointmentForOrganization(mundo.organizationId, cita.appointment_id);
    expect(cancelada?.status).toBe("cancelled");
    expect((await findAppointmentsForCustomerPhone(mundo.repo, mundo.organizationId, TEL_PACIENTE)).appointments).toHaveLength(0);

    // Cada mensaje del cliente tuvo exactamente una respuesta encolada (nada se pierde, nada se duplica).
    const respuestas = mundo.repo.getOutbox().filter((o) => o.eventType === "whatsapp.inbound_reply");
    expect(respuestas).toHaveLength(4);
  });

  it("un reintento de Meta con el mismo wamid no reprocesa el turno ni crea una segunda cita", async () => {
    const mundo = clinicaDental();
    const wa = canalWhatsapp(mundo);
    const martes = proximoDia(2, 2);
    const inicio = zonedTimeToUtc(martes, "10:00", ZONA).toISOString();
    // Mismo messageId: se manda el MISMO cuerpo dos veces a traves del pipeline directo.
    const { handleInboundWhatsAppMessage, createDefaultConversationGuard } = await import("../../src/whatsapp/inbound.ts");
    const { createLlmWhatsAppTurnHandler } = await import("../../src/whatsapp/llm-turn-handler.ts");
    const { LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore, FakeLlmProvider } = await import("@atiende/agent-core");
    let llamadas = 0;
    const gw = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    let paso = 0;
    gw.registerLadder("d", [new FakeLlmProvider({ id: "f", script: () => { llamadas += 1; return paso++ % 2 === 0 ? herramienta("c", "crear_cita", { provider_id: mundo.drPaola, service_id: mundo.limpieza, customer_name: "Ana Pech", starts_at: inicio }) : texto("Listo"); } })]);
    const h = createLlmWhatsAppTurnHandler(mundo.repo, gw, { defaultRole: "d", escalatedRole: "d" });
    const guard = createDefaultConversationGuard({});
    const args = { organizationId: mundo.organizationId, messageId: "wamid.qa-duplicado", phone: TEL_PACIENTE, body: "agéndame a las 10", phoneNumberId: "100200300" };
    await handleInboundWhatsAppMessage(mundo.repo, h, guard, args);
    await handleInboundWhatsAppMessage(mundo.repo, h, guard, args);
    expect(llamadas).toBe(2); // un solo turno (crear + texto)
    expect((await findAppointmentsForCustomerPhone(mundo.repo, mundo.organizationId, TEL_PACIENTE)).appointments).toHaveLength(1);
    void wa;
  });

  it.fails("QA-citas-R1-viaje-01: consultar_disponibilidad le da al modelo la hora LOCAL del negocio (no solo el ISO en UTC)", async () => {
    const mundo = clinicaDental();
    const wa = canalWhatsapp(mundo);
    const vistos = { slots: [] as Slot[] };
    await wa.escribe(TEL_PACIENTE, "Quiero una limpieza el martes a las 10", guionConsultar(mundo, proximoDia(2, 2), vistos));
    const diez = slotLocal(vistos.slots, "10:00");
    // Hoy el slot de las 10:00 de Merida llega al modelo SOLO como "...T16:00:00.000Z": el modelo (eval real con gpt-6-luna: 16/48
    // conversaciones) ofrece "16:00" o dice "no tengo 10:00". Lo minimo: que el resultado traiga la hora local legible.
    expect(JSON.stringify(diez)).toMatch(/\b10:00\b(?!:00\.000Z)/);
    // y que el prompt le explique al modelo como leer esos ISO
    const prompt = wa.requests[0]!.system;
    expect(prompt).toMatch(/UTC|hora local/i);
  });

  it.fails("QA-citas-R1-viaje-02: el contexto del cliente recurrente en el prompt muestra su cita en hora local, no el ISO UTC", async () => {
    const mundo = clinicaDental();
    const martes = proximoDia(2, 2);
    await createAppointment(mundo.repo, { organizationId: mundo.organizationId, providerId: mundo.drPaola, serviceId: mundo.limpieza, customerName: "Ana Pech", customerPhone: TEL_PACIENTE, startsAt: zonedTimeToUtc(martes, "10:00", ZONA).toISOString(), source: "whatsapp" });
    const wa = canalWhatsapp(mundo);
    await wa.escribe(TEL_PACIENTE, "Hola, ¿a qué hora es mi cita?", () => texto("Su cita es el martes."));
    const prompt = wa.requests[0]!.system;
    // Hoy: "Tiene citas activas/próximas ya agendadas: Limpieza dental con Dra. Paola Medina el 20XX-XX-XXT16:00:00.000Z."
    expect(prompt).toContain("Limpieza dental con Dra. Paola Medina");
    expect(prompt).not.toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it("QA-citas-R1-viaje-03: cancelar la cita POR EL AGENTE avisa a la lista de espera del horario liberado (como ya lo hace el boton Cancelar)", async () => {
    const mundo = clinicaDental();
    const martes = proximoDia(2, 2);
    const cita = await createAppointment(mundo.repo, { organizationId: mundo.organizationId, providerId: mundo.drPaola, serviceId: mundo.limpieza, customerName: "Ana Pech", customerPhone: TEL_PACIENTE, startsAt: zonedTimeToUtc(martes, "10:00", ZONA).toISOString(), source: "whatsapp" });
    mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: TEL_ESPERA, customerName: "Mario Chan", providerId: mundo.drPaola, serviceId: mundo.limpieza, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any" });
    const wa = canalWhatsapp(mundo);
    await wa.escribe(TEL_PACIENTE, "Necesito cancelar mi cita del martes", (_req, paso) => {
      if (paso === 0) return herramienta("x1", "buscar_mis_citas", {});
      if (paso === 1) return herramienta("x2", "cancelar_cita", { appointment_id: cita.id });
      return texto("Listo, cancelada.");
    });
    expect((await mundo.repo.findAppointmentForOrganization(mundo.organizationId, cita.id))?.status).toBe("cancelled");
    expect(mundo.repo.getOutbox().filter((o) => o.eventType === "waitlist.slot_offered")).toHaveLength(1);
  });

  it("control: el boton Cancelar del recordatorio SI avisa a la lista de espera (el comportamiento que el agente no replica)", async () => {
    const mundo = clinicaDental();
    const martes = proximoDia(2, 2);
    const cita = await createAppointment(mundo.repo, { organizationId: mundo.organizationId, providerId: mundo.drPaola, serviceId: mundo.limpieza, customerName: "Ana Pech", customerPhone: TEL_PACIENTE, startsAt: zonedTimeToUtc(martes, "10:00", ZONA).toISOString(), source: "whatsapp" });
    mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: TEL_ESPERA, customerName: "Mario Chan", providerId: mundo.drPaola, serviceId: mundo.limpieza, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any" });
    const wa = canalWhatsapp(mundo);
    const r = await wa.escribe(TEL_PACIENTE, "Cancelar", undefined, { kind: "button_reply", id: `cita:cancelar:${cita.id}`, title: "Cancelar" });
    expect(r.reply).toMatch(/quedó cancelada/);
    expect(wa.llamadasLlm).toBe(0);
    expect(mundo.repo.getOutbox().filter((o) => o.eventType === "waitlist.slot_offered")).toHaveLength(1);
  });

  it("QA-citas-R1-viaje-04: reagendar POR EL AGENTE avisa a la lista de espera del horario viejo liberado", async () => {
    const mundo = clinicaDental();
    const martes = proximoDia(2, 2);
    const cita = await createAppointment(mundo.repo, { organizationId: mundo.organizationId, providerId: mundo.drPaola, serviceId: mundo.limpieza, customerName: "Ana Pech", customerPhone: TEL_PACIENTE, startsAt: zonedTimeToUtc(martes, "10:00", ZONA).toISOString(), source: "whatsapp" });
    mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: TEL_ESPERA, customerName: "Mario Chan", providerId: mundo.drPaola, serviceId: mundo.limpieza, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any" });
    const wa = canalWhatsapp(mundo);
    await wa.escribe(TEL_PACIENTE, "Muévame la cita a las 12", (_req, paso) => {
      if (paso === 0) return herramienta("r1", "buscar_mis_citas", {});
      if (paso === 1) return herramienta("r2", "reagendar_cita", { appointment_id: cita.id, new_starts_at: zonedTimeToUtc(martes, "12:00", ZONA).toISOString() });
      return texto("Listo.");
    });
    expect(horaLocal((await mundo.repo.findAppointmentForOrganization(mundo.organizationId, cita.id))!.startsAt)).toBe("12:00");
    expect(mundo.repo.getOutbox().filter((o) => o.eventType === "waitlist.slot_offered")).toHaveLength(1);
  });

  it("QA-citas-R1-viaje-05: el agente NO puede agendar ni reagendar en un horario que ya paso (crear_cita/reagendar_cita no validan 'ya paso')", async () => {
    const mundo = clinicaDental({ hastaLas: "20:00" });
    // Un dia habil PASADO (la semana anterior) dentro del horario: la agenda real nunca lo ofreceria, pero crear_cita lo acepta.
    const hoy = new Date();
    const pasado = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() - 7));
    while (pasado.getUTCDay() === 0 || pasado.getUTCDay() === 6) pasado.setUTCDate(pasado.getUTCDate() - 1);
    const inicioPasado = zonedTimeToUtc(pasado.toISOString().slice(0, 10), "10:00", ZONA).toISOString();
    const wa = canalWhatsapp(mundo);
    let r: Record<string, unknown> = {};
    await wa.escribe(TEL_PACIENTE, "Agéndeme el lunes pasado a las 10", (req, paso) => {
      if (paso === 0) return herramienta("c1", "crear_cita", { provider_id: mundo.drPaola, service_id: mundo.limpieza, customer_name: "Ana Pech", starts_at: inicioPasado });
      r = ultimoResultado(req);
      return texto("...");
    });
    expect(r.error).toBeDefined();
    expect((await findAppointmentsForCustomerPhone(mundo.repo, mundo.organizationId, TEL_PACIENTE, new Date(0))).appointments).toHaveLength(0);
  });

  it("QA-citas-R1-viaje-06: 'ya tienen mis datos, quiero cancelar mi cita' cancela la CITA, no abre una solicitud ARCO de borrado de datos", async () => {
    const mundo = clinicaDental();
    const martes = proximoDia(2, 2);
    const cita = await createAppointment(mundo.repo, { organizationId: mundo.organizationId, providerId: mundo.drPaola, serviceId: mundo.limpieza, customerName: "Ana Pech", customerPhone: TEL_PACIENTE, startsAt: zonedTimeToUtc(martes, "10:00", ZONA).toISOString(), source: "whatsapp" });
    const wa = canalWhatsapp(mundo);
    const r = await wa.escribe(TEL_PACIENTE, "Hola, ya tienen mis datos de la vez pasada. Quiero cancelar mi cita del martes", (_req, paso) => {
      if (paso === 0) return herramienta("x1", "buscar_mis_citas", {});
      if (paso === 1) return herramienta("x2", "cancelar_cita", { appointment_id: cita.id });
      return texto("Listo, su cita quedó cancelada.");
    });
    // Hoy el fast-path ARCO gana: registra una solicitud de CANCELACION DE DATOS pendiente de "CONFIRMO" y el agente ni corre.
    expect(wa.llamadasLlm).toBeGreaterThan(0);
    expect(r.reply).not.toMatch(/CONFIRMO/);
  });
});

describe("viaje WhatsApp: recordatorio de 24 h -> confirmar con boton -> el panel lo ve confirmado", () => {
  it("el recordatorio sale con la hora LOCAL, con los 3 botones, y el toque en Confirmar confirma sin LLM", async () => {
    const mundo = clinicaDental();
    const dia = proximoDia(3, 8); // un miercoles a mas de una semana: la reserva no es "muy reciente" para el cron
    const inicio = zonedTimeToUtc(dia, "10:00", ZONA);
    const cita = await createAppointment(mundo.repo, { organizationId: mundo.organizationId, providerId: mundo.drPaola, serviceId: mundo.limpieza, customerName: "Ana Pech", customerPhone: TEL_PACIENTE, startsAt: inicio.toISOString(), source: "whatsapp" });
    const resumen = await runConfirmacionCitaCore(mundo.repo, mundo.organizationId, new Date(inicio.getTime() - 24 * 3_600_000));
    expect(resumen.sent).toBe(1);
    const recordatorio = mundo.repo.getOutbox().find((o) => o.eventType === "appointment.reminder_24h")!;
    const payload = recordatorio.payload as { body: string; buttons: { id: string; title: string }[] };
    expect(payload.body).toMatch(/10:00/);
    expect(payload.buttons.map((b) => b.title)).toEqual(["Confirmar", "Cancelar", "Reagendar"]);
    // segunda corrida del cron en la misma ventana: no duplica
    await runConfirmacionCitaCore(mundo.repo, mundo.organizationId, new Date(inicio.getTime() - 24 * 3_600_000 + 10 * 60_000));
    expect(mundo.repo.getOutbox().filter((o) => o.eventType === "appointment.reminder_24h")).toHaveLength(1);

    const wa = canalWhatsapp(mundo);
    const r = await wa.escribe(TEL_PACIENTE, "Confirmar", undefined, { kind: "button_reply", id: payload.buttons[0]!.id, title: "Confirmar" });
    expect(r.reply).toMatch(/quedó confirmada/);
    expect(r.reply).toMatch(/10:00/);
    expect(wa.llamadasLlm).toBe(0);
    expect((await mundo.repo.findAppointmentForOrganization(mundo.organizationId, cita.id))?.status).toBe("confirmed");
  });
});
