// UNI-RES-hoteles -- historial reciente del night audit para la seccion "Ultima corrida" del Resumen.
// Consume `GET /hoteles/:propertyId/night-audit` (apps/api/src/routes/verticals/hoteles/night-audit.ts,
// roles NIGHT_AUDIT_ROLES = owner/gm/accountant). Es la unica bitacora de corridas que existe hoy: no hay una
// tabla de corridas de agentes (hueco declarado en el PR).
import { fetchJson } from "./admin-client.ts";

/** Cosmetico: el servidor es la unica barrera real (403). Espejo de `NIGHT_AUDIT_ROLES` (domain-hoteles/src/roles.ts). */
export const NIGHT_AUDIT_VIEW_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "accountant"]);

export type NightAuditEstado = "en_progreso" | "completado";

export interface NightAuditCorrida {
  /** Fecha de negocio (YYYY-MM-DD). */
  readonly fecha: string;
  readonly estado: NightAuditEstado;
  /** ISO; null mientras la corrida sigue en progreso. */
  readonly completadoEn: string | null;
}

export function fetchNightAuditRuns(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly NightAuditCorrida[]> {
  return fetchJson<readonly NightAuditCorrida[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/night-audit`, token);
}

/** La corrida de fecha de negocio mas reciente, sin asumir el orden del servidor; lista vacia = null. */
export function ultimaCorrida(corridas: readonly NightAuditCorrida[]): NightAuditCorrida | null {
  let mejor: NightAuditCorrida | null = null;
  for (const c of corridas) {
    if (mejor === null || c.fecha > mejor.fecha) mejor = c;
  }
  return mejor;
}
