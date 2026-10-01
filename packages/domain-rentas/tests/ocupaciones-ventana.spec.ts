// Rn-06 -- `listOcupacionesVentana` y la ventana `programadaDesde/Hasta` de `listTareas`. El adaptador en memoria no ejecuta
// SQL, así que `PostgresRentasRepository` se instancia REAL con una sesión falsa que CAPTURA SQL y parámetros: una regresión en
// la ventana (extremo exclusivo, canceladas, filtro de unidad, tope) truena aquí sin necesitar Postgres.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresRentasRepository } from "../src/postgres-repository.ts";

function sesion(filas: unknown[] = []): { session: TenantDbSession; calls: Array<{ sql: string; params: readonly unknown[] }> } {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  return {
    calls,
    session: {
      async query<T>(sql: string, params: unknown[] = []) {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return { rows: filas as T[] };
      },
      async exec() {},
    },
  };
}

describe("PostgresRentasRepository.listOcupacionesVentana", () => {
  it("excluye canceladas, usa el solape [) de daterange y pasa ventana, unidad y tope como parámetros", async () => {
    const { session, calls } = sesion();
    const repo = new PostgresRentasRepository(session);
    await repo.listOcupacionesVentana("prop-1", { desde: "2026-10-01", hasta: "2026-11-03", unidadId: "u-1", limit: 500 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("o.estado <> 'cancelado'");
    expect(calls[0]!.sql).toContain("o.rango && daterange($2::date, $3::date, '[)')");
    expect(calls[0]!.params).toEqual(["prop-1", "2026-10-01", "2026-11-03", "u-1", 500]);
  });

  it("sin unidad manda null (todas las unidades) y nunca selecciona el contacto del huésped", async () => {
    const { session, calls } = sesion();
    await new PostgresRentasRepository(session).listOcupacionesVentana("prop-1", { desde: "2026-10-01", hasta: "2026-11-03", limit: 10 });
    expect(calls[0]!.params[3]).toBeNull();
    expect(calls[0]!.sql).not.toContain("contacto");
  });

  it("mapea filas, devuelve el total real de la ventana y no expone contacto", async () => {
    const { session } = sesion([
      { id: "o1", unidad_id: "u-1", inicio: "2026-10-10", fin: "2026-10-12", capa: "reserva", razon: "RESERVA_CANAL", estado: "confirmado", canal_codigo: "airbnb", huesped_nombre: "Ana", created_at: "x", total: "7" },
    ]);
    const r = await new PostgresRentasRepository(session).listOcupacionesVentana("prop-1", { desde: "2026-10-01", hasta: "2026-11-03", limit: 1 });
    expect(r.total).toBe(7);
    expect(r.items).toEqual([
      { id: "o1", unidadId: "u-1", capa: "reserva", rango: { inicio: "2026-10-10", fin: "2026-10-12" }, razon: "RESERVA_CANAL", estado: "confirmado", canalCodigo: "airbnb", huespedNombre: "Ana", huespedContacto: null, createdAt: "x" },
    ]);
  });

  it("sin filas el total es 0", async () => {
    const r = await new PostgresRentasRepository(sesion().session).listOcupacionesVentana("prop-1", { desde: "2026-10-01", hasta: "2026-10-02", limit: 5 });
    expect(r).toEqual({ items: [], total: 0 });
  });
});

describe("PostgresRentasRepository.listTareas con ventana", () => {
  it("pasa programadaDesde/Hasta como fechas (o null) con comparación inclusiva", async () => {
    const { session, calls } = sesion();
    const repo = new PostgresRentasRepository(session);
    await repo.listTareas("prop-1", { programadaDesde: "2026-10-01", programadaHasta: "2026-10-31" });
    await repo.listTareas("prop-1");
    expect(calls[0]!.sql).toContain("t.programada_para >= $5::date");
    expect(calls[0]!.sql).toContain("t.programada_para <= $6::date");
    expect(calls[0]!.params.slice(4)).toEqual(["2026-10-01", "2026-10-31"]);
    expect(calls[1]!.params.slice(4)).toEqual([null, null]);
  });
});
