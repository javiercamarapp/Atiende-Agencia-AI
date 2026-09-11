import { describe, expect, it } from "vitest";
import { clearCitasSession, decideCitasLandingPath, persistCitasSession, readPersistedCitasSession } from "../src/verticals/citas/lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../src/verticals/citas/lib/auth-client.ts";

function fakeStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return {
    setItem: (k, v) => void map.set(k, v),
    getItem: (k) => map.get(k) ?? null,
    removeItem: (k) => void map.delete(k),
  };
}

describe("decideCitasLandingPath", () => {
  const base: LoginSession = { token: "t", refreshToken: "r", email: "a@b.com", organizations: [] };

  it("sin organizaciones -> /sin-organizacion", () => {
    expect(decideCitasLandingPath(base)).toBe("/sin-organizacion");
  });

  it("con exactamente un negocio de citas -> entra directo a su slug bajo /citas/", () => {
    const session = { ...base, organizations: [{ id: "1", slug: "clinica-dental-sonrisas", nombre: "Clínica Dental Sonrisas", vertical: "citas", rol: "owner" }] };
    expect(decideCitasLandingPath(session)).toBe("/citas/clinica-dental-sonrisas");
  });

  it("staff con 2+ organizaciones -> selector, nunca elige una arbitrariamente", () => {
    const org = { id: "1", slug: "a", nombre: "A", vertical: "citas", rol: "owner" };
    expect(decideCitasLandingPath({ ...base, organizations: [org, { ...org, id: "2", slug: "b" }] })).toBe("/seleccionar-organizacion");
  });
});

describe("persistCitasSession / readPersistedCitasSession / clearCitasSession", () => {
  const session: LoginSession = { token: "t", refreshToken: "r", email: "owner@clinica.mx", organizations: [] };

  it("guarda y relee la sesión real (round-trip) bajo su propia llave, sin chocar con restaurantes/hoteles", () => {
    const storage = fakeStorage();
    persistCitasSession(storage, session);
    expect(readPersistedCitasSession(storage)).toEqual(session);
    expect(storage.getItem("atiende.restaurantes.session")).toBeNull();
    expect(storage.getItem("atiende.hoteles.session")).toBeNull();
    expect(storage.getItem("atiende.citas.session")).not.toBeNull();
  });

  it("null si no hay sesión guardada o el valor guardado está corrupto", () => {
    const storage = fakeStorage();
    expect(readPersistedCitasSession(storage)).toBeNull();
    storage.setItem("atiende.citas.session", "{no es json valido");
    expect(readPersistedCitasSession(storage)).toBeNull();
  });

  it("clearCitasSession borra la sesión guardada", () => {
    const storage = fakeStorage();
    persistCitasSession(storage, session);
    clearCitasSession(storage);
    expect(readPersistedCitasSession(storage)).toBeNull();
  });
});
