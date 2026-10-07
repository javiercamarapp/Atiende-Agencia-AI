import { describe, expect, it } from "vitest";
import { calcularMatrizConectividad } from "../../src/canales/matriz.ts";
import type { FeedMonitorRecord } from "../../src/sync/monitor.ts";
import type { FeedTokenEstado } from "../../src/sync/tipos.ts";

const AHORA = Date.parse("2026-10-07T12:00:00Z");
const U1 = { id: "u1", nombre: "Suite 1" };
const U2 = { id: "u2", nombre: "Suite 2" };

function feed(parcial: Partial<FeedMonitorRecord> & Pick<FeedMonitorRecord, "unidadId" | "canalCodigo">): FeedMonitorRecord {
  return {
    id: `f-${parcial.unidadId}-${parcial.canalCodigo}`,
    unidadNombre: null,
    activo: true,
    ultimaSincronizacionExitosaEn: "2026-10-07T11:50:00Z",
    enCuarentenaDesde: null,
    intentosFallidosConsecutivos: 0,
    motivoCuarentena: null,
    ultimoIntentoEn: null,
    proximoIntentoEn: null,
    leaseHasta: null,
    ...parcial,
  };
}
function token(unidadId: string, canalCodigo: string, ultimoAccesoEn: string | null): FeedTokenEstado {
  return { tokenId: `t-${unidadId}-${canalCodigo}`, unidadId, canalId: `c-${canalCodigo}`, canalCodigo, creadoEn: "2026-10-01T00:00:00.000Z", ultimoAccesoEn };
}
const celda = (celdas: ReturnType<typeof calcularMatrizConectividad>, u: string, c: string) => celdas.find((x) => x.unidadId === u && x.canal === c)!;

describe("calcularMatrizConectividad", () => {
  it("genera una celda por unidad y canal; sin datos todo es sin_conectar", () => {
    const celdas = calcularMatrizConectividad({ unidades: [U1, U2], canales: ["airbnb", "vrbo", "booking"], feeds: [], tokens: [], ahoraMs: AHORA });
    expect(celdas).toHaveLength(6);
    expect(celdas.every((c) => c.estado === "sin_conectar" && c.import.estado === "sin_conectar" && c.export.estado === "sin_token")).toBe(true);
  });

  it("conectado = import sano + exportación consultada por la OTA", () => {
    const celdas = calcularMatrizConectividad({
      unidades: [U1],
      canales: ["airbnb"],
      feeds: [feed({ unidadId: "u1", canalCodigo: "airbnb" })],
      tokens: [token("u1", "airbnb", "2026-10-07T11:55:00.000Z")],
      ahoraMs: AHORA,
    });
    expect(celdas[0]).toMatchObject({ estado: "conectado", import: { estado: "ok" }, export: { estado: "consultado", ultimoAccesoEn: "2026-10-07T11:55:00.000Z" } });
  });

  it("solo import: el feed sincroniza pero la OTA nunca consultó nuestro token (o no hay token)", () => {
    const f = [feed({ unidadId: "u1", canalCodigo: "airbnb" })];
    expect(calcularMatrizConectividad({ unidades: [U1], canales: ["airbnb"], feeds: f, tokens: [token("u1", "airbnb", null)], ahoraMs: AHORA })[0]).toMatchObject({ estado: "solo_import", export: { estado: "token_sin_consulta" } });
    expect(calcularMatrizConectividad({ unidades: [U1], canales: ["airbnb"], feeds: f, tokens: [], ahoraMs: AHORA })[0]).toMatchObject({ estado: "solo_import", export: { estado: "sin_token" } });
  });

  it("solo export: la OTA consulta nuestro token pero no hay feed de import", () => {
    const celdas = calcularMatrizConectividad({ unidades: [U1], canales: ["vrbo"], feeds: [], tokens: [token("u1", "vrbo", "2026-10-07T11:00:00.000Z")], ahoraMs: AHORA });
    expect(celdas[0]).toMatchObject({ estado: "solo_export", import: { estado: "sin_conectar" } });
  });

  it("cuarentena y fallando tienen prioridad sobre el resto y traen su motivo real", () => {
    const celdas = calcularMatrizConectividad({
      unidades: [U1, U2],
      canales: ["airbnb"],
      feeds: [
        feed({ unidadId: "u1", canalCodigo: "airbnb", enCuarentenaDesde: "2026-10-07T08:00:00Z", motivoCuarentena: "3 intentos fallidos", intentosFallidosConsecutivos: 3 }),
        feed({ unidadId: "u2", canalCodigo: "airbnb", proximoIntentoEn: "2026-10-07T13:00:00Z", intentosFallidosConsecutivos: 1 }),
      ],
      tokens: [token("u1", "airbnb", "2026-10-07T11:55:00.000Z"), token("u2", "airbnb", "2026-10-07T11:55:00.000Z")],
      ahoraMs: AHORA,
    });
    expect(celda(celdas, "u1", "airbnb")).toMatchObject({ estado: "en_cuarentena", import: { motivoCuarentena: "3 intentos fallidos", intentosFallidosConsecutivos: 3 } });
    expect(celda(celdas, "u2", "airbnb")).toMatchObject({ estado: "fallando" });
  });

  it("un feed conectado que aún no sincroniza es `pendiente` (no se presenta como conectado)", () => {
    const celdas = calcularMatrizConectividad({ unidades: [U1], canales: ["airbnb"], feeds: [feed({ unidadId: "u1", canalCodigo: "airbnb", ultimaSincronizacionExitosaEn: null })], tokens: [], ahoraMs: AHORA });
    expect(celdas[0]).toMatchObject({ estado: "pendiente", import: { estado: "pendiente" } });
  });

  it("un feed desactualizado sigue contando como import, pero se declara desactualizado", () => {
    const celdas = calcularMatrizConectividad({
      unidades: [U1],
      canales: ["airbnb"],
      feeds: [feed({ unidadId: "u1", canalCodigo: "airbnb", ultimaSincronizacionExitosaEn: "2026-10-06T00:00:00Z" })],
      tokens: [],
      ahoraMs: AHORA,
    });
    expect(celdas[0]).toMatchObject({ estado: "solo_import", import: { estado: "desactualizado" } });
  });

  it("un feed desconectado (inactivo) es sin_conectar y no arrastra su estado viejo", () => {
    const celdas = calcularMatrizConectividad({ unidades: [U1], canales: ["airbnb"], feeds: [feed({ unidadId: "u1", canalCodigo: "airbnb", activo: false, intentosFallidosConsecutivos: 5 })], tokens: [], ahoraMs: AHORA });
    expect(celdas[0]).toMatchObject({ estado: "sin_conectar", import: { estado: "sin_conectar", intentosFallidosConsecutivos: 0, ultimaSincronizacionExitosaEn: null } });
  });

  it("sin la migración de tokens (tokens null) la exportación es `no_disponible_aun`, nunca un falso `sin_token`", () => {
    const celdas = calcularMatrizConectividad({ unidades: [U1], canales: ["airbnb"], feeds: [feed({ unidadId: "u1", canalCodigo: "airbnb" })], tokens: null, ahoraMs: AHORA });
    expect(celdas[0]).toMatchObject({ estado: "solo_import", export: { estado: "no_disponible_aun" } });
  });
});
