// Helpers compartidos por el resto de lib/*.ts del panel de back-office de
// restaurantes (Fase 5) — mismo criterio que dashboard-client.ts (Fase 3) y que
// citas/lib/admin-client.ts (Fase 5 citas): `fetchImpl` inyectado (nunca
// `globalThis.fetch` directo, para poder probar la lógica de red real con vitest en
// entorno "node" sin depender de jsdom) y helpers genéricos que nunca inventan un
// mensaje de error cuando el servidor ya mandó uno real.
export class RestaurantesAdminError extends Error {}

export async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new RestaurantesAdminError(body?.message ?? `No se pudo cargar ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

export async function sendJson<T>(fetchImpl: typeof fetch, url: string, token: string, method: "POST" | "PATCH", payload: unknown = {}): Promise<T> {
  const res = await fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new RestaurantesAdminError(body?.message ?? body?.error ?? `No se pudo completar la solicitud a ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}
