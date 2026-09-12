// Lógica de datos de Servicios (Fase 5) — lista + ficha, solo lectura por el mismo
// motivo que providers-client.ts: domain-citas no expone todavía crear/editar un
// servicio (solo `findService`/`listActiveServices`), y esta fase es de UI de
// panel sobre lógica ya existente, no de negocio nueva (ver README).
import { fetchJson } from "./admin-client.ts";

export interface ServiceSummary {
  readonly id: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly bufferMinutesBefore: number;
  readonly bufferMinutesAfter: number;
  readonly priceCents: number | null;
  readonly isActive: boolean;
}

interface ServiceApiRow {
  readonly id: string;
  readonly name: string;
  readonly duration_minutes: number;
  readonly buffer_minutes_before: number;
  readonly buffer_minutes_after: number;
  readonly price_cents: number | null;
  readonly is_active: boolean;
}

function mapService(row: ServiceApiRow): ServiceSummary {
  return {
    id: row.id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    bufferMinutesBefore: row.buffer_minutes_before,
    bufferMinutesAfter: row.buffer_minutes_after,
    priceCents: row.price_cents,
    isActive: row.is_active,
  };
}

export async function fetchServices(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly ServiceSummary[]> {
  const body = await fetchJson<{ services: readonly ServiceApiRow[] }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/services`, token);
  return body.services.map(mapService);
}

export async function fetchServiceDetail(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, serviceId: string): Promise<ServiceSummary> {
  const body = await fetchJson<{ service: ServiceApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/services/${serviceId}`, token);
  return mapService(body.service);
}
