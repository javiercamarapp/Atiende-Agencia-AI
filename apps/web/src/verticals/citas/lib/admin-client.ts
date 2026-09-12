// Helpers compartidos por el resto de lib/*.ts del panel de administración de
// citas (Fase 5) — mismo criterio que dashboard-client.ts de restaurantes:
// `fetchImpl` inyectado (nunca `globalThis.fetch` directo, para poder probar la
// lógica de red real con vitest en entorno "node" sin depender de jsdom) y un
// `fetchJson` genérico que nunca inventa un mensaje de error cuando el servidor ya
// mandó uno real.
//
// `fetchBranches` resuelve el propertyId real desde el orgSlug — la sesión de
// login (citas/lib/auth-client.ts) solo trae {id, slug, nombre, vertical, rol} de
// la organización, nunca un propertyId (las rutas de staff de este panel SÍ lo
// necesitan, ver `requirePropertyMembership` en apps/api). Llama a
// GET /v1/citas/:orgSlug/admin/branches (Fase 5 — apps/api/src/routes/verticals/citas/admin.ts),
// mismo rol que `fetchBranches` de restaurantes/dashboard-client.ts.

export class CitasAdminError extends Error {}

export async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new CitasAdminError(body?.message ?? `No se pudo cargar ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(fetchImpl: typeof fetch, url: string, token: string, payload: unknown = {}): Promise<T> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new CitasAdminError(body?.message ?? body?.error ?? `No se pudo completar la solicitud a ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

export interface BranchOption {
  readonly propertyId: string;
  readonly name: string;
}

export async function fetchBranches(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string): Promise<readonly BranchOption[]> {
  const body = await fetchJson<{ branches: readonly BranchOption[] }>(fetchImpl, `${apiBaseUrl}/v1/citas/${orgSlug}/admin/branches`, token);
  return body.branches;
}
