import { describe, expect, it, vi } from "vitest";
import { clearHotelesSession, decideHotelesLandingPath, logout, persistHotelesSession, readPersistedHotelesSession } from "../src/verticals/hoteles/lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../src/verticals/hoteles/lib/auth-client.ts";

function fakeStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return {
    setItem: (k, v) => void map.set(k, v),
    getItem: (k) => map.get(k) ?? null,
    removeItem: (k) => void map.delete(k),
  };
}

describe("decideHotelesLandingPath", () => {
  const base: LoginSession = { token: "t", refreshToken: "r", email: "a@b.com", organizations: [] };

  it("sin organizaciones -> /sin-organizacion", () => {
    expect(decideHotelesLandingPath(base)).toBe("/sin-organizacion");
  });

  it("con exactamente un hotel -> entra directo a su slug bajo /hoteles/", () => {
    const session = { ...base, organizations: [{ id: "1", slug: "hotel-caribe", nombre: "Hotel Caribe", vertical: "hoteles", rol: "gm" }] };
    expect(decideHotelesLandingPath(session)).toBe("/hoteles/hotel-caribe");
  });

  it("staff con 2+ organizaciones (multi-hotel bajo distintas cadenas) -> selector, nunca elige una arbitrariamente", () => {
    const org = { id: "1", slug: "a", nombre: "A", vertical: "hoteles", rol: "owner" };
    expect(decideHotelesLandingPath({ ...base, organizations: [org, { ...org, id: "2", slug: "b" }] })).toBe("/seleccionar-organizacion");
  });
});

describe("persistHotelesSession / readPersistedHotelesSession / clearHotelesSession", () => {
  const session: LoginSession = { token: "t", refreshToken: "r", email: "gm@hotel.mx", organizations: [] };

  it("guarda y relee la sesión real (round-trip) bajo su propia llave", () => {
    const storage = fakeStorage();
    persistHotelesSession(storage, session);
    expect(readPersistedHotelesSession(storage)).toEqual(session);
    // La llave es distinta de la de restaurantes -- ambas sesiones pueden convivir en
    // el mismo navegador sin pisarse.
    expect(storage.getItem("atiende.restaurantes.session")).toBeNull();
    expect(storage.getItem("atiende.hoteles.session")).not.toBeNull();
  });

  it("null si no hay sesión guardada o el valor guardado está corrupto", () => {
    const storage = fakeStorage();
    expect(readPersistedHotelesSession(storage)).toBeNull();
    storage.setItem("atiende.hoteles.session", "{no es json valido");
    expect(readPersistedHotelesSession(storage)).toBeNull();
  });

  it("clearHotelesSession borra la sesión guardada", () => {
    const storage = fakeStorage();
    persistHotelesSession(storage, session);
    clearHotelesSession(storage);
    expect(readPersistedHotelesSession(storage)).toBeNull();
  });
});

// Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
// hoteles") — re-exporta el `logout` genérico (POST /auth/logout), usado por el botón
// nuevo de HotelesShell.tsx.
describe("logout (re-exportado de ../../../lib/auth-client.ts)", () => {
  it("llama POST /auth/logout con el refreshToken del hotel", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await logout(fetchImpl, "http://api.local", "refresh-de-hoteles");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.local/auth/logout",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ refreshToken: "refresh-de-hoteles" }) }),
    );
  });
});
