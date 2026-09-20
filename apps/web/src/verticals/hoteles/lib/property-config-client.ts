// FASE 3 (producto) — ZONA HORARIA POR NEGOCIO, parte hoteles: consume
// apps/api/src/routes/verticals/hoteles/property-config.ts
// (GET/PUT /hoteles/:propertyId/configuracion). Mismo patrón exacto que
// catalogo-client.ts -- `fetchImpl` inyectado, `fetchJson`/`sendJson` compartidos.
import { fetchJson, sendJson } from "./admin-client.ts";

export interface PropertyConfigResult {
  /** `null` -- la property no configuró una zona horaria propia todavía (usa el
   *  default de plataforma). Nunca se muestra crudo en la UI sin explicar que es
   *  "sin configurar" -- ver `timezoneEfectiva` para el valor REAL que usa hoy el
   *  night-audit/motor de tarifas de esta property. */
  readonly timezone: string | null;
  readonly timezonePorDefecto: string;
  readonly timezoneEfectiva: string;
}

export async function fetchPropertyConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<PropertyConfigResult> {
  return fetchJson<PropertyConfigResult>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/configuracion`, token);
}

/** `timezone: null` limpia la configuración de vuelta al default de plataforma
 *  (mismo contrato que la ruta HTTP -- ver su comentario de cabecera). Validación de
 *  formato IANA la hace el servidor (mismo criterio que `citas/admin.ts::
 *  optionalTimeZone`) -- este cliente no duplica esa lógica. */
export async function updatePropertyTimezone(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, timezone: string | null): Promise<PropertyConfigResult> {
  return sendJson<PropertyConfigResult>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/configuracion`, token, "PUT", { timezone });
}
