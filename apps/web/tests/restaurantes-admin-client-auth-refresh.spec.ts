// Test de integración por vertical (Hallazgo de auditoría, severidad ALTA,
// "duplicado en TODAS las verticales": "Expiración del JWT (15 min) no se maneja:
// el panel queda muerto sin refresh ni redirección") — cubre el SEGUNDO wrapper
// de restaurantes, verticals/restaurantes/lib/admin-client.ts (back-office CRUD:
// branches/catalog/customers/orders-client.ts), distinto del dashboard-client.ts
// de KPIs ya cubierto en restaurantes-dashboard-client-auth-refresh.spec.ts. Ver
// el comentario de cabecera de hoteles-admin-client-auth-refresh.spec.ts para el
// criterio completo (ctx inyectado explícito, sin depender de window/localStorage).
import { describe, expect, it } from "vitest";
import { fetchJson, RestaurantesAdminError, sendJson, SessionExpiredError } from "../src/verticals/restaurantes/lib/admin-client.ts";
import type { LoginSession } from "../src/lib/auth-client.ts";
import type { AuthedFetchContext } from "../src/lib/authed-fetch.ts";

function fakeCtx(initial: LoginSession | null) {
  let current = initial;
  const persisted: LoginSession[] = [];
  let cleared = 0;
  const ctx: AuthedFetchContext<LoginSession> = {
    vertical: "restaurantes",
    store: {
      read: () => current,
      persist: (s) => {
        current = s;
        persisted.push(s);
      },
      clear: () => {
        current = null;
        cleared += 1;
      },
    },
  };
  return { ctx, persisted, clearedCount: () => cleared, currentSession: () => current };
}

const REFRESHED: LoginSession = { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "manager@sushizen.mx", organizations: [] };

describe("restaurantes/lib/admin-client.ts — refresh automático ante 401", () => {
  it("fetchJson: un 401 dispara POST /auth/refresh y reintenta con el token nuevo", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify(REFRESHED), { status: 200 });
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth === "Bearer tok-viejo") return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
      expect(auth).toBe("Bearer tok-nuevo");
      return new Response(JSON.stringify({ categories: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx, persisted } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "manager@sushizen.mx", organizations: [] });
    const result = await fetchJson<{ categories: unknown[] }>(fetchImpl, "http://api.local/v1/restaurantes/prop-1/admin/categories", "tok-viejo", ctx);

    expect(result.categories).toEqual([]);
    expect(calls).toEqual([
      "http://api.local/v1/restaurantes/prop-1/admin/categories",
      "http://api.local/auth/refresh",
      "http://api.local/v1/restaurantes/prop-1/admin/categories",
    ]);
    expect(persisted).toEqual([REFRESHED]);
  });

  it("fetchJson: refresh fallido -> limpia la sesión y lanza SessionExpiredError", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "no" }), { status: 401 });
      return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx, clearedCount, currentSession } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-revocado", email: "manager@sushizen.mx", organizations: [] });
    await expect(fetchJson(fetchImpl, "http://api.local/v1/restaurantes/prop-1/admin/categories", "tok-viejo", ctx)).rejects.toThrow(SessionExpiredError);
    expect(clearedCount()).toBe(1);
    expect(currentSession()).toBeNull();
  });

  it("sendJson (PATCH): mismo refresh-y-reintento en una escritura", async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify(REFRESHED), { status: 200 });
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth === "Bearer tok-viejo") return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
      return new Response(JSON.stringify({ category: { id: "c1" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "manager@sushizen.mx", organizations: [] });
    const result = await sendJson<{ category: { id: string } }>(fetchImpl, "http://api.local/v1/restaurantes/prop-1/admin/categories/c1", "tok-viejo", "PATCH", { nombre: "Rolls" }, ctx);
    expect(result.category.id).toBe("c1");
  });

  it("respuesta no-ok que NO es 401 sigue siendo RestaurantesAdminError normal", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "no encontrado" }), { status: 404 })) as unknown as typeof fetch;
    const { ctx } = fakeCtx({ token: "tok", refreshToken: "r", email: "manager@sushizen.mx", organizations: [] });
    await expect(fetchJson(fetchImpl, "http://api.local/v1/restaurantes/prop-1/admin/categories", "tok", ctx)).rejects.toThrow(RestaurantesAdminError);
  });
});
