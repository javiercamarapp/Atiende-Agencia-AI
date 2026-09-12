// Tests de dominio de `migrador.ts` — guardias de cardinalidad REQ-MIG-008,
// transiciones de estado REQ-MIG-007, y migración de póliza todo-o-nada REQ-MIG-010.
import { describe, expect, it } from "vitest";
import { aprobarMapeo, rechazarMapeo, editarMapeo, seleccionarMapeosActivosPorOrigen, migrarPoliza } from "../src/migracion-catalogo/migrador.ts";
import { DecisionSinResponsableError, DivisionUnoANoAutomaticaError, EstrategiaConciliacionRequeridaError, TransicionEstadoInvalidaError } from "../src/migracion-catalogo/types.ts";
import type { MapeoMigracionCuenta } from "../src/migracion-catalogo/types.ts";

function mapeo(overrides: Partial<MapeoMigracionCuenta> = {}): MapeoMigracionCuenta {
  return {
    id: "m1",
    organizationId: "org1",
    propertyId: "prop1",
    origenCuentaId: "o1",
    destinoCuentaId: "d1",
    tipoMatch: "fuzzy",
    score: 85,
    estado: "pendiente",
    aprobadoPor: null,
    aprobadoEn: null,
    nota: null,
    estrategiaConciliacionSaldos: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("aprobarMapeo", () => {
  it("decididoPor vacío -> DecisionSinResponsableError", () => {
    expect(() => aprobarMapeo(mapeo(), "", {}, [])).toThrow(DecisionSinResponsableError);
  });

  it("mapeo no pendiente -> TransicionEstadoInvalidaError", () => {
    expect(() => aprobarMapeo(mapeo({ estado: "aprobado" }), "juan", {}, [])).toThrow(TransicionEstadoInvalidaError);
  });

  it("aprueba correctamente un mapeo pendiente sin conflictos de cardinalidad", () => {
    const resultado = aprobarMapeo(mapeo(), "juan", { nota: "revisado" }, []);
    expect(resultado.estado).toBe("aprobado");
    expect(resultado.aprobadoPor).toBe("juan");
    expect(resultado.nota).toBe("revisado");
  });

  it("1:N — origen ya activo hacia OTRO destino -> DivisionUnoANoAutomaticaError, sin excepción", () => {
    const otro = mapeo({ id: "m2", origenCuentaId: "o1", destinoCuentaId: "d2", estado: "aprobado" });
    expect(() => aprobarMapeo(mapeo({ destinoCuentaId: "d1" }), "juan", {}, [otro])).toThrow(DivisionUnoANoAutomaticaError);
  });

  it("N:1 — otro origen ya activo hacia el MISMO destino, sin estrategia -> EstrategiaConciliacionRequeridaError", () => {
    const otro = mapeo({ id: "m2", origenCuentaId: "o2", destinoCuentaId: "d1", estado: "aprobado" });
    expect(() => aprobarMapeo(mapeo({ destinoCuentaId: "d1" }), "juan", {}, [otro])).toThrow(EstrategiaConciliacionRequeridaError);
  });

  it("N:1 — con estrategiaConciliacionSaldos provista -> se permite", () => {
    const otro = mapeo({ id: "m2", origenCuentaId: "o2", destinoCuentaId: "d1", estado: "aprobado" });
    const resultado = aprobarMapeo(mapeo({ destinoCuentaId: "d1" }), "juan", { estrategiaConciliacionSaldos: "prorratear por antigüedad" }, [otro]);
    expect(resultado.estado).toBe("aprobado");
    expect(resultado.estrategiaConciliacionSaldos).toBe("prorratear por antigüedad");
  });

  it("mapeos rechazados nunca cuentan para cardinalidad", () => {
    const otro = mapeo({ id: "m2", origenCuentaId: "o1", destinoCuentaId: "d2", estado: "rechazado" });
    const resultado = aprobarMapeo(mapeo({ destinoCuentaId: "d1" }), "juan", {}, [otro]);
    expect(resultado.estado).toBe("aprobado");
  });
});

describe("rechazarMapeo", () => {
  it("nota vacía -> Error explícito", () => {
    expect(() => rechazarMapeo(mapeo(), "juan", "")).toThrow();
  });

  it("rechaza correctamente, nunca corre guardia de cardinalidad", () => {
    const resultado = rechazarMapeo(mapeo(), "juan", "no corresponde");
    expect(resultado.estado).toBe("rechazado");
    expect(resultado.nota).toBe("no corresponde");
  });
});

describe("editarMapeo", () => {
  it("permite corregir destinoCuentaId con nota obligatoria", () => {
    const resultado = editarMapeo(mapeo(), "juan", "d999", "corrigiendo destino incorrecto", []);
    expect(resultado.destinoCuentaId).toBe("d999");
    expect(resultado.estado).toBe("editado");
  });

  it("corre la guardia de cardinalidad contra el destino EDITADO, no el original", () => {
    const otro = mapeo({ id: "m2", origenCuentaId: "o2", destinoCuentaId: "d999", estado: "aprobado" });
    expect(() => editarMapeo(mapeo(), "juan", "d999", "nota", [otro])).toThrow(EstrategiaConciliacionRequeridaError);
  });
});

describe("seleccionarMapeosActivosPorOrigen — gap del origen escrito explícitamente", () => {
  it("selecciona el mapeo NO rechazado más reciente por origen", () => {
    const m1 = mapeo({ id: "a", origenCuentaId: "o1", updatedAt: "2025-01-01T00:00:00.000Z" });
    const m2 = mapeo({ id: "b", origenCuentaId: "o1", updatedAt: "2025-02-01T00:00:00.000Z" });
    const seleccion = seleccionarMapeosActivosPorOrigen([m1, m2]);
    expect(seleccion.get("o1")!.id).toBe("b");
  });

  it("excluye mapeos rechazados aunque sean los más recientes", () => {
    const m1 = mapeo({ id: "a", origenCuentaId: "o1", updatedAt: "2025-01-01T00:00:00.000Z" });
    const m2 = mapeo({ id: "b", origenCuentaId: "o1", updatedAt: "2025-02-01T00:00:00.000Z", estado: "rechazado" });
    const seleccion = seleccionarMapeosActivosPorOrigen([m1, m2]);
    expect(seleccion.get("o1")!.id).toBe("a");
  });
});

describe("migrarPoliza — todo o nada, idempotente", () => {
  const poliza = { polizaId: "p1", fecha: "2025-01-01", lineas: [{ cuentaOrigenId: "o1", debe: 1000, haber: 0 }, { cuentaOrigenId: "o2", debe: 0, haber: 1000 }] };

  it("ya migrada -> idempotente, no reinserta líneas", () => {
    const { resultado, lineasAInsertar } = migrarPoliza(poliza, new Map(), true);
    expect(resultado.yaMigrada).toBe(true);
    expect(resultado.migrada).toBe(true);
    expect(lineasAInsertar).toHaveLength(0);
  });

  it("UNA línea sin mapeo migrable -> póliza ENTERA bloqueada, cero líneas escritas", () => {
    const mapeos = new Map([["o1", mapeo({ origenCuentaId: "o1", destinoCuentaId: "D1", estado: "aprobado" })]]);
    // o2 no tiene mapeo -> bloqueada
    const { resultado, lineasAInsertar } = migrarPoliza(poliza, mapeos, false);
    expect(resultado.bloqueada).toBe(true);
    expect(resultado.cuentasSinMapeoAprobado).toEqual(["o2"]);
    expect(lineasAInsertar).toHaveLength(0);
  });

  it("todas las líneas con mapeo aprobado/editado -> migra completa", () => {
    const mapeos = new Map([
      ["o1", mapeo({ origenCuentaId: "o1", destinoCuentaId: "D1", estado: "aprobado" })],
      ["o2", mapeo({ origenCuentaId: "o2", destinoCuentaId: "D2", estado: "editado" })],
    ]);
    const { resultado, lineasAInsertar } = migrarPoliza(poliza, mapeos, false);
    expect(resultado.migrada).toBe(true);
    expect(resultado.bloqueada).toBe(false);
    expect(lineasAInsertar).toHaveLength(2);
    expect(lineasAInsertar[0]!.cuentaDestinoId).toBe("D1");
    expect(lineasAInsertar[1]!.cuentaDestinoId).toBe("D2");
  });

  it("mapeo pendiente (no aprobado/editado) NO cuenta como migrable", () => {
    const mapeos = new Map([
      ["o1", mapeo({ origenCuentaId: "o1", destinoCuentaId: "D1", estado: "pendiente" })],
      ["o2", mapeo({ origenCuentaId: "o2", destinoCuentaId: "D2", estado: "aprobado" })],
    ]);
    const { resultado } = migrarPoliza(poliza, mapeos, false);
    expect(resultado.bloqueada).toBe(true);
    expect(resultado.cuentasSinMapeoAprobado).toEqual(["o1"]);
  });
});
