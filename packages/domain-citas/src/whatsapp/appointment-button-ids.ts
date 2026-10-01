// C-01 -- formato del id de los botones del recordatorio 24h. Módulo hoja (sin
// imports de dominio) para que `reminders.ts` (que arma los botones) y
// `appointment-buttons.ts` (que resuelve el toque, e importa `reminders.ts`) no formen
// un ciclo de imports.

export type AppointmentButtonAction = "confirmar" | "cancelar" | "reagendar";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUTTON_ID_RE = /^cita:(confirmar|cancelar|reagendar):([0-9a-f-]{36})$/i;

/** Títulos visibles (Graph API: máximo 20 caracteres). */
const BUTTON_TITLES: Readonly<Record<AppointmentButtonAction, string>> = { confirmar: "Confirmar", cancelar: "Cancelar", reagendar: "Reagendar" };

export function buildAppointmentButtonId(action: AppointmentButtonAction, appointmentId: string): string {
  return `cita:${action}:${appointmentId}`;
}

/** Los 3 botones del recordatorio 24h, con el id de la cita embebido. */
export function appointmentReminderButtons(appointmentId: string): readonly { readonly id: string; readonly title: string }[] {
  return (["confirmar", "cancelar", "reagendar"] as const).map((action) => ({ id: buildAppointmentButtonId(action, appointmentId), title: BUTTON_TITLES[action] }));
}

/** Parseo estricto: devuelve `null` para cualquier id que no sea EXACTAMENTE el
 * formato que este módulo emite (incluidos los `btn_N` posicionales de recordatorios
 * enviados antes de este cambio -- esos caen al camino de texto/LLM). */
export function parseAppointmentButtonId(id: string): { readonly action: AppointmentButtonAction; readonly appointmentId: string } | null {
  const m = BUTTON_ID_RE.exec(id);
  if (!m || !UUID_RE.test(m[2]!)) return null;
  return { action: m[1]!.toLowerCase() as AppointmentButtonAction, appointmentId: m[2]!.toLowerCase() };
}

