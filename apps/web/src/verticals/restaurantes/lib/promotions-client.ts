// Lógica de datos de Promociones/códigos de descuento (Fase 11) — hallazgo de
// auditoría (severidad ALTA, "Promociones/códigos de descuento (Fase 11) sin UI"):
// admin-promotions.ts ya expone GET/POST .../admin/promotions y PATCH
// .../admin/promotions/:promotionId (organization-wide, MANAGER_ROLES — ver
// comentario de cabecera de ese archivo), pero apps/web no tenía cliente ni
// página. Mismo patrón exacto que catalog-client.ts (Fase 5): `fetchImpl`
// inyectado, fetchJson/sendJson de admin-client.ts (con refresh-on-401 ya
// resuelto, nunca se duplica esa lógica aquí).
import { fetchJson, sendJson } from "./admin-client.ts";

export type PromotionType = "percentage" | "fixed";

export interface Promotion {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: PromotionType;
  readonly value: number;
  readonly minOrderTotal: number | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly daysOfWeek: readonly number[] | null;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly maxUses: number | null;
  readonly timesUsed: number;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewPromotionInput {
  readonly code: string;
  readonly name: string;
  readonly type: PromotionType;
  readonly value: number;
  readonly description?: string | null;
  readonly minOrderTotal?: number | null;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly daysOfWeek?: readonly number[] | null;
  readonly startTime?: string | null;
  readonly endTime?: string | null;
  readonly maxUses?: number | null;
  readonly isActive?: boolean;
}

export interface PromotionPatch {
  readonly code?: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly type?: PromotionType;
  readonly value?: number;
  readonly minOrderTotal?: number | null;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly daysOfWeek?: readonly number[] | null;
  readonly startTime?: string | null;
  readonly endTime?: string | null;
  readonly maxUses?: number | null;
  readonly isActive?: boolean;
}

export async function fetchPromotions(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly Promotion[]> {
  const body = await fetchJson<{ promotions: readonly Promotion[] }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/promotions`, token);
  return body.promotions;
}

export async function createPromotion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: NewPromotionInput): Promise<Promotion> {
  const body = await sendJson<{ promotion: Promotion }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/promotions`, token, "POST", input);
  return body.promotion;
}

export async function updatePromotion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  promotionId: string,
  patch: PromotionPatch,
): Promise<Promotion> {
  const body = await sendJson<{ promotion: Promotion }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/promotions/${promotionId}`, token, "PATCH", patch);
  return body.promotion;
}

/** Mismo criterio exacto que `isAvailable` en catalog-client.ts/admin-promotions.ts
 * (comentario de cabecera): togglear activo/inactivo es el mismo PATCH genérico,
 * nunca una ruta separada — este helper solo evita repetir `{ isActive }` en la
 * página. */
export async function setPromotionActive(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  promotionId: string,
  isActive: boolean,
): Promise<Promotion> {
  return updatePromotion(fetchImpl, apiBaseUrl, token, propertyId, promotionId, { isActive });
}
