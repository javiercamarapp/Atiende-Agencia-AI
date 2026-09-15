// Test de integración por vertical (Hallazgo de auditoría, severidad ALTA,
// "duplicado en TODAS las verticales": "Expiración del JWT (15 min) no se maneja:
// el panel queda muerto sin refresh ni redirección") — confirma que `fetchJson`/
// `sendJson` REALES de hoteles/lib/admin-client.ts (no un doble del mecanismo
// compartido) efectivamente disparan refresh-y-reintento ante un 401, y que un
// refresh fallido limpia la sesión persistida. El `AuthedFetchContext` se pasa
// EXPLÍCITO como 4º argumento (mismo mecanismo que usan las páginas reales cuando
// se omite, ver `defaultAuthCtx` en admin-client.ts) para no depender de
// `window.localStorage` en el entorno "node" de vitest — la firma pública de 3
// argumentos que ya usan folios-client.ts/reservas-client.ts/etc. queda intacta.
import { describe, expect, it } from "vitest";
import { fetchJson, HotelesAdminError, sendJson, SessionExpiredError } from "../src/verticals/hoteles/lib/admin-client.ts";
import type { LoginSession } from "../src/verticals/hoteles/lib/auth-client.ts";
import type { AuthedFetchContext } from "../src/lib/authed-fetch.ts";

function fakeCtx(initial: LoginSession | null) {
  let current = initial;
  const persisted: LoginSession[] = [];
  let cleared = 0;
  const ctx: AuthedFetchContext<LoginSession> = {
    vertical: "hoteles",
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

const REFRESHED: LoginSession = { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "gm@hotel.mx", organizations: [] };

describe("hoteles/lib/admin-client.ts — refresh automático ante 401", () => {
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
      return new Response(JSON.stringify({ propiedades: [{ propertyId: "p1", nombre: "Hotel Caribe" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx, persisted } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "gm@hotel.mx", organizations: [] });

    const result = await fetchJson<{ propiedades: unknown[] }>(fetchImpl, "http://api.local/v1/hoteles/hotel-caribe/admin/propiedades", "tok-viejo", ctx);

    expect(result.propiedades).toHaveLength(1);
    expect(calls).toEqual(["http://api.local/v1/hoteles/hotel-caribe/admin/propiedades", "http://api.local/auth/refresh", "http://api.local/v1/hoteles/hotel-caribe/admin/propiedades"]);
    expect(persisted).toEqual([REFRESHED]);
  });

  it("fetchJson: refresh fallido (refresh token revocado por logout) -> limpia la sesión y lanza SessionExpiredError, nunca HotelesAdminError genérico", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "Refresh token inválido o expirado." }), { status: 401 });
      return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
    }) as unknown as typeof fetch;

    const { ctx, clearedCount, currentSession } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-revocado", email: "gm@hotel.mx", organizations: [] });

    await expect(fetchJson(fetchImpl, "http://api.local/v1/hoteles/hotel-caribe/admin/propiedades", "tok-viejo", ctx)).rejects.toThrow(SessionExpiredError);
    expect(clearedCount()).toBe(1);
    expect(currentSession()).toBeNull();
  });

  it("sendJson: mismo refresh-y-reintento en una escritura (POST con Idempotency-Key), reenvía el header y el body originales en el reintento", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init! });
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify(REFRESHED), { status: 200 });
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth === "Bearer tok-viejo") return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
      return new Response(JSON.stringify({ id: "charge-1" }), { status: 201 });
    }) as unknown as typeof fetch;

    const { ctx } = fakeCtx({ token: "tok-viejo", refreshToken: "refresh-viejo", email: "gm@hotel.mx", organizations: [] });

    const result = await sendJson<{ id: string }>(
      fetchImpl,
      "http://api.local/hoteles/prop-1/folios/folio-1/cargos",
      "tok-viejo",
      "POST",
      { descripcion: "Minibar", monto: 200 },
      "key-1",
      ctx,
    );

    expect(result.id).toBe("charge-1");
    const reintento = calls[2]!;
    expect((reintento.init.headers as Record<string, string>)["idempotency-key"]).toBe("key-1");
    expect(JSON.parse(reintento.init.body as string)).toEqual({ descripcion: "Minibar", monto: 200 });
  });

  it("respuesta no-ok que NO es 401 (ej. 409) sigue reportándose como HotelesAdminError normal, sin tocar /auth/refresh", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "El folio está cerrado." }), { status: 409 })) as unknown as typeof fetch;
    const { ctx } = fakeCtx({ token: "tok", refreshToken: "r", email: "gm@hotel.mx", organizations: [] });
    await expect(fetchJson(fetchImpl, "http://api.local/hoteles/prop-1/folios/folio-1", "tok", ctx)).rejects.toThrow(HotelesAdminError);
  });
});
