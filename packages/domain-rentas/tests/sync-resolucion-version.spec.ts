import { describe, expect, it } from "vitest";
import { resolverVersionEvento, type VersionEvento } from "../src/sync/resolucion-version.ts";

function v(overrides: Partial<VersionEvento>): VersionEvento {
  return { uid: "x@y", sequence: 1, dtstamp: "2026-01-01T00:00:00Z", hash: "h1", ...overrides };
}

describe("resolverVersionEvento", () => {
  it("aplica cuando no hay versión previa", () => {
    expect(resolverVersionEvento(null, v({})).accion).toBe("aplicar");
  });

  it("sin_cambio cuando el hash es idéntico, sin importar sequence/dtstamp", () => {
    const actual = v({ sequence: 5, dtstamp: "2026-01-05T00:00:00Z", hash: "igual" });
    const entrante = v({ sequence: 9, dtstamp: "2026-02-01T00:00:00Z", hash: "igual" });
    expect(resolverVersionEvento(actual, entrante).accion).toBe("sin_cambio");
  });

  it("aplica cuando SEQUENCE entrante es mayor", () => {
    const actual = v({ sequence: 1, hash: "a" });
    const entrante = v({ sequence: 2, hash: "b", dtstamp: "2026-01-02T00:00:00Z" });
    expect(resolverVersionEvento(actual, entrante).accion).toBe("aplicar");
  });

  it("descarta cuando SEQUENCE entrante es menor o igual (evento desordenado)", () => {
    const actual = v({ sequence: 5, hash: "a" });
    const entrante = v({ sequence: 3, hash: "b" });
    expect(resolverVersionEvento(actual, entrante).accion).toBe("descartar");
  });

  it("revisar_uid_reciclado cuando SEQUENCE es mayor pero DTSTAMP es anterior (caso adversarial: UID reciclado)", () => {
    const actual = v({ sequence: 1, dtstamp: "2026-05-01T00:00:00Z", hash: "a" });
    const entrante = v({ sequence: 2, dtstamp: "2026-01-01T00:00:00Z", hash: "b" });
    const r = resolverVersionEvento(actual, entrante);
    expect(r.accion).toBe("revisar_uid_reciclado");
  });

  it("aplica cuando SEQUENCE no es comparable (ausente) y DTSTAMP entrante es más reciente, con rango contiguo", () => {
    const actual = v({ sequence: null, dtstamp: "2026-01-01T00:00:00Z", hash: "a", rango: { inicio: "2026-01-01", fin: "2026-01-05" } });
    const entrante = v({ sequence: null, dtstamp: "2026-01-02T00:00:00Z", hash: "b", rango: { inicio: "2026-01-05", fin: "2026-01-08" } });
    expect(resolverVersionEvento(actual, entrante).accion).toBe("aplicar");
  });

  it("revisar_uid_reciclado cuando SEQUENCE no es comparable, DTSTAMP más reciente, pero el rango es completamente disjunto y no contiguo", () => {
    const actual = v({ sequence: null, dtstamp: "2026-01-01T00:00:00Z", hash: "a", rango: { inicio: "2026-01-01", fin: "2026-01-05" } });
    const entrante = v({ sequence: null, dtstamp: "2026-01-02T00:00:00Z", hash: "b", rango: { inicio: "2026-08-01", fin: "2026-08-05" } });
    expect(resolverVersionEvento(actual, entrante).accion).toBe("revisar_uid_reciclado");
  });

  it("no aplica la sospecha de rango disjunto cuando SEQUENCE SÍ es comparable (aunque igual)", () => {
    const actual = v({ sequence: 3, dtstamp: "2026-01-01T00:00:00Z", hash: "a", rango: { inicio: "2026-01-01", fin: "2026-01-05" } });
    const entrante = v({ sequence: 3, dtstamp: "2026-01-02T00:00:00Z", hash: "b", rango: { inicio: "2026-08-01", fin: "2026-08-05" } });
    expect(resolverVersionEvento(actual, entrante).accion).toBe("aplicar");
  });

  it("descarta cuando DTSTAMP entrante es más antiguo (sequence no comparable)", () => {
    const actual = v({ sequence: null, dtstamp: "2026-05-01T00:00:00Z", hash: "a" });
    const entrante = v({ sequence: null, dtstamp: "2026-01-01T00:00:00Z", hash: "b" });
    expect(resolverVersionEvento(actual, entrante).accion).toBe("descartar");
  });

  it("revisar_uid_reciclado cuando SEQUENCE y DTSTAMP son idénticos pero el hash difiere", () => {
    const actual = v({ sequence: 1, dtstamp: "2026-01-01T00:00:00Z", hash: "a" });
    const entrante = v({ sequence: 1, dtstamp: "2026-01-01T00:00:00Z", hash: "b" });
    expect(resolverVersionEvento(actual, entrante).accion).toBe("revisar_uid_reciclado");
  });

  it("lanza si los UIDs no coinciden — error de uso del llamador", () => {
    expect(() => resolverVersionEvento(v({ uid: "a" }), v({ uid: "b" }))).toThrowError();
  });
});
