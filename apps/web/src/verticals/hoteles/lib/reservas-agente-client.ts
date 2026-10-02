// UNI-RES-hoteles -- lectura minima de los holds del agente de reservas (WhatsApp/voz) para el Resumen.
// Consume `GET /hoteles/:propertyId/reservas-agente/holds` (apps/api/src/routes/verticals/hoteles/reservas-agente.ts,
// roles HOLD_VIEW_ROLES). Solo se tipan los campos que el Resumen usa; `fetchImpl` inyectado como el resto de lib/*.ts.
import { fetchJson } from "./admin-client.ts";

/** Cosmetico: el servidor es la unica barrera real (403). Espejo de `HOLD_VIEW_ROLES` (domain-hoteles/src/reservas-agente/tipos.ts). */
export const HOLD_VIEW_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations", "accountant"]);

export type HoldEstado = "pendiente_aprobacion" | "pendiente_pago" | "aprobado" | "confirmado" | "rechazado" | "expirado" | "cancelado";

export interface HoldResumen {
  readonly id: string;
  readonly estado: HoldEstado;
  readonly canal: "whatsapp" | "voz";
}

export interface HoldsResultado {
  /** false = la base aun no tiene la migracion de holds (lista vacia honesta). */
  readonly disponible: boolean;
  readonly holds: readonly HoldResumen[];
}

/** Holds abiertos (pendiente_aprobacion / pendiente_pago / aprobado): `?abiertas=1`. */
export function fetchHoldsAbiertos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<HoldsResultado> {
  return fetchJson<HoldsResultado>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reservas-agente/holds?abiertas=1`, token);
}
