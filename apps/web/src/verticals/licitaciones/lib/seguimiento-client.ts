// Cliente web de seguimiento (L-03) -- recordatorios de vencimiento de plazo
// (sources.ts: GET/POST .../sources/deadline-reminders[/:id/ack]) y bandeja de
// cambios de convocatoria (tenderVersions.ts: GET .../tender-change-notifications
// y POST .../:id/acknowledge, REQ-151/155). Leer = cualquier miembro; reconocer =
// WRITE_ROLES en el servidor (la UI solo oculta el boton, nunca es la barrera).
import { fetchJson, postJson } from "./admin-client.ts";

/** Espejo de `TenderDeadlineReminderRecord`. */
export interface DeadlineReminder {
  readonly id: string;
  readonly tenderId: string;
  readonly submissionDeadline: string;
  readonly daysRemaining: number;
  readonly message: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
}

/** Espejo de `TenderChangeNotificationRecord`. */
export interface TenderChangeNotification {
  readonly id: string;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly reason: string;
  readonly changedFieldNames: readonly string[];
  readonly affectedSectionKeys: readonly string[];
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
}

export async function fetchDeadlineReminders(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly DeadlineReminder[]> {
  const body = await fetchJson<{ reminders: readonly DeadlineReminder[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/sources/deadline-reminders`, token);
  return body.reminders;
}

export async function acknowledgeDeadlineReminder(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reminderId: string): Promise<DeadlineReminder> {
  const body = await postJson<{ reminder: DeadlineReminder }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/sources/deadline-reminders/${reminderId}/ack`, token);
  return body.reminder;
}

export async function fetchTenderChangeNotifications(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly TenderChangeNotification[]> {
  const body = await fetchJson<{ notifications: readonly TenderChangeNotification[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tender-change-notifications`, token);
  return body.notifications;
}

export async function acknowledgeTenderChangeNotification(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, notificationId: string): Promise<TenderChangeNotification> {
  return postJson<TenderChangeNotification>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tender-change-notifications/${notificationId}/acknowledge`, token);
}
