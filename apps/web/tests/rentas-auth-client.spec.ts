import { describe, expect, it } from "vitest";
import { clearRentasSession, decideRentasLandingPath, persistRentasSession, readPersistedRentasSession } from "../src/verticals/rentas/lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../src/verticals/rentas/lib/auth-client.ts";

function fakeStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return {
    setItem: (k, v) => void map.set(k, v),
    getItem: (k) => map.get(k) ?? null,
    removeItem: (k) => void map.delete(k),
  };
}

describe("decideRentasLandingPath", () => {
  const base: LoginSession = { token: "t", refreshToken: "r", email: "a@b.com", organizations: [] };

  it("sin organizaciones -> /sin-organizacion", () => {
    expect(decideRentasLandingPath(base)).toBe("/sin-organizacion");
  });

  it("con exactamente una organización de rentas -> entra directo a su slug bajo /rentas/", () => {
    const session = { ...base, organizations: [{ id: "1", slug: "casas-del-mar", nombre: "Casas del Mar", vertical: "rentas", rol: "admin_gestora" }] };
    expect(decideRentasLandingPath(session)).toBe("/rentas/casas-del-mar");
  });

  it("staff con 2+ organizaciones (una empresa gestora que administra propiedades de más de un tenant) -> selector, nunca elige una arbitrariamente", () => {
    const org = { id: "1", slug: "a", nombre: "A", vertical: "rentas", rol: "admin_gestora" };
    expect(decideRentasLandingPath({ ...base, organizations: [org, { ...org, id: "2", slug: "b" }] })).toBe("/seleccionar-organizacion");
  });
});

describe("persistRentasSession / readPersistedRentasSession / clearRentasSession", () => {
  const session: LoginSession = { token: "t", refreshToken: "r", email: "admin@rentas.mx", organizations: [] };

  it("guarda y relee la sesión real (round-trip) bajo su propia llave", () => {
    const storage = fakeStorage();
    persistRentasSession(storage, session);
    expect(readPersistedRentasSession(storage)).toEqual(session);
    // La llave es distinta de la de hoteles/restaurantes -- las tres sesiones pueden
    // convivir en el mismo navegador sin pisarse.
    expect(storage.getItem("atiende.hoteles.session")).toBeNull();
    expect(storage.getItem("atiende.restaurantes.session")).toBeNull();
    expect(storage.getItem("atiende.rentas.session")).not.toBeNull();
  });

  it("null si no hay sesión guardada o el valor guardado está corrupto", () => {
    const storage = fakeStorage();
    expect(readPersistedRentasSession(storage)).toBeNull();
    storage.setItem("atiende.rentas.session", "{no es json valido");
    expect(readPersistedRentasSession(storage)).toBeNull();
  });

  it("clearRentasSession borra la sesión guardada", () => {
    const storage = fakeStorage();
    persistRentasSession(storage, session);
    clearRentasSession(storage);
    expect(readPersistedRentasSession(storage)).toBeNull();
  });
});
