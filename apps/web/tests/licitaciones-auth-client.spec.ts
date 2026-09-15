import { describe, expect, it } from "vitest";
import { clearLicitacionesSession, decideLicitacionesLandingPath, persistLicitacionesSession, readPersistedLicitacionesSession } from "../src/verticals/licitaciones/lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../src/verticals/licitaciones/lib/auth-client.ts";

function fakeStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return {
    setItem: (k, v) => void map.set(k, v),
    getItem: (k) => map.get(k) ?? null,
    removeItem: (k) => void map.delete(k),
  };
}

describe("decideLicitacionesLandingPath", () => {
  const base: LoginSession = { token: "t", refreshToken: "r", email: "a@b.com", organizations: [] };

  it("sin organizaciones -> /sin-organizacion", () => {
    expect(decideLicitacionesLandingPath(base)).toBe("/sin-organizacion");
  });

  it("con exactamente una organización (el caso normal: property singleton, §2.1 del diseño) -> entra directo a su slug bajo /licitaciones/", () => {
    const session = { ...base, organizations: [{ id: "1", slug: "empresa-constructora", nombre: "Empresa Constructora S.A.", vertical: "licitaciones", rol: "analyst" }] };
    expect(decideLicitacionesLandingPath(session)).toBe("/licitaciones/empresa-constructora");
  });

  it("un usuario que participa en 2+ empresas distintas -> selector, nunca elige una arbitrariamente", () => {
    const org = { id: "1", slug: "a", nombre: "A", vertical: "licitaciones", rol: "owner" };
    expect(decideLicitacionesLandingPath({ ...base, organizations: [org, { ...org, id: "2", slug: "b" }] })).toBe("/seleccionar-organizacion");
  });
  // Hallazgo de auditoría (rubro 19, multi-organización, severidad MEDIA): el JWT es
  // el mismo mecanismo para las 6 verticales -- `session.organizations` puede traer
  // membresías de OTRAS verticales (un mismo correo con 1 empresa de licitaciones y 1
  // hotel).
  it("con 1 empresa de licitaciones + 1 organización de OTRA vertical -> entra directo, ignora la otra vertical", () => {
    const session = {
      ...base,
      organizations: [
        { id: "1", slug: "empresa-constructora", nombre: "Empresa Constructora S.A.", vertical: "licitaciones", rol: "analyst" },
        { id: "2", slug: "hotel-caribe", nombre: "Hotel Caribe", vertical: "hoteles", rol: "owner" },
      ],
    };
    expect(decideLicitacionesLandingPath(session)).toBe("/licitaciones/empresa-constructora");
  });
  it("con 0 empresas de licitaciones pero 1+ organización de otra vertical -> /sin-organizacion", () => {
    const session = { ...base, organizations: [{ id: "2", slug: "hotel-caribe", nombre: "Hotel Caribe", vertical: "hoteles", rol: "owner" }] };
    expect(decideLicitacionesLandingPath(session)).toBe("/sin-organizacion");
  });
});

describe("persistLicitacionesSession / readPersistedLicitacionesSession / clearLicitacionesSession", () => {
  const session: LoginSession = { token: "t", refreshToken: "r", email: "analyst@empresa.mx", organizations: [] };

  it("guarda y relee la sesión real (round-trip) bajo su propia llave", () => {
    const storage = fakeStorage();
    persistLicitacionesSession(storage, session);
    expect(readPersistedLicitacionesSession(storage)).toEqual(session);
    // La llave es distinta de la de hoteles/restaurantes -- las sesiones de
    // varias verticales pueden convivir en el mismo navegador sin pisarse.
    expect(storage.getItem("atiende.hoteles.session")).toBeNull();
    expect(storage.getItem("atiende.restaurantes.session")).toBeNull();
    expect(storage.getItem("atiende.licitaciones.session")).not.toBeNull();
  });

  it("null si no hay sesión guardada o el valor guardado está corrupto", () => {
    const storage = fakeStorage();
    expect(readPersistedLicitacionesSession(storage)).toBeNull();
    storage.setItem("atiende.licitaciones.session", "{no es json valido");
    expect(readPersistedLicitacionesSession(storage)).toBeNull();
  });

  it("clearLicitacionesSession borra la sesión guardada", () => {
    const storage = fakeStorage();
    persistLicitacionesSession(storage, session);
    clearLicitacionesSession(storage);
    expect(readPersistedLicitacionesSession(storage)).toBeNull();
  });
});
