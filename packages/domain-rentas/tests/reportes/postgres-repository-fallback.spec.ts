// La sesión es UNA transacción por request: si rentas.reserva_financiero no existe o no
// es legible, el error deja la transacción abortada (25P02) y la consulta de respaldo
// fallaría sin SAVEPOINT. AbortAwareFakeSession reproduce ese estado.
import { describe, expect, it } from "vitest";
import { PostgresRentasReportesRepository } from "../../src/reportes/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

function pgError(code: string): Error & { code: string } {
  const e = new Error(`pg ${code}`) as Error & { code: string };
  e.code = code;
  return e;
}

const filaReserva = { id: "o1", unidad_id: "u1", canal: "manual", inicio: "2026-03-10", fin: "2026-03-12", creada_en: "2026-01-01", moneda: null, bruto: null, comision_canal: null, comision_gestor: null, gastos: null, impuestos: null, neto: null };

function sesion(errorFinanciero: string | null) {
  return new AbortAwareFakeSession([
    { match: /from rentas\.property_config/, respond: () => [{ zona_horaria: "America/Merida", moneda: "MXN" }] },
    { match: /from rentas\.unidad u/, respond: () => [{ id: "u1", name: "Casa", owner_id: null, owner_name: null }] },
    {
      match: /left join rentas\.reserva_financiero/,
      respond: () => (errorFinanciero ? pgError(errorFinanciero) : [{ ...filaReserva, moneda: "MXN", bruto: "100000", comision_canal: "0", comision_gestor: "0", gastos: "0", impuestos: "0", neto: "100000" }]),
    },
    { match: /null::text as moneda/, respond: () => [filaReserva] },
  ]);
}

const periodo = { inicio: "2026-03-01", fin: "2026-04-01" };

describe("PostgresRentasReportesRepository", () => {
  it("camino normal: trae el movimiento financiero y la moneda de la property", async () => {
    const db = sesion(null);
    const datos = await new PostgresRentasReportesRepository(db).cargarDatosReporte("p1", periodo, {});
    expect(datos.financieroDisponible).toBe(true);
    expect(datos.moneda).toBe("MXN");
    expect(datos.reservas[0]!.financiero).toEqual(expect.objectContaining({ brutoCentavos: 100000 }));
  });

  for (const code of ["42P01", "42703", "42501"]) {
    it(`base sin migrar (${code}): degrada a solo noches bajo SAVEPOINT, sin dejar la transacción abortada`, async () => {
      const db = sesion(code);
      const datos = await new PostgresRentasReportesRepository(db).cargarDatosReporte("p1", periodo, {});
      expect(datos.financieroDisponible).toBe(false);
      expect(datos.reservas).toHaveLength(1);
      expect(datos.reservas[0]!.financiero).toBeNull();
      expect(db.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    });
  }

  it("un error que no es de migración pendiente se propaga (no se enmascara)", async () => {
    await expect(new PostgresRentasReportesRepository(sesion("40P01")).cargarDatosReporte("p1", periodo, {})).rejects.toMatchObject({ code: "40P01" });
  });
});
