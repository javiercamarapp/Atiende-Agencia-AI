// Plantillas concretas de correo transaccional de citas, construidas sobre el
// marco de layout.ts. Port de
// citas-reservaciones/supabase/functions/_shared/emails/plantillas-citas.ts. Un
// objeto {asunto, html, texto} por evento real del ciclo de vida de una cita (ver
// ../appointment-email-notifications.ts, que es quien las invoca).
//
// Todo dato dinámico (nombre del cliente, del proveedor, del servicio, del
// negocio) pasa por escapeHtml antes de entrar al HTML — el nombre del cliente en
// particular llega tal cual lo transcribió el agente de voz o lo escribió alguien
// en WhatsApp/el panel, nunca es un dato de confianza.
import { escapeHtml, renderCorreo } from "./layout.ts";

export interface CitaCorreo {
  readonly clienteNombre: string;
  readonly tenantNombre: string;
  readonly servicioNombre: string;
  readonly proveedorNombre: string;
  readonly fechaHoraTexto: string; // ya formateada en el timezone real del negocio
}

export interface Correo {
  readonly asunto: string;
  readonly html: string;
  readonly texto: string;
}

const filasCita = (c: CitaCorreo) => ({
  filas: [
    { etiqueta: "Servicio", valor: c.servicioNombre },
    { etiqueta: "Con", valor: c.proveedorNombre },
    { etiqueta: "Fecha y hora", valor: c.fechaHoraTexto },
  ],
});

const PIE_ESTANDAR = (tenantNombre: string) => `Recibes este correo porque agendaste una cita en ${tenantNombre} a través de atiende.`;

export function correoCitaCreada(c: CitaCorreo): Correo {
  const nombre = escapeHtml(c.clienteNombre);
  const tenant = escapeHtml(c.tenantNombre);
  const html = renderCorreo({
    titulo: "Tu cita quedó agendada",
    preheader: `${c.servicioNombre} en ${c.tenantNombre} — ${c.fechaHoraTexto}`,
    etiqueta: { texto: "Cita agendada", color: "#1D4ED8" },
    parrafosHtml: [`Hola ${nombre}, tu cita en <strong>${tenant}</strong> quedó agendada. Aquí el detalle:`],
    tabla: filasCita(c),
    nota: "Si necesitas cambiar o cancelar tu cita, contáctanos por el mismo medio por el que la agendaste.",
    piePorQueLlego: PIE_ESTANDAR(c.tenantNombre),
  });
  return {
    asunto: `Cita agendada · ${c.tenantNombre} · ${c.fechaHoraTexto}`,
    html,
    texto: `Hola ${c.clienteNombre}, tu cita en ${c.tenantNombre} quedó agendada.\nServicio: ${c.servicioNombre}\nCon: ${c.proveedorNombre}\nFecha y hora: ${c.fechaHoraTexto}`,
  };
}

export function correoCitaRecordatorio(c: CitaCorreo): Correo {
  const nombre = escapeHtml(c.clienteNombre);
  const tenant = escapeHtml(c.tenantNombre);
  const html = renderCorreo({
    titulo: "Recordatorio de tu cita",
    preheader: `Tu cita en ${c.tenantNombre} es mañana — ${c.fechaHoraTexto}`,
    etiqueta: { texto: "Recordatorio", color: "#b45309" },
    parrafosHtml: [`Hola ${nombre}, te recordamos que tienes una cita mañana en <strong>${tenant}</strong>.`],
    tabla: filasCita(c),
    nota: "Si necesitas confirmar, cancelar o reagendar, contáctanos por el mismo medio por el que agendaste.",
    piePorQueLlego: PIE_ESTANDAR(c.tenantNombre),
  });
  return {
    asunto: `Recordatorio · ${c.tenantNombre} · mañana ${c.fechaHoraTexto}`,
    html,
    texto: `Hola ${c.clienteNombre}, te recordamos tu cita mañana en ${c.tenantNombre}.\nServicio: ${c.servicioNombre}\nCon: ${c.proveedorNombre}\nFecha y hora: ${c.fechaHoraTexto}`,
  };
}

export function correoCitaCancelada(c: CitaCorreo): Correo {
  const nombre = escapeHtml(c.clienteNombre);
  const tenant = escapeHtml(c.tenantNombre);
  const html = renderCorreo({
    titulo: "Tu cita fue cancelada",
    preheader: `Se canceló tu cita en ${c.tenantNombre} — ${c.fechaHoraTexto}`,
    etiqueta: { texto: "Cancelada", color: "#dc2626" },
    parrafosHtml: [`Hola ${nombre}, tu cita en <strong>${tenant}</strong> que tenías programada para ${escapeHtml(c.fechaHoraTexto)} fue cancelada.`],
    tabla: filasCita(c),
    nota: "Si no reconoces esta cancelación o quieres agendar de nuevo, contáctanos.",
    piePorQueLlego: PIE_ESTANDAR(c.tenantNombre),
  });
  return {
    asunto: `Cita cancelada · ${c.tenantNombre} · ${c.fechaHoraTexto}`,
    html,
    texto: `Hola ${c.clienteNombre}, tu cita en ${c.tenantNombre} programada para ${c.fechaHoraTexto} fue cancelada.`,
  };
}

export interface CitaReagendadaCorreo extends CitaCorreo {
  readonly fechaHoraAnteriorTexto: string;
}

export function correoCitaReagendada(c: CitaReagendadaCorreo): Correo {
  const nombre = escapeHtml(c.clienteNombre);
  const tenant = escapeHtml(c.tenantNombre);
  const html = renderCorreo({
    titulo: "Tu cita fue reagendada",
    preheader: `Tu cita en ${c.tenantNombre} cambió a ${c.fechaHoraTexto}`,
    etiqueta: { texto: "Reagendada", color: "#0ea5e9" },
    parrafosHtml: [`Hola ${nombre}, tu cita en <strong>${tenant}</strong> se movió de <strong>${escapeHtml(c.fechaHoraAnteriorTexto)}</strong> a la nueva fecha y hora de abajo.`],
    tabla: filasCita(c),
    nota: "Si este cambio no fue solicitado por ti, contáctanos de inmediato.",
    piePorQueLlego: PIE_ESTANDAR(c.tenantNombre),
  });
  return {
    asunto: `Cita reagendada · ${c.tenantNombre} · ahora ${c.fechaHoraTexto}`,
    html,
    texto: `Hola ${c.clienteNombre}, tu cita en ${c.tenantNombre} se movió de ${c.fechaHoraAnteriorTexto} a ${c.fechaHoraTexto}.\nServicio: ${c.servicioNombre}\nCon: ${c.proveedorNombre}`,
  };
}

// ============================================================================
// Fase 11 — plantillas para las 3 transiciones de estado del panel de staff
// (confirmar/completar/no-show, Fase 7): el gap real que cierra esta fase es
// que appointment-email-notifications.ts nunca tuvo plantilla para estos 3
// eventos (Fase 6 §3 solo cubría created/reminder_24h/cancelled/rescheduled/
// modified) — el origen (AgendaSection.tsx) tampoco las tenía, así que no hay
// texto que portar; mismo tono, mismo marco (renderCorreo) y misma tabla de
// detalle que las demás plantillas de este archivo.
// ============================================================================

export function correoCitaConfirmada(c: CitaCorreo): Correo {
  const nombre = escapeHtml(c.clienteNombre);
  const tenant = escapeHtml(c.tenantNombre);
  const html = renderCorreo({
    titulo: "Tu cita fue confirmada",
    preheader: `${c.tenantNombre} confirmó tu cita — ${c.fechaHoraTexto}`,
    etiqueta: { texto: "Confirmada", color: "#15803d" },
    parrafosHtml: [`Hola ${nombre}, <strong>${tenant}</strong> confirmó tu cita. Aquí el detalle:`],
    tabla: filasCita(c),
    nota: "Si necesitas cambiar o cancelar tu cita, contáctanos por el mismo medio por el que la agendaste.",
    piePorQueLlego: PIE_ESTANDAR(c.tenantNombre),
  });
  return {
    asunto: `Cita confirmada · ${c.tenantNombre} · ${c.fechaHoraTexto}`,
    html,
    texto: `Hola ${c.clienteNombre}, ${c.tenantNombre} confirmó tu cita.\nServicio: ${c.servicioNombre}\nCon: ${c.proveedorNombre}\nFecha y hora: ${c.fechaHoraTexto}`,
  };
}

export function correoCitaCompletada(c: CitaCorreo): Correo {
  const nombre = escapeHtml(c.clienteNombre);
  const tenant = escapeHtml(c.tenantNombre);
  const html = renderCorreo({
    titulo: "Gracias por tu visita",
    preheader: `Tu cita en ${c.tenantNombre} quedó completada — ${c.fechaHoraTexto}`,
    etiqueta: { texto: "Completada", color: "#1D4ED8" },
    parrafosHtml: [`Hola ${nombre}, gracias por tu visita a <strong>${tenant}</strong>. Tu cita quedó registrada como completada:`],
    tabla: filasCita(c),
    nota: "Si necesitas agendar tu próxima cita, contáctanos por el mismo medio por el que agendaste esta.",
    piePorQueLlego: PIE_ESTANDAR(c.tenantNombre),
  });
  return {
    asunto: `Gracias por tu visita · ${c.tenantNombre} · ${c.fechaHoraTexto}`,
    html,
    texto: `Hola ${c.clienteNombre}, gracias por tu visita a ${c.tenantNombre}. Tu cita quedó completada.\nServicio: ${c.servicioNombre}\nCon: ${c.proveedorNombre}\nFecha y hora: ${c.fechaHoraTexto}`,
  };
}

export function correoCitaNoShow(c: CitaCorreo): Correo {
  const nombre = escapeHtml(c.clienteNombre);
  const tenant = escapeHtml(c.tenantNombre);
  const html = renderCorreo({
    titulo: "No te vimos en tu cita",
    preheader: `Marcamos tu cita en ${c.tenantNombre} como no asistida — ${c.fechaHoraTexto}`,
    etiqueta: { texto: "No asistió", color: "#dc2626" },
    parrafosHtml: [`Hola ${nombre}, no logramos verte en <strong>${tenant}</strong> a la hora de tu cita, así que la marcamos como no asistida:`],
    tabla: filasCita(c),
    nota: "Si fue un error o quieres agendar de nuevo, contáctanos por el mismo medio por el que agendaste.",
    piePorQueLlego: PIE_ESTANDAR(c.tenantNombre),
  });
  return {
    asunto: `No asististe a tu cita · ${c.tenantNombre} · ${c.fechaHoraTexto}`,
    html,
    texto: `Hola ${c.clienteNombre}, no te vimos en ${c.tenantNombre} a la hora de tu cita, así que la marcamos como no asistida.\nServicio: ${c.servicioNombre}\nCon: ${c.proveedorNombre}\nFecha y hora: ${c.fechaHoraTexto}`,
  };
}

export function correoCitaModificada(c: CitaCorreo): Correo {
  const nombre = escapeHtml(c.clienteNombre);
  const tenant = escapeHtml(c.tenantNombre);
  const html = renderCorreo({
    titulo: "Tu cita fue actualizada",
    preheader: `Cambió el servicio o el proveedor de tu cita en ${c.tenantNombre}`,
    etiqueta: { texto: "Actualizada", color: "#7c3aed" },
    parrafosHtml: [`Hola ${nombre}, se actualizó tu cita en <strong>${tenant}</strong>. Tu horario se mantiene igual; el detalle actualizado es:`],
    tabla: filasCita(c),
    nota: "Si este cambio no fue solicitado por ti, contáctanos de inmediato.",
    piePorQueLlego: PIE_ESTANDAR(c.tenantNombre),
  });
  return {
    asunto: `Cita actualizada · ${c.tenantNombre} · ${c.fechaHoraTexto}`,
    html,
    texto: `Hola ${c.clienteNombre}, se actualizó tu cita en ${c.tenantNombre}.\nServicio: ${c.servicioNombre}\nCon: ${c.proveedorNombre}\nFecha y hora: ${c.fechaHoraTexto}`,
  };
}
