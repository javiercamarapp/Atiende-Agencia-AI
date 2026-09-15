// Test de integración por vertical (Hallazgo de auditoría, severidad ALTA,
// "duplicado en TODAS las verticales": "Expiración del JWT (15 min) no se maneja:
// el panel queda muerto sin refresh ni redirección") — ver el comentario de
// cabecera de hoteles-admin-client-auth-refresh.spec.ts para el criterio completo.
import { describe, expect, it } from "vitest";
import { CitasAdminError, deleteJson, fetchJson, sendJson, SessionExpiredError } from "../src/verticals/citas/lib/admin-client.ts";
import type { LoginSession } from "../src/verticals/citas/lib/auth-client.ts";
import type { AuthedFetchContext } from "../src/lib/authed-fetch.ts";

function fakeCtx(initial: LoginSession | null) {
  let current = initial;
  const persisted: LoginSession[] = [];
  let cleared = 0;
  const ctx: AuthedFetchContext<LoginSession> = {
    vertical: "citas",
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

const REFRESHED: LoginSession = { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "staff@clinica.mx", organizations: [] };

describe("citas/lib/admin-client.ts — refresh automático ante 401", () => {
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
      return new Response(JSON.stringify({ providers: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx, persisted } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "staff@clinica.mx", organizations: [] });
    const result = await fetchJson<{ providers: unknown[] }>(fetchImpl, "http://api.local/v1/citas/properties/prop-1/providers", "tok-viejo", ctx);

    expect(result.providers).toEqual([]);
    expect(calls).toEqual([
      "http://api.local/v1/citas/properties/prop-1/providers",
      "http://api.local/auth/refresh",
      "http://api.local/v1/citas/properties/prop-1/providers",
    ]);
    expect(persisted).toEqual([REFRESHED]);
  });

  it("fetchJson: refresh fallido -> limpia la sesión y lanza SessionExpiredError", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "Refresh token inválido." }), { status: 401 });
      return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx, clearedCount, currentSession } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-revocado", email: "staff@clinica.mx", organizations: [] });
    await expect(fetchJson(fetchImpl, "http://api.local/v1/citas/properties/prop-1/providers", "tok-viejo", ctx)).rejects.toThrow(SessionExpiredError);
    expect(clearedCount()).toBe(1);
    expect(currentSession()).toBeNull();
  });

  it("sendJson (PATCH): mismo refresh-y-reintento en una escritura", async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify(REFRESHED), { status: 200 });
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth === "Bearer tok-viejo") return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
      expect(auth).toBe("Bearer tok-nuevo");
      return new Response(JSON.stringify({ service: { id: "s1" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "staff@clinica.mx", organizations: [] });
    const result = await sendJson<{ service: { id: string } }>(
      fetchImpl,
      "http://api.local/v1/citas/properties/prop-1/services/s1",
      "tok-viejo",
      "PATCH",
      { nombre: "Limpieza dental" },
      ctx,
    );
    expect(result.service.id).toBe("s1");
  });

  it("respuesta no-ok que NO es 401 sigue siendo CitasAdminError normal", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "No perteneces a esta organización." }), { status: 403 })) as unknown as typeof fetch;
    const { ctx } = fakeCtx({ token: "tok", refreshToken: "r", email: "staff@clinica.mx", organizations: [] });
    await expect(fetchJson(fetchImpl, "http://api.local/v1/citas/properties/prop-1/providers", "tok", ctx)).rejects.toThrow(CitasAdminError);
  });

  // Hallazgo de auditoría, severidad ALTA: a diferencia de fetchJson/sendJson de
  // arriba, `deleteJson` (usado por providers-client.ts::deleteAvailabilityRule/
  // deleteAvailabilityOverride) llamaba `fetchImpl` directo sin pasar nunca por
  // `withAuthRefresh` — mismo hallazgo, mismo archivo, corregido con el mismo patrón.
  it("deleteJson: un 401 dispara POST /auth/refresh y reintenta con el token nuevo", async () => {
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
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx, persisted } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "staff@clinica.mx", organizations: [] });
    await deleteJson(fetchImpl, "http://api.local/v1/citas/properties/prop-1/providers/prov-1/availability-rules/r1", "tok-viejo", ctx);

    expect(calls).toEqual([
      "http://api.local/v1/citas/properties/prop-1/providers/prov-1/availability-rules/r1",
      "http://api.local/auth/refresh",
      "http://api.local/v1/citas/properties/prop-1/providers/prov-1/availability-rules/r1",
    ]);
    expect(persisted).toEqual([REFRESHED]);
  });

  it("deleteJson: refresh fallido -> limpia la sesión y lanza SessionExpiredError", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "no" }), { status: 401 });
      return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx, clearedCount, currentSession } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-revocado", email: "staff@clinica.mx", organizations: [] });
    await expect(deleteJson(fetchImpl, "http://api.local/v1/citas/properties/prop-1/providers/prov-1/availability-rules/r1", "tok-viejo", ctx)).rejects.toThrow(SessionExpiredError);
    expect(clearedCount()).toBe(1);
    expect(currentSession()).toBeNull();
  });
});
