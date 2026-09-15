// Test de integración por vertical (Hallazgo de auditoría, severidad ALTA,
// "duplicado en TODAS las verticales": "Expiración del JWT (15 min) no se maneja:
// el panel queda muerto sin refresh ni redirección") — a diferencia de los demás
// verticales, `fetchJson` de dashboard-client.ts NO está exportado (solo
// `fetchBranches`/`fetchDashboardData` lo usan internamente sin forwardear un
// `AuthedFetchContext`), así que este test ejercita el camino REAL de punta a
// punta: stubea `globalThis.localStorage` (lo que `defaultBrowserStorage()`
// termina leyendo, ver ../../lib/authed-fetch.ts) y siembra la sesión bajo la
// misma llave "atiende.restaurantes.session" que usa RestaurantesShell.tsx, en vez
// de inyectar un store falso por parámetro.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchBranches } from "../src/verticals/restaurantes/dashboard-client.ts";
import { persistSession, readPersistedSession } from "../src/lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../src/lib/auth-client.ts";

function fakeLocalStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return {
    setItem: (k, v) => void map.set(k, v),
    getItem: (k) => map.get(k) ?? null,
    removeItem: (k) => void map.delete(k),
  };
}

const ORIGINAL: LoginSession = { token: "tok-viejo", refreshToken: "refresh-viejo", email: "manager@sushizen.mx", organizations: [] };
const REFRESHED: LoginSession = { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "manager@sushizen.mx", organizations: [] };

describe("restaurantes/dashboard-client.ts — refresh automático ante 401 (camino por defecto, vía globalThis.localStorage)", () => {
  let storage: SessionStorageLike;
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

  beforeEach(() => {
    storage = fakeLocalStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    persistSession(storage, ORIGINAL);
  });

  afterEach(() => {
    if (originalLocalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
  });

  it("fetchBranches: un 401 dispara POST /auth/refresh, reintenta con el token nuevo y deja la sesión NUEVA en localStorage", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url === "http://api.local/auth/refresh") {
        expect(JSON.parse(init!.body as string)).toEqual({ refreshToken: "refresh-viejo" });
        return new Response(JSON.stringify(REFRESHED), { status: 200 });
      }
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth === "Bearer tok-viejo") return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
      expect(auth).toBe("Bearer tok-nuevo");
      return new Response(JSON.stringify({ branches: [{ propertyId: "p1", name: "Sushi Zen Centro", slug: "centro" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const branches = await fetchBranches(fetchImpl, "http://api.local", "tok-viejo", "sushi-zen");

    expect(branches).toHaveLength(1);
    expect(calls).toEqual([
      "http://api.local/v1/restaurantes/sushi-zen/admin/branches",
      "http://api.local/auth/refresh",
      "http://api.local/v1/restaurantes/sushi-zen/admin/branches",
    ]);
    expect(readPersistedSession(storage)).toEqual(REFRESHED);
  });

  it("fetchBranches: refresh fallido -> limpia la sesión de localStorage (RestaurantesShell la vuelve a leer como null y redirige a login)", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "Refresh token inválido." }), { status: 401 });
      return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
    }) as unknown as typeof fetch;

    await expect(fetchBranches(fetchImpl, "http://api.local", "tok-viejo", "sushi-zen")).rejects.toThrow(/expir/i);
    expect(readPersistedSession(storage)).toBeNull();
  });
});
