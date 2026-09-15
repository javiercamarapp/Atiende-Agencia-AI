// Test de integración por vertical (Hallazgo de auditoría, severidad ALTA,
// "duplicado en TODAS las verticales": "Expiración del JWT (15 min) no se maneja:
// el panel queda muerto sin refresh ni redirección") — ver el comentario de
// cabecera de hoteles-admin-client-auth-refresh.spec.ts para el criterio completo.
import { describe, expect, it } from "vitest";
import { fetchJson, LicitacionesAdminError, postJson, putJson, SessionExpiredError } from "../src/verticals/licitaciones/lib/admin-client.ts";
import type { LoginSession } from "../src/verticals/licitaciones/lib/auth-client.ts";
import type { AuthedFetchContext } from "../src/lib/authed-fetch.ts";

function fakeCtx(initial: LoginSession | null) {
  let current = initial;
  const persisted: LoginSession[] = [];
  let cleared = 0;
  const ctx: AuthedFetchContext<LoginSession> = {
    vertical: "licitaciones",
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

const REFRESHED: LoginSession = { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "analista@empresa.mx", organizations: [] };

describe("licitaciones/lib/admin-client.ts — refresh automático ante 401", () => {
  it("fetchJson: un 401 dispara POST /auth/refresh y reintenta con el token nuevo", async () => {
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
      return new Response(JSON.stringify({ tenders: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx, persisted } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "analista@empresa.mx", organizations: [] });
    const result = await fetchJson<{ tenders: unknown[] }>(fetchImpl, "http://api.local/licitaciones/prop-1/tenders", "tok-viejo", ctx);

    expect(result.tenders).toEqual([]);
    expect(calls).toEqual(["http://api.local/licitaciones/prop-1/tenders", "http://api.local/auth/refresh", "http://api.local/licitaciones/prop-1/tenders"]);
    expect(persisted).toEqual([REFRESHED]);
  });

  it("fetchJson: refresh fallido -> limpia la sesión y lanza SessionExpiredError", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "no" }), { status: 401 });
      return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx, clearedCount, currentSession } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-revocado", email: "analista@empresa.mx", organizations: [] });
    await expect(fetchJson(fetchImpl, "http://api.local/licitaciones/prop-1/tenders", "tok-viejo", ctx)).rejects.toThrow(SessionExpiredError);
    expect(clearedCount()).toBe(1);
    expect(currentSession()).toBeNull();
  });

  it("postJson: mismo refresh-y-reintento, conservando extraHeaders en el reintento", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init! });
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify(REFRESHED), { status: 200 });
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth === "Bearer tok-viejo") return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
      return new Response(JSON.stringify({ id: "d1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "analista@empresa.mx", organizations: [] });
    const result = await postJson<{ id: string }>(
      fetchImpl,
      "http://api.local/licitaciones/prop-1/tenders/t1/go-no-go",
      "tok-viejo",
      { decision: "go" },
      { "x-custom": "1" },
      ctx,
    );
    expect(result.id).toBe("d1");
    const reintento = calls[2]!;
    expect((reintento.init.headers as Record<string, string>)["x-custom"]).toBe("1");
  });

  it("respuesta no-ok que NO es 401 sigue siendo LicitacionesAdminError normal", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "no autorizado para esta acción" }), { status: 403 })) as unknown as typeof fetch;
    const { ctx } = fakeCtx({ token: "tok", refreshToken: "r", email: "analista@empresa.mx", organizations: [] });
    await expect(fetchJson(fetchImpl, "http://api.local/licitaciones/prop-1/tenders", "tok", ctx)).rejects.toThrow(LicitacionesAdminError);
  });

  // Hallazgo de auditoría, severidad ALTA: a diferencia de fetchJson/postJson de
  // arriba, `putJson` (usado por matching-profile-client.ts/technical-proposal-
  // client.ts) llamaba `fetchImpl` directo sin pasar nunca por `withAuthRefresh` —
  // mismo hallazgo, mismo archivo, corregido con el mismo patrón.
  it("putJson: mismo refresh-y-reintento, conservando extraHeaders en el reintento", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init! });
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify(REFRESHED), { status: 200 });
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth === "Bearer tok-viejo") return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
      return new Response(JSON.stringify({ id: "mp1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx, persisted } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "analista@empresa.mx", organizations: [] });
    const result = await putJson<{ id: string }>(
      fetchImpl,
      "http://api.local/licitaciones/prop-1/matching-profile",
      "tok-viejo",
      { keywords: ["obra pública"] },
      { "x-custom": "1" },
      ctx,
    );

    expect(result.id).toBe("mp1");
    expect(calls.map((c) => c.url)).toEqual([
      "http://api.local/licitaciones/prop-1/matching-profile",
      "http://api.local/auth/refresh",
      "http://api.local/licitaciones/prop-1/matching-profile",
    ]);
    const reintento = calls[2]!;
    expect((reintento.init.headers as Record<string, string>)["x-custom"]).toBe("1");
    expect(persisted).toEqual([REFRESHED]);
  });

  it("putJson: refresh fallido -> limpia la sesión y lanza SessionExpiredError", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "no" }), { status: 401 });
      return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx, clearedCount, currentSession } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-revocado", email: "analista@empresa.mx", organizations: [] });
    await expect(putJson(fetchImpl, "http://api.local/licitaciones/prop-1/matching-profile", "tok-viejo", {}, {}, ctx)).rejects.toThrow(SessionExpiredError);
    expect(clearedCount()).toBe(1);
    expect(currentSession()).toBeNull();
  });
});
