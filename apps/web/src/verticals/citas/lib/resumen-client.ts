// Lógica de datos del panel Resumen de citas (C-05) -- GET
// /v1/citas/properties/:propertyId/resumen (apps/api/.../citas/admin.ts). Solo lectura de
// conteos agregados; `fetchImpl` inyectado como el resto de lib/*.ts para probar la red real sin jsdom.
import { fetchJson } from "./admin-client.ts";

export type EstadoCita = "pending" | "confirmed" | "completed" | "cancelled" | "no_show";
export type CanalCita = "voice" | "whatsapp" | "web" | "manual";
export type ConteoPorCanal = Readonly<Record<CanalCita, number>>;
export type ConteoPorEstado = Readonly<Record<EstadoCita, number>>;

export interface CitasResumen {
  readonly timezone: string;
  readonly generatedAt: string;
  readonly today: { readonly date: string; readonly total: number; readonly byStatus: ConteoPorEstado };
  readonly week: { readonly fromDate: string; readonly toDate: string; readonly total: number; readonly byStatus: ConteoPorEstado };
  readonly pendingToConfirm: number;
  readonly noShowsLast30Days: number;
  readonly newCustomersLast30Days: number;
  /** Citas no canceladas creadas en 30 días, por canal. `null` = un servidor anterior que aún no lo informa (no se inventa un 0). */
  readonly createdBySourceLast30Days: ConteoPorCanal | null;
}

interface ResumenApiBody {
  readonly timezone: string;
  readonly generated_at: string;
  readonly today: { readonly date: string; readonly total: number; readonly by_status: ConteoPorEstado };
  readonly week: { readonly from_date: string; readonly to_date: string; readonly total: number; readonly by_status: ConteoPorEstado };
  readonly pending_to_confirm: number;
  readonly no_shows_last_30_days: number;
  readonly new_customers_last_30_days: number;
  readonly created_by_source_last_30_days?: ConteoPorCanal;
}

export async function fetchCitasResumen(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<CitasResumen> {
  const b = await fetchJson<ResumenApiBody>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/resumen`, token);
  return {
    timezone: b.timezone,
    generatedAt: b.generated_at,
    today: { date: b.today.date, total: b.today.total, byStatus: b.today.by_status },
    week: { fromDate: b.week.from_date, toDate: b.week.to_date, total: b.week.total, byStatus: b.week.by_status },
    pendingToConfirm: b.pending_to_confirm,
    noShowsLast30Days: b.no_shows_last_30_days,
    newCustomersLast30Days: b.new_customers_last_30_days,
    createdBySourceLast30Days: b.created_by_source_last_30_days ?? null,
  };
}

/** "martes, 29 de septiembre" a partir de un "YYYY-MM-DD" que YA es el día del negocio. Se ancla a
 * mediodía UTC y se formatea en UTC para que la zona del navegador nunca corra la fecha un día
 * (mismo criterio que `parseFechaSolo` de formato-fecha.ts). */
export function formatDiaNegocio(dateStr: string): string {
  return new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${dateStr}T12:00:00.000Z`));
}

export function formatDiaCorto(dateStr: string): string {
  return new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${dateStr}T12:00:00.000Z`));
}
