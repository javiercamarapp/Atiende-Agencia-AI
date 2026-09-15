// Test de integración por vertical (Hallazgo de auditoría, severidad ALTA,
// "duplicado en TODAS las verticales": "Expiración del JWT (15 min) no se maneja:
// el panel queda muerto sin refresh ni redirección") — ver el comentario de
// cabecera de hoteles-admin-client-auth-refresh.spec.ts para el criterio completo.
import { describe, expect, it } from "vitest";
import { DespachosAdminError, fetchJson, postJson, SessionExpiredError } from "../src/verticals/despachos/lib/admin-client.ts";
import type { LoginSession } from "../src/verticals/despachos/lib/auth-client.ts";
import type { AuthedFetchContext } from "../src/lib/authed-fetch.ts";

function fakeCtx(initial: LoginSession | null) {
  let current = initial;
  const persisted: LoginSession[] = [];
  let cleared = 0;
  const ctx: AuthedFetchContext<LoginSession> = {
    vertical: "despachos",
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

const REFRESHED: LoginSession = { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "contador@despacho.mx", organizations: [] };

describe("despachos/lib/admin-client.ts — refresh automático ante 401", () => {
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
      return new Response(JSON.stringify({ periodos: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx, persisted } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "contador@despacho.mx", organizations: [] });
    const result = await fetchJson<{ periodos: unknown[] }>(fetchImpl, "http://api.local/despachos/prop-1/cierre-mensual/periodos", "tok-viejo", ctx);

    expect(result.periodos).toEqual([]);
    expect(calls).toEqual([
      "http://api.local/despachos/prop-1/cierre-mensual/periodos",
      "http://api.local/auth/refresh",
      "http://api.local/despachos/prop-1/cierre-mensual/periodos",
    ]);
    expect(persisted).toEqual([REFRESHED]);
  });

  it("fetchJson: refresh fallido -> limpia la sesión y lanza SessionExpiredError", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "no" }), { status: 401 });
      return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx, clearedCount, currentSession } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-revocado", email: "contador@despacho.mx", organizations: [] });
    await expect(fetchJson(fetchImpl, "http://api.local/despachos/prop-1/cierre-mensual/periodos", "tok-viejo", ctx)).rejects.toThrow(SessionExpiredError);
    expect(clearedCount()).toBe(1);
    expect(currentSession()).toBeNull();
  });

  it("postJson: mismo refresh-y-reintento en una escritura", async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify(REFRESHED), { status: 200 });
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth === "Bearer tok-viejo") return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
      expect(auth).toBe("Bearer tok-nuevo");
      return new Response(JSON.stringify({ id: "periodo-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "contador@despacho.mx", organizations: [] });
    const result = await postJson<{ id: string }>(fetchImpl, "http://api.local/despachos/prop-1/cierre-mensual/periodos", "tok-viejo", { mes: 9, anio: 2026 }, {}, ctx);
    expect(result.id).toBe("periodo-1");
  });

  it("respuesta no-ok que NO es 401 sigue siendo DespachosAdminError normal", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "sin permiso" }), { status: 403 })) as unknown as typeof fetch;
    const { ctx } = fakeCtx({ token: "tok", refreshToken: "r", email: "contador@despacho.mx", organizations: [] });
    await expect(fetchJson(fetchImpl, "http://api.local/despachos/prop-1/cierre-mensual/periodos", "tok", ctx)).rejects.toThrow(DespachosAdminError);
  });
});
