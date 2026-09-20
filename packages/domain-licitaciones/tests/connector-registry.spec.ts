// Fase 5 pieza 1 — REQ-004/146/150.
import { describe, expect, it } from "vitest";
import { ConnectorRegistry, LICITACIONES_CONNECTOR_REGISTRY, SOURCE_CONNECTOR_IDS, isSourceConnectorId } from "../src/connector-registry.ts";
import type { SourceConnectorDescriptor } from "../src/connector-registry.ts";

describe("ConnectorRegistry (REQ-004: registro único de conectores)", () => {
  it("registra y recupera un conector por id", () => {
    const descriptor: SourceConnectorDescriptor = {
      id: "manual",
      kind: "manual",
      label: "x",
      termsNote: "x",
      cadence: { minIntervalMinutes: 0, note: "x" },
      liveVerification: { verified: true, note: "x" },
    };
    const registry = new ConnectorRegistry().register(descriptor);
    expect(registry.get("manual")).toEqual(descriptor);
    expect(registry.requireById("manual")).toEqual(descriptor);
  });

  it("requireById lanza si el conector no existe -- nunca devuelve undefined en silencio", () => {
    const registry = new ConnectorRegistry();
    expect(() => registry.requireById("comprasmx")).toThrow(/No hay conector registrado/);
  });

  it("register rechaza un id duplicado -- el registro es la ÚNICA fuente de verdad, nunca dos descriptores del mismo conector", () => {
    const descriptor: SourceConnectorDescriptor = {
      id: "manual",
      kind: "manual",
      label: "x",
      termsNote: "x",
      cadence: { minIntervalMinutes: 0, note: "x" },
      liveVerification: { verified: true, note: "x" },
    };
    const registry = new ConnectorRegistry().register(descriptor);
    expect(() => registry.register(descriptor)).toThrow(/Ya existe un conector registrado/);
  });

  it("all() devuelve una copia -- mutar el resultado no afecta al registro", () => {
    const registry = new ConnectorRegistry();
    const list = registry.all();
    list.push({ id: "dof", kind: "automated", label: "x", termsNote: "x", cadence: { minIntervalMinutes: 1, note: "x" }, liveVerification: { verified: false, note: "x" } });
    expect(registry.all()).toHaveLength(0);
  });
});

describe("LICITACIONES_CONNECTOR_REGISTRY (instancia real de producción)", () => {
  it("registra exactamente las 12 fuentes conocidas (ComprasMX/DOF/OCDS-SHCP/PDN-S6/portales estatales + histórico ComprasMX + manual + Fase 9: nl_ocds/cdmx_ocds/aggregator + Fase 13: yucatan_ocds/guadalajara_ocds)", () => {
    expect(LICITACIONES_CONNECTOR_REGISTRY.all().map((d) => d.id).sort()).toEqual([...SOURCE_CONNECTOR_IDS].sort());
  });

  it("REQ-150 (tolerancia cero): NINGÚN conector automatizado se declara verificado sin evidencia -- 'manual', 'nl_ocds', 'yucatan_ocds' y 'guadalajara_ocds' (evidencia real documentada) lo están", () => {
    const verified = LICITACIONES_CONNECTOR_REGISTRY.all().filter((d) => d.liveVerification.verified);
    expect(verified.map((d) => d.id).sort()).toEqual(["guadalajara_ocds", "manual", "nl_ocds", "yucatan_ocds"].sort());
  });

  it("Fase 8/9/13: 'compras_mx_historico', 'nl_ocds', 'cdmx_ocds', 'yucatan_ocds', 'guadalajara_ocds' y 'aggregator' tienen una implementación real (`connector` presente) -- los otros 4 siguen siendo placeholders sin `connector`", () => {
    const withConnector = LICITACIONES_CONNECTOR_REGISTRY.all().filter((d) => d.connector !== undefined);
    expect(withConnector.map((d) => d.id)).toEqual(["compras_mx_historico", "nl_ocds", "cdmx_ocds", "yucatan_ocds", "guadalajara_ocds", "aggregator"]);
  });

  it("REQ-146: cada conector automatizado declara una cadencia > 0 (nunca 'a demanda' salvo el manual)", () => {
    for (const descriptor of LICITACIONES_CONNECTOR_REGISTRY.all()) {
      if (descriptor.kind === "automated") expect(descriptor.cadence.minIntervalMinutes).toBeGreaterThan(0);
      if (descriptor.id === "manual") expect(descriptor.cadence.minIntervalMinutes).toBe(0);
    }
  });

  it("isSourceConnectorId distingue ids válidos de arbitrarios", () => {
    expect(isSourceConnectorId("manual")).toBe(true);
    expect(isSourceConnectorId("comprasmx")).toBe(true);
    expect(isSourceConnectorId("scraper-no-autorizado")).toBe(false);
  });
});
