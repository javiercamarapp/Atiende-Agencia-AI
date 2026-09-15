// Test de integración por vertical (Hallazgo de auditoría, severidad ALTA,
// "duplicado en TODAS las verticales": "Expiración del JWT (15 min) no se maneja:
// el panel queda muerto sin refresh ni redirección") — cubre
// `requestGoogleCalendarConnectUrl` (verticals/citas/lib/providers-client.ts), que
// hasta esta corrección llamaba `fetchImpl` directo sin pasar nunca por
// `withAuthRefresh`, a diferencia de `fetchJson`/`sendJson`/`deleteJson` del mismo
// vertical (ver citas-admin-client-auth-refresh.spec.ts).
//
// `requestGoogleCalendarConnectUrl` no expone un `AuthedFetchContext` como
// parámetro (mismo criterio que `fetchBranches` de restaurantes/dashboard-client.ts,
// ver restaurantes-dashboard-client-auth-refresh.spec.ts), así que este test
// ejercita el camino REAL de punta a punta: stubea `globalThis.localStorage` y
// siembra la sesión bajo la misma llave "atiende.citas.session" que usa
// Proveedores.tsx/Configuracion.tsx.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestGoogleCalendarConnectUrl } from "../src/verticals/citas/lib/providers-client.ts";
import { persistCitasSession, readPersistedCitasSession } from "../src/verticals/citas/lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../src/verticals/citas/lib/auth-client.ts";

function fakeLocalStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return {
    setItem: (k, v) => void map.set(k, v),
    getItem: (k) => map.get(k) ?? null,
    removeItem: (k) => void map.delete(k),
  };
}

const ORIGINAL: LoginSession = { token: "tok-viejo", refreshToken: "refresh-viejo", email: "staff@clinica.mx", organizations: [] };
const REFRESHED: LoginSession = { token: "tok-nuevo", refreshToken: "refresh-nuevo", email: "staff@clinica.mx", organizations: [] };

describe("citas/lib/providers-client.ts::requestGoogleCalendarConnectUrl — refresh automático ante 401 (camino por defecto, vía globalThis.localStorage)", () => {
  let storage: SessionStorageLike;
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

  beforeEach(() => {
    storage = fakeLocalStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    persistCitasSession(storage, ORIGINAL);
  });

  afterEach(() => {
    if (originalLocalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
  });

  it("un 401 dispara POST /auth/refresh, reintenta con el token nuevo y deja la sesión NUEVA en localStorage", async () => {
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
      return new Response(JSON.stringify({ authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" }), { status: 200 });
    }) as unknown as typeof fetch;

    const url = await requestGoogleCalendarConnectUrl(fetchImpl, "http://api.local", "tok-viejo", "prop-1", "prov-1");

    expect(url).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=x");
    expect(calls).toEqual([
      "http://api.local/v1/citas/properties/prop-1/providers/prov-1/google-calendar/connect",
      "http://api.local/auth/refresh",
      "http://api.local/v1/citas/properties/prop-1/providers/prov-1/google-calendar/connect",
    ]);
    expect(readPersistedCitasSession(storage)).toEqual(REFRESHED);
  });

  it("refresh fallido -> limpia la sesión de localStorage (Proveedores.tsx/Configuracion.tsx la vuelven a leer como null y redirigen a login)", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.local/auth/refresh") return new Response(JSON.stringify({ message: "Refresh token inválido." }), { status: 401 });
      return new Response(JSON.stringify({ message: "jwt expired" }), { status: 401 });
    }) as unknown as typeof fetch;

    await expect(requestGoogleCalendarConnectUrl(fetchImpl, "http://api.local", "tok-viejo", "prop-1", "prov-1")).rejects.toThrow(/expir/i);
    expect(readPersistedCitasSession(storage)).toBeNull();
  });
});
