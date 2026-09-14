// Plantillas concretas de correo transaccional de rentas, construidas sobre el marco
// de layout.ts (DUPLICADO deliberado de domain-citas::emails/layout.ts). Un objeto
// {asunto, html, texto} por evento real del ciclo de vida de una reserva directa (ver
// ../reserva-email-notifications.ts, que es quien las invoca).
//
// Deliberadamente DISTINTO de src/mensajeria/plantillas.ts (H-056): estas son las DOS
// plantillas deterministas/sin IA de correo transaccional al huésped que el gap de
// auditoría pidió cerrar (confirmación + recordatorio de check-in) — nunca pasan por
// la cola de aprobación humana de colaAprobacion.ts (esa cola es solo para el
// borrador de mensajería de canal, generado por motor de plantillas o por IA, ver
// mensajeria/README). Un correo transaccional (confirmación de que la reserva quedó
// creada, o recordatorio de una fecha ya acordada) no es contenido generado que un
// humano deba aprobar antes de salir — mismo criterio que domain-citas::
// appointment-email-notifications.ts frente a cualquier mensaje de WhatsApp con IA.
//
// Todo dato dinámico (nombre del huésped, de la unidad, del tenant) pasa por
// escapeHtml antes de entrar al HTML — el nombre del huésped en particular llega tal
// cual lo tecleó alguien en el panel de staff, nunca es un dato de confianza.
import { escapeHtml, renderCorreo } from "./layout.ts";

export interface ReservaCorreoDatos {
  readonly huespedNombre: string;
  readonly tenantNombre: string;
  readonly unidadNombre: string;
  readonly checkInTexto: string; // ya formateado (fecha de calendario, ver reserva-email-notifications.ts)
  readonly checkOutTexto: string;
}

export interface Correo {
  readonly asunto: string;
  readonly html: string;
  readonly texto: string;
}

const filasReserva = (r: ReservaCorreoDatos) => ({
  filas: [
    { etiqueta: "Alojamiento", valor: r.unidadNombre },
    { etiqueta: "Check-in", valor: r.checkInTexto },
    { etiqueta: "Check-out", valor: r.checkOutTexto },
  ],
});

const PIE_ESTANDAR = (tenantNombre: string) => `Recibes este correo porque hiciste una reserva en ${tenantNombre} a través de atiende.`;

export function correoReservaConfirmada(r: ReservaCorreoDatos): Correo {
  const nombre = escapeHtml(r.huespedNombre);
  const tenant = escapeHtml(r.tenantNombre);
  const html = renderCorreo({
    titulo: "Tu reserva quedó confirmada",
    preheader: `${r.unidadNombre} en ${r.tenantNombre} — check-in ${r.checkInTexto}`,
    etiqueta: { texto: "Reserva confirmada", color: "#1D4ED8" },
    parrafosHtml: [`Hola ${nombre}, tu reserva en <strong>${tenant}</strong> quedó confirmada. Aquí el detalle:`],
    tabla: filasReserva(r),
    nota: "Si necesitas cambiar o cancelar tu reserva, contáctanos por el mismo medio por el que la hiciste.",
    piePorQueLlego: PIE_ESTANDAR(r.tenantNombre),
  });
  return {
    asunto: `Reserva confirmada · ${r.tenantNombre} · ${r.checkInTexto}`,
    html,
    texto: `Hola ${r.huespedNombre}, tu reserva en ${r.tenantNombre} quedó confirmada.\nAlojamiento: ${r.unidadNombre}\nCheck-in: ${r.checkInTexto}\nCheck-out: ${r.checkOutTexto}`,
  };
}

export function correoReservaRecordatorioCheckIn(r: ReservaCorreoDatos): Correo {
  const nombre = escapeHtml(r.huespedNombre);
  const tenant = escapeHtml(r.tenantNombre);
  const html = renderCorreo({
    titulo: "Se acerca tu check-in",
    preheader: `Tu check-in en ${r.tenantNombre} es pronto — ${r.checkInTexto}`,
    etiqueta: { texto: "Recordatorio", color: "#b45309" },
    parrafosHtml: [`Hola ${nombre}, te recordamos que tu check-in en <strong>${tenant}</strong> se acerca.`],
    tabla: filasReserva(r),
    nota: "Si necesitas confirmar tu hora de llegada, cambiar o cancelar tu reserva, contáctanos por el mismo medio por el que la hiciste.",
    piePorQueLlego: PIE_ESTANDAR(r.tenantNombre),
  });
  return {
    asunto: `Recordatorio de check-in · ${r.tenantNombre} · ${r.checkInTexto}`,
    html,
    texto: `Hola ${r.huespedNombre}, te recordamos tu check-in en ${r.tenantNombre}.\nAlojamiento: ${r.unidadNombre}\nCheck-in: ${r.checkInTexto}\nCheck-out: ${r.checkOutTexto}`,
  };
}
