import { describe, expect, it } from "vitest";
import { clearDespachosSession, decideDespachosLandingPath, persistDespachosSession, readPersistedDespachosSession } from "../src/verticals/despachos/lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../src/verticals/despachos/lib/auth-client.ts";

function fakeStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return {
    setItem: (k, v) => void map.set(k, v),
    getItem: (k) => map.get(k) ?? null,
    removeItem: (k) => void map.delete(k),
  };
}

describe("decideDespachosLandingPath", () => {
  const base: LoginSession = { token: "t", refreshToken: "r", email: "a@b.com", organizations: [] };

  it("sin organizaciones -> /sin-organizacion", () => {
    expect(decideDespachosLandingPath(base)).toBe("/sin-organizacion");
  });

  it("con exactamente un despacho -> entra directo a su slug bajo /despachos/", () => {
    const session = { ...base, organizations: [{ id: "1", slug: "despacho-abc", nombre: "Despacho ABC", vertical: "despachos", rol: "contador" }] };
    expect(decideDespachosLandingPath(session)).toBe("/despachos/despacho-abc");
  });

  it("staff con 2+ organizaciones -> selector, nunca elige una arbitrariamente", () => {
    const org = { id: "1", slug: "a", nombre: "A", vertical: "despachos", rol: "admin" };
    expect(decideDespachosLandingPath({ ...base, organizations: [org, { ...org, id: "2", slug: "b" }] })).toBe("/seleccionar-organizacion");
  });
});

describe("persistDespachosSession / readPersistedDespachosSession / clearDespachosSession", () => {
  const session: LoginSession = { token: "t", refreshToken: "r", email: "contador@despacho.mx", organizations: [] };

  it("guarda y relee la sesión real (round-trip) bajo su propia llave", () => {
    const storage = fakeStorage();
    persistDespachosSession(storage, session);
    expect(readPersistedDespachosSession(storage)).toEqual(session);
    // La llave es distinta de la de hoteles/restaurantes -- las sesiones pueden
    // convivir en el mismo navegador sin pisarse.
    expect(storage.getItem("atiende.hoteles.session")).toBeNull();
    expect(storage.getItem("atiende.restaurantes.session")).toBeNull();
    expect(storage.getItem("atiende.despachos.session")).not.toBeNull();
  });

  it("null si no hay sesión guardada o el valor guardado está corrupto", () => {
    const storage = fakeStorage();
    expect(readPersistedDespachosSession(storage)).toBeNull();
    storage.setItem("atiende.despachos.session", "{no es json valido");
    expect(readPersistedDespachosSession(storage)).toBeNull();
  });

  it("clearDespachosSession borra la sesión guardada", () => {
    const storage = fakeStorage();
    persistDespachosSession(storage, session);
    clearDespachosSession(storage);
    expect(readPersistedDespachosSession(storage)).toBeNull();
  });
});
