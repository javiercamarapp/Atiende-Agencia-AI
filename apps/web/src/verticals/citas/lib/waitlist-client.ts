// Lista de espera (Fase 9, backend) — hallazgo ALTA de auditoría: `GET/POST
// .../waitlist[/broadcast]` (admin.ts) ya estaba completo, probado y documentado
// en la API desde hace rondas, pero NINGÚN cliente de apps/web lo consumía —
// ninguna página podía siquiera ver la fila FIFO viva ni disparar el aviso
// manual. Este módulo cierra ese gap del lado del cliente, mismo criterio y
// mismos helpers (`fetchJson`/`postJson`, que ya envuelven cada llamada con
// `withAuthRefresh` vía admin-client.ts) que el resto de lib/*.ts de este
// vertical — ver providers-client.ts para el mismo patrón.
import { fetchJson, postJson } from "./admin-client.ts";

export interface WaitlistCandidate {
  readonly id: string;
  /** Posición 1-based en el mismo orden FIFO que `runListaEsperaCore` notifica de
   * verdad (ver sortWaitlistByPosition en domain-citas) — el orden en que llegaría
   * el aviso si se dispara el broadcast ahora mismo con estos mismos filtros. */
  readonly position: number;
  readonly customerName: string;
  readonly customerPhone: string;
  /** `null` = "sin preferencia de proveedor/servicio" — el candidato NO se excluye
   * al filtrar, mismo criterio que admin.ts::GET .../waitlist. */
  readonly providerId: string | null;
  readonly serviceId: string | null;
  readonly preferredDateFrom: string | null;
  readonly preferredDateTo: string | null;
  readonly preferredTimeWindow: string | null;
  readonly notifiedCount: number;
  readonly createdAt: string;
}

interface WaitlistCandidateApiRow {
  readonly id: string;
  readonly position: number;
  readonly customer_name: string;
  readonly customer_phone: string;
  readonly provider_id: string | null;
  readonly service_id: string | null;
  readonly preferred_date_from: string | null;
  readonly preferred_date_to: string | null;
  readonly preferred_time_window: string | null;
  readonly notified_count: number;
  readonly created_at: string;
}

function mapCandidate(row: WaitlistCandidateApiRow): WaitlistCandidate {
  return {
    id: row.id,
    position: row.position,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    providerId: row.provider_id,
    serviceId: row.service_id,
    preferredDateFrom: row.preferred_date_from,
    preferredDateTo: row.preferred_date_to,
    preferredTimeWindow: row.preferred_time_window,
    notifiedCount: row.notified_count,
    createdAt: row.created_at,
  };
}

export interface WaitlistFilters {
  readonly providerId?: string;
  readonly serviceId?: string;
}

/** GET solo-lectura de la lista de espera viva (admin.ts::GET .../waitlist) —
 * mismos filtros opcionales por provider_id/service_id que el broadcast, para que
 * el panel pueda mostrar exactamente a quién le tocaría el aviso ANTES de
 * dispararlo. */
export async function fetchWaitlist(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filters: WaitlistFilters = {}): Promise<readonly WaitlistCandidate[]> {
  const params = new URLSearchParams();
  if (filters.providerId) params.set("provider_id", filters.providerId);
  if (filters.serviceId) params.set("service_id", filters.serviceId);
  const qs = params.toString();
  const url = `${apiBaseUrl}/v1/citas/properties/${propertyId}/waitlist${qs ? `?${qs}` : ""}`;
  const body = await fetchJson<{ waitlist: readonly WaitlistCandidateApiRow[] }>(fetchImpl, url, token);
  return body.waitlist.map(mapCandidate);
}

export interface WaitlistBroadcastSummary {
  readonly notified: number;
  readonly candidatesConsidered: number;
  readonly skippedNoWhatsappConfig: number;
}

interface WaitlistBroadcastApiBody {
  readonly notified: number;
  readonly candidates_considered: number;
  readonly skipped_no_whatsapp_config: number;
}

export interface WaitlistBroadcastInput {
  readonly providerId?: string;
  readonly serviceId?: string;
  readonly limit?: number;
}

/** POST real que dispara el aviso (admin.ts::POST .../waitlist/broadcast) — encola
 * en `citas.messaging_outbox` (nunca habla directo con la API de WhatsApp, ver
 * runListaEsperaCore) el aviso a los candidatos FIFO que matcheen los filtros. */
export async function broadcastWaitlist(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: WaitlistBroadcastInput = {}): Promise<WaitlistBroadcastSummary> {
  const body = await postJson<WaitlistBroadcastApiBody>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/waitlist/broadcast`, token, {
    provider_id: input.providerId,
    service_id: input.serviceId,
    limit: input.limit,
  });
  return { notified: body.notified, candidatesConsidered: body.candidates_considered, skippedNoWhatsappConfig: body.skipped_no_whatsapp_config };
}
