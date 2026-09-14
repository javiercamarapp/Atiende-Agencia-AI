// Helpers compartidos por el resto de lib/*.ts del panel de staff de rentas (Fase
// 12) — mismo criterio exacto que verticals/hoteles/lib/admin-client.ts:
// `fetchImpl` inyectado (nunca `globalThis.fetch` directo, para poder probar la
// lógica de red real con vitest en entorno "node" sin depender de jsdom) y un
// helper genérico que nunca inventa un mensaje de error cuando el servidor ya mandó
// uno real.
export class RentasAdminError extends Error {}

export async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new RentasAdminError(body?.message ?? `No se pudo cargar ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}
