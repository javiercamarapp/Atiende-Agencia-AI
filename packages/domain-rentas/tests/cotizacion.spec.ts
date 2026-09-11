import { describe, expect, it } from "vitest";
import { calcularCotizacion, evaluarViolacionesMinStay } from "../src/pricing/cotizacion.ts";
import type { ContextoPricingUnidad } from "../src/pricing/tipos.ts";

function contexto(overrides: Partial<ContextoPricingUnidad> = {}): ContextoPricingUnidad {
  return {
    unidadId: "unidad-1",
    moneda: "MXN",
    precioBaseNocheCentavos: 100000, // $1,000.00/noche
    temporadas: [],
    descuentosDuracion: [],
    reglasMinStay: [],
    ...overrides,
  };
}

describe("calcularCotizacion", () => {
  it("suma el precio base noche a noche cuando no hay temporada", () => {
    const resultado = calcularCotizacion({ contexto: contexto(), rango: { inicio: "2026-06-01", fin: "2026-06-04" } });
    expect(resultado.noches).toBe(3);
    expect(resultado.subtotalAntesDescuentoCentavos).toBe(300000);
    expect(resultado.totalCentavos).toBe(300000);
    expect(resultado.desgloseNoches.every((n) => n.origen === "base")).toBe(true);
  });

  it("usa el precio de temporada para las noches que caen dentro de su rango", () => {
    const resultado = calcularCotizacion({
      contexto: contexto({ temporadas: [{ nombre: "Semana Santa", rango: { inicio: "2026-06-02", fin: "2026-06-03" }, precioNocheCentavos: 200000 }] }),
      rango: { inicio: "2026-06-01", fin: "2026-06-04" },
    });
    // Noches: 06-01 (base), 06-02 (temporada), 06-03 (base) -- el rango de
    // temporada [06-02, 06-03) cubre SOLO 06-02.
    expect(resultado.subtotalAntesDescuentoCentavos).toBe(100000 + 200000 + 100000);
    const nocheTemporada = resultado.desgloseNoches.find((n) => n.fecha === "2026-06-02")!;
    expect(nocheTemporada.origen).toBe("temporada");
    expect(nocheTemporada.temporadaNombre).toBe("Semana Santa");
  });

  it("aplica solo el descuento por duración de MAYOR umbral que se cumpla, nunca acumula varios", () => {
    const resultado = calcularCotizacion({
      contexto: contexto({
        descuentosDuracion: [
          { nochesMinimas: 7, porcentajeDescuentoBasisPoints: 1000, fuente: "semanal" },
          { nochesMinimas: 28, porcentajeDescuentoBasisPoints: 3000, fuente: "mensual" },
        ],
      }),
      rango: { inicio: "2026-06-01", fin: "2026-07-01" }, // 30 noches -- cumple ambos umbrales
    });
    expect(resultado.noches).toBe(30);
    expect(resultado.descuentoAplicado!.nochesMinimas).toBe(28);
    expect(resultado.descuentoAplicado!.porcentajeDescuentoBasisPoints).toBe(3000);
  });

  it("sin cumplir ningún umbral de duración, no aplica descuento", () => {
    const resultado = calcularCotizacion({
      contexto: contexto({ descuentosDuracion: [{ nochesMinimas: 7, porcentajeDescuentoBasisPoints: 1000, fuente: "semanal" }] }),
      rango: { inicio: "2026-06-01", fin: "2026-06-04" }, // 3 noches
    });
    expect(resultado.descuentoAplicado).toBeNull();
  });

  it("aplica el markup de canal SOLO si la regla está activa", () => {
    const inactiva = calcularCotizacion({
      contexto: contexto(),
      rango: { inicio: "2026-06-01", fin: "2026-06-02" },
      reglaCanal: { canalCodigo: "airbnb", markupBasisPoints: 2000, activo: false },
    });
    expect(inactiva.markupCanalCentavos).toBe(0);

    const activa = calcularCotizacion({
      contexto: contexto(),
      rango: { inicio: "2026-06-01", fin: "2026-06-02" },
      reglaCanal: { canalCodigo: "airbnb", markupBasisPoints: 2000, activo: true },
    });
    expect(activa.markupCanalCentavos).toBe(20000); // 20% de 100000
    expect(activa.totalCentavos).toBe(120000);
  });

  it("un precio/total inyectado en la entrada es estructuralmente imposible: EntradaCotizacion no acepta ese campo", () => {
    // El motor recalcula todo desde precioBaseNocheCentavos/temporadas — no existe
    // ningún camino para que un llamador pase un total ya calculado.
    const resultado = calcularCotizacion({ contexto: contexto(), rango: { inicio: "2026-06-01", fin: "2026-06-02" } });
    expect(resultado.totalCentavos).toBe(100000);
  });

  it("lanza si el rango de cotización no cubre ninguna noche", () => {
    expect(() => calcularCotizacion({ contexto: contexto(), rango: { inicio: "2026-06-01", fin: "2026-06-01" } })).toThrow();
  });
});

describe("evaluarViolacionesMinStay", () => {
  it("informa una violación cuando las noches solicitadas son menos que el mínimo de la regla vigente", () => {
    const violaciones = evaluarViolacionesMinStay(
      [{ rango: { inicio: "2026-12-20", fin: "2027-01-05" }, diaSemanaCheckIn: null, nochesMinimas: 5 }],
      { inicio: "2026-12-24", fin: "2026-12-26" },
      2,
    );
    expect(violaciones).toHaveLength(1);
    expect(violaciones[0]!.regla.nochesMinimas).toBe(5);
  });

  it("nunca bloquea el cálculo -- es informativo, se puede leer junto a un total ya calculado", () => {
    const resultado = calcularCotizacion({
      contexto: contexto({ reglasMinStay: [{ rango: { inicio: "2026-12-01", fin: "2027-01-01" }, diaSemanaCheckIn: null, nochesMinimas: 5 }] }),
      rango: { inicio: "2026-12-10", fin: "2026-12-12" }, // 2 noches, viola min-stay de 5
    });
    expect(resultado.violacionesMinStay).toHaveLength(1);
    expect(resultado.totalCentavos).toBe(200000); // el precio se calcula igual
  });

  it("solo filtra por día de la semana de check-in cuando la regla lo especifica", () => {
    // 2026-06-01 es lunes (1); una regla que exige viernes (5) no debe aplicar.
    const violaciones = evaluarViolacionesMinStay([{ rango: { inicio: "2026-06-01", fin: "2026-06-10" }, diaSemanaCheckIn: 5, nochesMinimas: 3 }], { inicio: "2026-06-01", fin: "2026-06-02" }, 1);
    expect(violaciones).toHaveLength(0);
  });
});
