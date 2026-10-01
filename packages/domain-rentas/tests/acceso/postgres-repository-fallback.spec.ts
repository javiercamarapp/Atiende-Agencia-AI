// La sesión del request es UNA transacción: contra una base sin la migración 025 el error
// 42P01/42883 la deja abortada (25P02). AbortAwareFakeSession reproduce ese estado; el
// repositorio debe degradar bajo SAVEPOINT y dejar la sesión utilizable.
import { describe, expect, it } from "vitest";
import { PostgresRentasAccesoRepository } from "../../src/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

function pgError(code: string): Error & { code: string } {
  // 42883 solo cuenta como "migración pendiente" si el mensaje es de función inexistente.
  const message = code === "42883" ? "function rentas.confirmar_pago_reserva(uuid, boolean) does not exist" : `pg ${code}`;
  return Object.assign(new Error(message), { code });
}

describe("PostgresRentasAccesoRepository (staff) sobre base sin migrar", () => {
  for (const code of ["42P01", "42703", "42883"]) {
    it(`obtenerPolitica degrada a disponible:false (${code}) y la sesión sigue utilizable`, async () => {
      const db = new AbortAwareFakeSession([
        { match: /from rentas\.acceso_politica/, respond: () => pgError(code) },
        { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] },
      ]);
      const repo = new PostgresRentasAccesoRepository(db);
      expect(await repo.obtenerPolitica("p1")).toEqual({ disponible: false });
      expect(db.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
      // una consulta posterior en la MISMA sesión no falla con 25P02
      await expect(db.query("select 1 as vivo")).resolves.toEqual({ rows: [{ vivo: 1 }] });
    });
  }

  it("guardarInstruccion, obtenerInstruccion y listarBitacora también degradan", async () => {
    const db = new AbortAwareFakeSession([
      { match: /from rentas\.unidad/, respond: () => [{ "?column?": 1 }] },
      { match: /rentas\.acceso_instruccion/, respond: () => pgError("42P01") },
      { match: /rentas\.acceso_bitacora/, respond: () => pgError("42P01") },
      { match: /left join rentas\.acceso_reserva/, respond: () => pgError("42P01") },
    ]);
    const repo = new PostgresRentasAccesoRepository(db);
    expect(await repo.obtenerInstruccion("p1", "u1")).toEqual({ disponible: false });
    expect(await repo.guardarInstruccion("o1", "p1", "u1", { direccionExacta: "x", codigoAcceso: null, instrucciones: null }, "a1")).toEqual({ disponible: false });
    expect(await repo.listarBitacora("p1", 10)).toEqual({ disponible: false });
    expect(await repo.listarReservasProximas("p1", 10)).toEqual({ disponible: false });
  });

  it("confirmarPago distingue 'no existe' (P0002) de 'migración pendiente' y no deja la sesión abortada", async () => {
    const dbNoExiste = new AbortAwareFakeSession([{ match: /confirmar_pago_reserva/, respond: () => pgError("P0002") }, { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] }]);
    expect(await new PostgresRentasAccesoRepository(dbNoExiste).confirmarPago("o1", true)).toBe("no_encontrada");
    await expect(dbNoExiste.query("select 1 as vivo")).resolves.toBeDefined();
    const dbSinMigrar = new AbortAwareFakeSession([{ match: /confirmar_pago_reserva/, respond: () => pgError("42883") }]);
    expect(await new PostgresRentasAccesoRepository(dbSinMigrar).confirmarPago("o1", true)).toBe("no_disponible");
  });

  it("un error que no es de migración (p. ej. 40P01) se propaga, no se enmascara", async () => {
    const db = new AbortAwareFakeSession([{ match: /from rentas\.acceso_politica/, respond: () => pgError("40P01") }]);
    await expect(new PostgresRentasAccesoRepository(db).obtenerPolitica("p1")).rejects.toMatchObject({ code: "40P01" });
  });

  it("camino normal: mapea la política", async () => {
    const db = new AbortAwareFakeSession([{ match: /from rentas\.acceso_politica/, respond: () => [{ property_id: "p1", activo: true, horas_antes_checkin: 24, hora_checkin: "15:00", exigir_pago: true, ota_cuenta_como_pagada: true }] }]);
    expect(await new PostgresRentasAccesoRepository(db).obtenerPolitica("p1")).toEqual({ disponible: true, valor: { propertyId: "p1", activo: true, horasAntesCheckin: 24, horaCheckin: "15:00", exigirPago: true, otaCuentaComoPagada: true } });
  });
});
