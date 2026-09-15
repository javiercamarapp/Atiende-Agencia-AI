// Test de integración por vertical (Hallazgo de auditoría, severidad ALTA,
// "duplicado en TODAS las verticales": "Expiración del JWT (15 min) no se maneja:
// el panel queda muerto sin refresh ni redirección") — ver el comentario de
// cabecera de hoteles-admin-client-auth-refresh.spec.ts para el criterio completo.
// Rentas solo expone `fetchJson` en su admin-client.ts (sin escritura todavía, ver
// su comentario de cabecera).
import { describe, expect, it } from "vitest";
import { fetchJson, RentasAdminError, SessionExpiredError } from "../src/verticals/rentas/lib/admin-client.ts";
import type { LoginSession } from "../src/verticals/rentas/lib/auth-client.ts";
import type { AuthedFetchContext } from "../src/lib/authed-fetch.ts";

function fakeCtx(initial: LoginSession | null) {
  let current = initial;
  const persisted: LoginSession[] = [];
  let cleared = 0;
  const ctx: AuthedFetchContext<LoginSession> = {
    vertical: "rentas",
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

const REFRESHED: LoginSession = { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "gestor@rentas.mx", organizations: [] };

describe("rentas/lib/admin-client.ts — refresh automático ante 401", () => {
  it("fetchJson: un 401 dispara POST /auth/refresh con el refreshToken persistido y reintenta con el token nuevo", async () => {
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
      return new Response(JSON.stringify({ propiedades: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx, persisted } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "gestor@rentas.mx", organizations: [] });
    const result = await fetchJson<{ propiedades: unknown[] }>(fetchImpl, "http://api.local/v1/rentas/gestora-1/admin/propiedades", "tok-viejo", ctx);

    expect(result.propiedades).toEqual([]);
    expect(calls).toEqual([
      "http://api.local/v1/rentas/gestora-1/admin/propiedades",
      "http://api.local/auth/refresh",
      "http://api.local/v1/rentas/gestora-1/admin/propiedades",
    ]);
    expect(persisted).toEqual([REFRESHED]);
  });

  it("fetchJson: refresh fallido -> limpia la sesión y lanza SessionExpiredError, nunca RentasAdminError genérico", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "no" }), { status: 401 });
      return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx, clearedCount, currentSession } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-revocado", email: "gestor@rentas.mx", organizations: [] });
    await expect(fetchJson(fetchImpl, "http://api.local/v1/rentas/gestora-1/admin/propiedades", "tok-viejo", ctx)).rejects.toThrow(SessionExpiredError);
    expect(clearedCount()).toBe(1);
    expect(currentSession()).toBeNull();
  });

  it("respuesta no-ok que NO es 401 sigue siendo RentasAdminError normal, sin tocar /auth/refresh", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "Negocio no encontrado." }), { status: 404 })) as unknown as typeof fetch;
    const { ctx } = fakeCtx({ token: "tok", refreshToken: "r", email: "gestor@rentas.mx", organizations: [] });
    await expect(fetchJson(fetchImpl, "http://api.local/v1/rentas/gestora-1/admin/propiedades", "tok", ctx)).rejects.toThrow(RentasAdminError);
  });
});
