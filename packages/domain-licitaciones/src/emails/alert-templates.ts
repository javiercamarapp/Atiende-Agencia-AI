// Plantillas concretas de correo de alerta de licitaciones, construidas
// sobre el marco de layout.ts (DUPLICADO deliberado de
// domain-rentas/domain-citas::emails/layout.ts). Un objeto {asunto, html,
// texto} por CADA UNO de los 3 tipos de alerta que hasta la Fase 10 eran
// solo registros consultables manualmente (ver ../alert-notifications.ts,
// que es quien las invoca): recordatorio de plazo de convocatoria,
// alerta de renovación de contrato, y factura vencida (cobranza).
//
// Deterministas, sin IA — mismo criterio que
// domain-rentas::emails/reserva-templates.ts frente a src/mensajeria/*: una
// alerta operativa (plazo/renovación/cobranza) no es contenido generado que
// un humano deba aprobar antes de salir.
//
// Todo dato dinámico que puede venir de texto libre tecleado por un humano
// (título de convocatoria dentro de `TenderDeadlineReminderRecord.message`,
// `concepto` de una factura) pasa por escapeHtml antes de entrar al HTML.
import { escapeHtml, renderCorreo } from "./layout.ts";

export interface Correo {
  readonly asunto: string;
  readonly html: string;
  readonly texto: string;
}

/** Solo para DISPLAY (nunca para cálculo -- `DecimalString`/`money.ts` sigue siendo la única fuente de verdad numérica, ver contract-billing.ts). */
function formatMxn(decimalAmount: string): string {
  const n = Number(decimalAmount);
  return Number.isFinite(n) ? `$${n.toFixed(2)} MXN` : `$${decimalAmount} MXN`;
}

// ---------------------------------------------------------------------------
// Recordatorio de plazo de convocatoria (Fase 8, tender_deadline_reminder).
// ---------------------------------------------------------------------------

export interface DeadlineReminderCorreoDatos {
  readonly tenderId: string;
  readonly submissionDeadline: string; // ISO 8601, ya calculado por scanUpcomingDeadlineReminders
  readonly daysRemaining: number;
  readonly message: string; // ya generado por el dominio (scanUpcomingDeadlineReminders) -- nunca se reconstruye aquí
}

export function correoRecordatorioPlazo(r: DeadlineReminderCorreoDatos): Correo {
  const mensaje = escapeHtml(r.message);
  const urgente = r.daysRemaining <= 1;
  const html = renderCorreo({
    titulo: urgente ? "Vencimiento de convocatoria — HOY o mañana" : "Se acerca el vencimiento de una convocatoria",
    preheader: r.message,
    etiqueta: { texto: urgente ? "Urgente" : "Recordatorio de plazo", color: urgente ? "#b91c1c" : "#b45309" },
    parrafosHtml: [mensaje],
    tabla: { filas: [{ etiqueta: "Convocatoria", valor: r.tenderId }, { etiqueta: "Vence", valor: r.submissionDeadline }, { etiqueta: "Días restantes", valor: String(r.daysRemaining) }] },
    nota: "Revisa el expediente en el panel de licitaciones para confirmar que el paquete esté listo antes del cierre.",
    piePorQueLlego: "Recibes este correo porque tienes rol owner/admin en una organización de atiende con una convocatoria próxima a vencer.",
  });
  return {
    asunto: `${urgente ? "⚠ " : ""}Vence pronto: convocatoria ${r.tenderId} (${r.daysRemaining} día${r.daysRemaining === 1 ? "" : "s"})`,
    html,
    texto: `${r.message}\nConvocatoria: ${r.tenderId}\nVence: ${r.submissionDeadline}\nDías restantes: ${r.daysRemaining}`,
  };
}

// ---------------------------------------------------------------------------
// Alerta de renovación de contrato (Fase 6, renewal_alert).
// ---------------------------------------------------------------------------

export interface RenewalAlertCorreoDatos {
  readonly tenderId: string;
  readonly contractId: string;
  readonly predictedDate: string; // "YYYY-MM-DD"
  readonly leadDays: number;
  readonly confidence: number; // 0..1
}

export function correoAlertaRenovacion(r: RenewalAlertCorreoDatos): Correo {
  const confidencePct = Math.round(r.confidence * 100);
  const html = renderCorreo({
    titulo: "Un contrato se acerca a su fecha de renovación",
    preheader: `Contrato de la convocatoria ${r.tenderId} — fin estimado ${r.predictedDate}`,
    etiqueta: { texto: "Radar de renovaciones", color: "#1D4ED8" },
    parrafosHtml: [`El contrato de la convocatoria <strong>${escapeHtml(r.tenderId)}</strong> tiene una fecha de fin estimada dentro de ${escapeHtml(String(r.leadDays))} días o menos — es momento de evaluar la renovación.`],
    tabla: {
      filas: [
        { etiqueta: "Convocatoria", valor: r.tenderId },
        { etiqueta: "Contrato", valor: r.contractId },
        { etiqueta: "Fin estimado", valor: r.predictedDate },
        { etiqueta: "Anticipación", valor: `${r.leadDays} días` },
        { etiqueta: "Confianza", valor: `${confidencePct}%` },
      ],
    },
    nota: "Revisa el radar de renovaciones en el panel de licitaciones para reconocer esta alerta y decidir si se gestiona la renovación.",
    piePorQueLlego: "Recibes este correo porque tienes rol owner/admin en una organización de atiende con un contrato próximo a su fecha de fin.",
  });
  return {
    asunto: `Renovación próxima: contrato de convocatoria ${r.tenderId} (${r.predictedDate})`,
    html,
    texto: `El contrato de la convocatoria ${r.tenderId} tiene fecha de fin estimada ${r.predictedDate} (${r.leadDays} días de anticipación, ${confidencePct}% de confianza).`,
  };
}

// ---------------------------------------------------------------------------
// Factura vencida (Fase 6, contract_invoice / cobranza).
// ---------------------------------------------------------------------------

export interface OverdueInvoiceCorreoDatos {
  readonly tenderId: string;
  readonly concepto: string;
  readonly amount: string; // DecimalString
  readonly dueDate: string; // "YYYY-MM-DD"
  readonly daysOverdue: number;
}

export function correoFacturaVencida(r: OverdueInvoiceCorreoDatos): Correo {
  const concepto = escapeHtml(r.concepto);
  const html = renderCorreo({
    titulo: "Una factura de cobranza está vencida",
    preheader: `${r.concepto} — ${formatMxn(r.amount)}, vencida hace ${r.daysOverdue} día(s)`,
    etiqueta: { texto: "Cobranza vencida", color: "#b91c1c" },
    parrafosHtml: [`La factura <strong>${concepto}</strong> del contrato de la convocatoria <strong>${escapeHtml(r.tenderId)}</strong> está vencida desde hace ${escapeHtml(String(r.daysOverdue))} día(s) (Art. 73 LAASSP, 17 días hábiles desde la verificación de la factura).`],
    tabla: {
      filas: [
        { etiqueta: "Convocatoria", valor: r.tenderId },
        { etiqueta: "Concepto", valor: r.concepto },
        { etiqueta: "Monto", valor: formatMxn(r.amount) },
        { etiqueta: "Vencimiento", valor: r.dueDate },
        { etiqueta: "Días vencida", valor: String(r.daysOverdue) },
      ],
    },
    nota: "Revisa la sección de cobranza del contrato en el panel de licitaciones para dar seguimiento al pago o registrar el pago si ya se recibió.",
    piePorQueLlego: "Recibes este correo porque tienes rol owner/admin en una organización de atiende con una factura de cobranza vencida.",
  });
  return {
    asunto: `Factura vencida (${r.daysOverdue} día${r.daysOverdue === 1 ? "" : "s"}): ${r.concepto} — ${formatMxn(r.amount)}`,
    html,
    texto: `Factura vencida: ${r.concepto} (${formatMxn(r.amount)}), convocatoria ${r.tenderId}, venció ${r.dueDate}, hace ${r.daysOverdue} día(s).`,
  };
}
