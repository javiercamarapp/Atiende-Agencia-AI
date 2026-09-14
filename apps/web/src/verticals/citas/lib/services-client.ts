// Lógica de datos de Servicios — lista + ficha (Fase 5) y, desde Fase 8, alta/
// edición real de un servicio (ver admin.ts::POST/PATCH .../services). `citas.services`
// no tiene columnas `description`/`requirements` como el repo original — quedan
// fuera de esta fase (ver comentario en domain-citas/src/types.ts::NewServiceInput).
import { fetchJson, sendJson } from "./admin-client.ts";

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

export interface NewServiceInput {
  readonly name: string;
  readonly durationMinutes: number;
  readonly bufferMinutesBefore?: number;
  readonly bufferMinutesAfter?: number;
  readonly priceCents?: number | null;
  readonly isActive?: boolean;
}

export interface ServicePatch {
  readonly name?: string;
  readonly durationMinutes?: number;
  readonly bufferMinutesBefore?: number;
  readonly bufferMinutesAfter?: number;
  readonly priceCents?: number | null;
  readonly isActive?: boolean;
}

export async function createService(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: NewServiceInput): Promise<ServiceSummary> {
  const body = await sendJson<{ service: ServiceApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/services`, token, "POST", {
    name: input.name,
    duration_minutes: input.durationMinutes,
    buffer_minutes_before: input.bufferMinutesBefore,
    buffer_minutes_after: input.bufferMinutesAfter,
    price_cents: input.priceCents,
    is_active: input.isActive,
  });
  return mapService(body.service);
}

export async function updateService(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, serviceId: string, patch: ServicePatch): Promise<ServiceSummary> {
  const body = await sendJson<{ service: ServiceApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/services/${serviceId}`, token, "PATCH", {
    name: patch.name,
    duration_minutes: patch.durationMinutes,
    buffer_minutes_before: patch.bufferMinutesBefore,
    buffer_minutes_after: patch.bufferMinutesAfter,
    price_cents: patch.priceCents,
    is_active: patch.isActive,
  });
  return mapService(body.service);
}
