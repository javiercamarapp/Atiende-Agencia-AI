// Cliente HTTP genérico del panel de despachos (Fase 9) — mismo rol exacto que
// licitaciones/lib/admin-client.ts: `fetchJson`/`postJson` inyectan `fetchImpl`
// (nunca `globalThis.fetch` directo) para poder probarlos con vitest sin DOM, y
// `fetchBranches` resuelve el propertyId real desde el slug de la organización (la
// sesión de login, ../../../lib/auth-client.ts, solo trae
// {id, slug, nombre, vertical, rol}, nunca un propertyId — ver
// GET /v1/despachos/:orgSlug/admin/branches, apps/api/.../despachos/admin.ts).

export class DespachosAdminError extends Error {}

export interface BranchOption {
  readonly propertyId: string;
  readonly name: string;
}

export async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new DespachosAdminError(body?.message ?? `No se pudo cargar ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(fetchImpl: typeof fetch, url: string, token: string, payload: unknown = {}, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new DespachosAdminError(body?.message ?? body?.error ?? `No se pudo completar la operación (${res.status}).`);
  }
  return (await res.json()) as T;
}

export async function fetchBranches(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string): Promise<readonly BranchOption[]> {
  const body = await fetchJson<{ branches: readonly BranchOption[] }>(fetchImpl, `${apiBaseUrl}/v1/despachos/${orgSlug}/admin/branches`, token);
  return body.branches;
}
