// CFO-04 · el subpath público `@atiende/domain-restaurantes/cfo` expone el dominio completo (y no ensucia el índice del paquete).
import { describe, expect, it } from "vitest";
import * as cfo from "@atiende/domain-restaurantes/cfo";
import * as raiz from "@atiende/domain-restaurantes";

describe("subpath ./cfo", () => {
  it("reexporta tipos de datos, fórmulas, consolidación, estado de resultados, segmentos, hallazgos, narrativa y normalizador de SR", () => {
    for (const nombre of [
      "CFO_CONFIG_POR_DEFECTO", "consolidar", "verificarAditividad", "consolidarClientes", "ticketPromedio", "ivaEstimado", "costoAgente", "margenContribucion", "cuadreSr",
      "construirEstadoResultados", "clasificarActividad", "esFrecuente", "detectarHallazgos", "ordenarHallazgos", "narrarResumen", "numerosNoRespaldados", "normalizarExportSr",
      "parsearMontoCentavos", "ALIAS_SR_INFERIDOS", "formatoCentavos", "cifra", "sinDato",
    ]) expect(cfo, nombre).toHaveProperty(nombre);
    expect(typeof cfo.consolidar).toBe("function");
  });
  it("el índice del paquete no se tocó: no exporta el CFO", () => {
    expect(raiz).not.toHaveProperty("construirEstadoResultados");
    expect(raiz).not.toHaveProperty("detectarHallazgos");
  });
});
