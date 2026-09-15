// Checador de asistencia (Fase 8/16 hoteles, REQ-BO-024, P0/GOB, LFT art.132
// fr.XXXIV) — consume apps/api/src/routes/verticals/hoteles/asistencia.ts. Hallazgo
// de auditoría (severidad ALTA, "checador de asistencia LFT sin UI"): el backend
// (POST .../checar, GET .../asistencia, POST .../horarios, GET .../cruce, GET
// .../exportar-stps) existe desde Fase 8 sin ningún cliente ni página — cada
// empleado debía fichar, pero no había forma de hacerlo. Mismo criterio que
// housekeeping-client.ts/fraude-client.ts: `fetchImpl` inyectado, `fetchJson`/
// `sendJson` de admin-client.ts (con refresh-on-401 ya incluido), sin inventar
// mensajes de error que el servidor ya mandó.
import { apiBaseUrlFromRequestUrl, defaultBrowserStorage, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../../../lib/authed-fetch.ts";
import { fetchJson, HotelesAdminError, sendJson } from "./admin-client.ts";
import { clearHotelesSession, persistHotelesSession, readPersistedHotelesSession } from "./auth-client.ts";
import type { LoginSession } from "./auth-client.ts";

export type AttendanceEventType = "entrada" | "salida";

export interface AttendanceEvent {
  readonly id: string;
  readonly staffUserId: string;
  readonly eventType: AttendanceEventType;
  readonly recordedAt: string;
  readonly source: string;
  readonly nota: string | null;
}

export interface StaffScheduleInput {
  readonly staffUserId: string;
  readonly workDate: string;
  readonly scheduledStart: string;
  readonly scheduledEnd: string;
  readonly authorizedOvertimeMinutes?: number;
}

export interface StaffSchedule {
  readonly id: string;
  readonly staffUserId: string;
  readonly workDate: string;
  readonly scheduledStart: string;
  readonly scheduledEnd: string;
  readonly authorizedOvertimeMinutes: number;
}

export type CrossCheckStatus = string;

export interface CrossCheckRow {
  readonly fecha: string;
  readonly estado: CrossCheckStatus;
  readonly horarioInicio: string | null;
  readonly horarioFin: string | null;
  readonly horasProgramadas: number | null;
  readonly horasTrabajadas: number;
  readonly horasExtra: number;
  readonly horasExtraAutorizadas: number;
  readonly horasExtraNoAutorizadas: number;
  readonly alerta: boolean;
  readonly anomalias: readonly string[];
}

/** Ficha el PROPIO registro del staff autenticado (checador de autoservicio) —
 * `staffUserId` nunca es un parámetro de esta función a propósito: el servidor
 * SIEMPRE lo toma de la sesión (`c.get("userId")`), ver comentario de cabecera de
 * asistencia.ts. Cualquier UI que llame a esto solo puede fichar su propio turno. */
export async function checkIn(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, eventType: AttendanceEventType, note?: string): Promise<AttendanceEvent> {
  return sendJson<AttendanceEvent>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/asistencia/checar`, token, "POST", note ? { eventType, note } : { eventType });
}

/** Historial de asistencia — sin `staffUserId` trae el PROPIO historial (cualquier
 * staff puede verlo); con `staffUserId` de otro empleado, el servidor exige rol de
 * administración de asistencia (ATTENDANCE_ADMIN_ROLES, ver roles.ts) y devuelve 403
 * si no lo tiene. */
export async function fetchAttendance(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  opts: { staffUserId?: string; fromDate?: string; toDate?: string } = {},
): Promise<readonly AttendanceEvent[]> {
  const qs = new URLSearchParams();
  if (opts.staffUserId) qs.set("staffUserId", opts.staffUserId);
  if (opts.fromDate) qs.set("desde", opts.fromDate);
  if (opts.toDate) qs.set("hasta", opts.toDate);
  const query = qs.toString();
  return fetchJson<readonly AttendanceEvent[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/asistencia${query ? `?${query}` : ""}`, token);
}

/** Programa (o reemplaza, misma `unique (property_id, staff_user_id, work_date)`)
 * el horario de UN día de UN empleado — solo ATTENDANCE_ADMIN_ROLES (owner/gm). */
export async function upsertStaffSchedule(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: StaffScheduleInput): Promise<StaffSchedule> {
  return sendJson<StaffSchedule>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/asistencia/horarios`, token, "POST", input);
}

/** Cruce (REQ-BO-024): lo REALMENTE trabajado (attendance_log) contra lo
 * AUTORIZADO (staff_schedule), día por día del rango — solo ATTENDANCE_ADMIN_ROLES. */
export async function fetchCrossCheck(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, staffUserId: string, fromDate: string, toDate: string): Promise<readonly CrossCheckRow[]> {
  const qs = new URLSearchParams({ staffUserId, desde: fromDate, hasta: toDate });
  return fetchJson<readonly CrossCheckRow[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/asistencia/cruce?${qs.toString()}`, token);
}

/** Mismo `AuthedFetchContext` por defecto que `admin-client.ts` (construido aquí en
 * vez de reexportado — no está exportado de ese módulo) para que la exportación
 * STPS también reintente una vez ante un 401, igual que `fetchJson`/`sendJson`. */
function defaultAuthCtx(): AuthedFetchContext<LoginSession> {
  const storage = defaultBrowserStorage();
  return {
    vertical: "hoteles",
    store: {
      read: () => (storage ? readPersistedHotelesSession(storage) : null),
      persist: (session) => {
        if (storage) persistHotelesSession(storage, session);
      },
      clear: () => {
        if (storage) clearHotelesSession(storage);
      },
    },
  };
}

/** GET .../exportar-stps — a diferencia del resto de este cliente, la respuesta es
 * `text/csv` (ver asistencia.ts: `c.body(csv, ...)`), nunca JSON, así que no puede
 * reusar `fetchJson` (que siempre hace `.json()`). Devuelve el texto crudo del CSV;
 * quien llama decide cómo ofrecerlo (Blob + descarga en el navegador). */
export async function fetchStpsExportCsv(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, staffUserId: string, fromDate: string, toDate: string): Promise<string> {
  const qs = new URLSearchParams({ staffUserId, desde: fromDate, hasta: toDate });
  const url = `${apiBaseUrl}/hoteles/${propertyId}/asistencia/exportar-stps?${qs.toString()}`;
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new HotelesAdminError(body?.message ?? `No se pudo exportar la asistencia (${res.status}).`);
  }
  return res.text();
}
