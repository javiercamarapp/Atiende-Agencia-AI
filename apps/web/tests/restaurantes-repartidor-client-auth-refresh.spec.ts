// Test de integración por vertical (Hallazgo de auditoría, severidad ALTA,
// "duplicado en TODAS las verticales": "Expiración del JWT (15 min) no se maneja:
// el panel queda muerto sin refresh ni redirección") — cubre el cliente del panel
// de "repartidor" (verticals/restaurantes/lib/repartidor-client.ts), que hasta esta
// corrección tenía su propio `fetchJson` privado sin pasar nunca por
// `withAuthRefresh`, a diferencia del resto del vertical (ver admin-client.ts y
// dashboard-client.ts, ya cubiertos en sus propios *-auth-refresh.spec.ts).
//
// `fetchJson` de repartidor-client.ts NO está exportado (solo
// `fetchAssignedOrders`/`updateAssignedOrderStatus` lo usan internamente sin
// forwardear un `AuthedFetchContext`), así que este test ejercita el camino REAL de
// punta a punta: stubea `globalThis.localStorage` (lo que `defaultBrowserStorage()`
// termina leyendo, ver ../../src/lib/authed-fetch.ts) y siembra la sesión bajo la
// misma llave "atiende.restaurantes.session" que usa Repartidor.tsx (mismo criterio
// exacto que restaurantes-dashboard-client-auth-refresh.spec.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchAssignedOrders, updateAssignedOrderStatus } from "../src/verticals/restaurantes/lib/repartidor-client.ts";
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

const ORIGINAL: LoginSession = { token: "tok-viejo", refreshToken: "refresh-viejo", email: "repartidor@sushizen.mx", organizations: [] };
const REFRESHED: LoginSession = { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "repartidor@sushizen.mx", organizations: [] };

const ORDER_ROW = {
  id: "order-1",
  propertyId: "prop-1",
  branch: "Centro",
  customerName: "Ana",
  customerPhone: "9990000000",
  customerAddress: "Calle 1",
  total: 100,
  status: "preparando",
  items: [{ id: "prod-1", name: "Tacos", price: 100, quantity: 1 }],
  notes: null,
  paymentMethod: null,
  estimatedDeliveryAt: null,
  incidentNote: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("restaurantes/lib/repartidor-client.ts — refresh automático ante 401 (camino por defecto, vía globalThis.localStorage)", () => {
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

  it("fetchAssignedOrders: un 401 dispara POST /auth/refresh, reintenta con el token nuevo y deja la sesión NUEVA en localStorage", async () => {
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
      return new Response(JSON.stringify({ orders: [ORDER_ROW] }), { status: 200 });
    }) as unknown as typeof fetch;

    const orders = await fetchAssignedOrders(fetchImpl, "http://api.local", "tok-viejo", "prop-1");

    expect(orders).toHaveLength(1);
    expect(calls).toEqual([
      "http://api.local/v1/restaurantes/prop-1/repartidor/orders",
      "http://api.local/auth/refresh",
      "http://api.local/v1/restaurantes/prop-1/repartidor/orders",
    ]);
    expect(readPersistedSession(storage)).toEqual(REFRESHED);
  });

  it("fetchAssignedOrders: refresh fallido -> limpia la sesión de localStorage (Repartidor.tsx la vuelve a leer como null y redirige a login)", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "Refresh token inválido." }), { status: 401 });
      return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
    }) as unknown as typeof fetch;

    await expect(fetchAssignedOrders(fetchImpl, "http://api.local", "tok-viejo", "prop-1")).rejects.toThrow(/expir/i);
    expect(readPersistedSession(storage)).toBeNull();
  });

  it("updateAssignedOrderStatus (PATCH): mismo refresh-y-reintento en una escritura", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify(REFRESHED), { status: 200 });
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth === "Bearer tok-viejo") return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
      expect(auth).toBe("Bearer tok-nuevo");
      return new Response(JSON.stringify({ order: { ...ORDER_ROW, status: "en_camino" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await updateAssignedOrderStatus(fetchImpl, "http://api.local", "tok-viejo", "prop-1", "order-1", "en_camino");

    expect(result.status).toBe("en_camino");
    expect(calls).toEqual([
      "http://api.local/v1/restaurantes/prop-1/repartidor/orders/order-1/status",
      "http://api.local/auth/refresh",
      "http://api.local/v1/restaurantes/prop-1/repartidor/orders/order-1/status",
    ]);
    expect(readPersistedSession(storage)).toEqual(REFRESHED);
  });
});
