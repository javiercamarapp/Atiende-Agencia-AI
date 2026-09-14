// Lógica de datos de Sucursales (Fase 5) — ficha de administración sobre
// apps/api/src/routes/verticals/restaurantes/admin-branches.ts. Deliberadamente sin
// "crear sucursal" ni "activar/desactivar": ver comentario de cabecera de
// admin-branches.ts (`core.property` es compartida por todas las verticales y hoy
// solo `service_role` puede escribirla).
import { fetchJson, sendJson } from "./admin-client.ts";

export interface BranchDetail {
  readonly propertyId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "active" | "inactive";
  readonly phone: string | null;
  readonly address: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
}

export async function fetchAdminBranches(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly BranchDetail[]> {
  const body = await fetchJson<{ branches: readonly BranchDetail[] }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/sucursales`, token);
  return body.branches;
}

export async function fetchBranchDetail(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, branchId: string): Promise<BranchDetail> {
  const body = await fetchJson<{ branch: BranchDetail }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/sucursales/${branchId}`, token);
  return body.branch;
}

export async function updateBranchDetail(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  branchId: string,
  patch: { phone?: string | null; address?: string | null; lat?: number | null; lng?: number | null },
): Promise<BranchDetail> {
  const body = await sendJson<{ branch: BranchDetail }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/sucursales/${branchId}`, token, "PATCH", patch);
  return body.branch;
}
