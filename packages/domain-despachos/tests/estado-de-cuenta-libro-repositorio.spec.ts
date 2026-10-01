// Libro de movimientos importados (D-03, migración 015): repositorio en memoria y adaptador de
// Postgres. El fallback contra la base SIN migrar se prueba con AbortAwareFakeSession (reproduce
// 25P02; una sesión falsa plana NO sirve para probar el SAVEPOINT).
import { describe, expect, it } from "vitest";
import { InMemoryDespachosRepository } from "../src/in-memory-repository.ts";
import { PostgresDespachosRepository } from "../src/postgres-repository.ts";
import { leerFuenteOpcional } from "../src/dashboard/lectura.ts";
import { parsearEstadoDeCuenta } from "../src/conciliacion/estado-de-cuenta/index.ts";
import type { NuevoLoteEstadoCuenta } from "../src/conciliacion/estado-de-cuenta/types.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function lote(csv: string, propertyId = "prop-1", loteId = "lote-1"): NuevoLoteEstadoCuenta {
  const p = parsearEstadoDeCuenta(csv, { cuenta: "012180000123456782", banco: "bbva" });
  return {
    organizationId: "org-1",
    propertyId,
    loteId,
    movimientos: p.movimientos.map((m) => ({ hash: m.hash, cuenta: p.cuenta, banco: p.banco, formato: p.formato, fecha: m.fecha, descripcion: m.descripcion, referencia: m.referencia, cargo: m.cargo, abono: m.abono, monto: m.monto, saldo: m.saldo, renglon: m.renglon })),
  };
}

const CSV = "Fecha,Descripción,Cargo,Abono\n05/01/2026,SPEI ACME,,100.00\n06/01/2026,PAGO,40.00,\n";
const CSV_TRASLAPADO = "Fecha,Descripción,Cargo,Abono\n06/01/2026,PAGO,40.00,\n07/01/2026,NUEVO,,5.00\n";

describe("libro de estados de cuenta -- repositorio en memoria", () => {
  it("idempotente: re-subir el mismo archivo no duplica; un periodo traslapado solo agrega lo nuevo", async () => {
    const repo = new InMemoryDespachosRepository();
    expect(await repo.insertEstadoCuentaMovimientos(lote(CSV))).toEqual({ loteId: "lote-1", insertados: 2, yaExistentes: 0 });
    expect(await repo.insertEstadoCuentaMovimientos(lote(CSV, "prop-1", "lote-2"))).toEqual({ loteId: "lote-2", insertados: 0, yaExistentes: 2 });
    expect(await repo.insertEstadoCuentaMovimientos(lote(CSV_TRASLAPADO, "prop-1", "lote-3"))).toMatchObject({ insertados: 1, yaExistentes: 1 });
  });

  it("la huella es por property: el mismo movimiento en otro cliente del despacho sí se guarda", async () => {
    const repo = new InMemoryDespachosRepository();
    await repo.insertEstadoCuentaMovimientos(lote(CSV, "prop-1"));
    expect((await repo.insertEstadoCuentaMovimientos(lote(CSV, "prop-2"))).insertados).toBe(2);
    const hashes = lote(CSV).movimientos.map((m) => m.hash);
    expect((await repo.listEstadoCuentaHashesExistentes("prop-1", hashes)).size).toBe(2);
    expect((await repo.listEstadoCuentaHashesExistentes("prop-3", hashes)).size).toBe(0);
  });
});

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("libro de estados de cuenta -- adaptador de Postgres", () => {
  it("insert: usa on conflict (property_id, hash) do nothing con jsonb_to_recordset y cuenta lo insertado con returning", async () => {
    const sqls: string[] = [];
    const params: unknown[][] = [];
    const session = {
      calls: [] as string[],
      async query<T>(sql: string, p?: unknown[]) {
        sqls.push(sql);
        params.push(p ?? []);
        return { rows: [{ hash: "h1" }] as unknown as T[] }; // 1 de 2 insertado: el otro ya existía
      },
      async exec() {},
    };
    const repo = new PostgresDespachosRepository(session as never);
    const r = await repo.insertEstadoCuentaMovimientos(lote(CSV));
    expect(r).toEqual({ loteId: "lote-1", insertados: 1, yaExistentes: 1 });
    expect(sqls[0]).toMatch(/on conflict \(property_id, hash\) do nothing/i);
    expect(sqls[0]).toMatch(/jsonb_to_recordset\(\$4::jsonb\)/);
    expect(params[0]!.slice(0, 3)).toEqual(["org-1", "prop-1", "lote-1"]);
    expect(JSON.parse(params[0]![3] as string)).toHaveLength(2);
  });

  it("lote vacío: no toca la base", async () => {
    const session = new AbortAwareFakeSession([]);
    const r = await new PostgresDespachosRepository(session).insertEstadoCuentaMovimientos({ organizationId: "o", propertyId: "p", loteId: "l", movimientos: [] });
    expect(r).toEqual({ loteId: "l", insertados: 0, yaExistentes: 0 });
    expect(session.calls).toEqual([]);
  });

  it("BASE SIN MIGRAR (42P01) al LEER hashes: queda null y la transacción abortada se recupera con SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([{ match: /from despachos\.estado_cuenta_movimiento/i, respond: () => pgError("42P01", 'relation "despachos.estado_cuenta_movimiento" does not exist') }]);
    const repo = new PostgresDespachosRepository(session);
    expect(await leerFuenteOpcional(repo, () => repo.listEstadoCuentaHashesExistentes("prop-1", ["a".repeat(64)]))).toBeNull();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1;")).rejects.not.toMatchObject({ code: "25P02" });
  });

  it("BASE SIN MIGRAR (42P01) al GUARDAR: null (la ruta responde 503) y la sesión sigue utilizable para el COMMIT", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into despachos\.estado_cuenta_movimiento/i, respond: () => pgError("42P01", 'relation "despachos.estado_cuenta_movimiento" does not exist') }]);
    const repo = new PostgresDespachosRepository(session);
    expect(await leerFuenteOpcional(repo, () => repo.insertEstadoCuentaMovimientos(lote(CSV)))).toBeNull();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1;")).rejects.not.toMatchObject({ code: "25P02" });
  });

  it("un error real al guardar (RLS 42501) se repropaga: nunca se enmascara como 'no disponible'", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into despachos\.estado_cuenta_movimiento/i, respond: () => pgError("42501", "new row violates row-level security policy") }]);
    const repo = new PostgresDespachosRepository(session);
    await expect(leerFuenteOpcional(repo, () => repo.insertEstadoCuentaMovimientos(lote(CSV)))).rejects.toMatchObject({ code: "42501" });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });
});
