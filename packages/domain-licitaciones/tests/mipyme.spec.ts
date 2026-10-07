// REQ-109: estratificacion MIPyME. Los casos frontera usan una ficha de PRUEBA con cifras conocidas (no la del registro),
// para que la prueba no dependa de la cifra capturada ni la "bendiga"; aparte se comprueba que la ficha real existe,
// esta sin verificar y que el resultado lo declara.
import { describe, expect, it } from "vitest";
import { fichaNormaPorId } from "../src/normas.ts";
import type { NormaFicha } from "../src/normas.ts";
import { decimalAEscala, estratificarMipyme, MIPYME_FICHA_ID } from "../src/mipyme.ts";

const real = fichaNormaPorId(MIPYME_FICHA_ID)!;
const fichaPrueba: NormaFicha = {
  ...real,
  parametros: {
    pesoTrabajadores: "0.10",
    pesoVentas: "0.90",
    estratos: [
      { estrato: "micro", porSector: { industria: { trabajadoresMax: 10, ventasMaxMdp: "4", topeCombinado: "4.6" }, comercio: { trabajadoresMax: 10, ventasMaxMdp: "4", topeCombinado: "4.6" }, servicios: { trabajadoresMax: 10, ventasMaxMdp: "4", topeCombinado: "4.6" } } },
      { estrato: "pequena", porSector: { industria: { trabajadoresMax: 50, ventasMaxMdp: "100", topeCombinado: "95" }, comercio: { trabajadoresMax: 30, ventasMaxMdp: "100", topeCombinado: "93" }, servicios: { trabajadoresMax: 50, ventasMaxMdp: "100", topeCombinado: "95" } } },
    ],
  },
};
const mdp = (n: number) => n * 100_000_000; // millones de pesos -> centavos

describe("estratificarMipyme (cifras de la ficha de prueba)", () => {
  it("frontera de micro: exactamente en el tope combinado cumple; un centavo mas pasa a pequena", () => {
    // 10 trabajadores x 0.10 + 3.999... ventas: con 10 trabajadores el puntaje es 1 + 0.9 * ventas; tope 4.6 -> ventas <= 4.0 mdp.
    expect(estratificarMipyme({ sector: "servicios", employeeCount: 10, annualSalesCents: mdp(4) }, fichaPrueba)).toMatchObject({ status: "calculado", estrato: "micro", puntajeCombinado: "4.6" });
    expect(estratificarMipyme({ sector: "servicios", employeeCount: 10, annualSalesCents: mdp(4) + 1 }, fichaPrueba)).toMatchObject({ estrato: "pequena" });
  });

  it("11 trabajadores salen de micro aunque las ventas sean minimas", () => {
    expect(estratificarMipyme({ sector: "industria", employeeCount: 11, annualSalesCents: 0 }, fichaPrueba)).toMatchObject({ estrato: "pequena", puntajeCombinado: "1.1" });
  });

  it("el sector cambia el tope de trabajadores de pequena: 31 en comercio ya no cabe, en industria si", () => {
    expect(estratificarMipyme({ sector: "comercio", employeeCount: 31, annualSalesCents: mdp(5) }, fichaPrueba)).toMatchObject({ estrato: "grande" });
    expect(estratificarMipyme({ sector: "industria", employeeCount: 31, annualSalesCents: mdp(5) }, fichaPrueba)).toMatchObject({ estrato: "pequena" });
  });

  it("frontera de ventas de pequena: 100 mdp cabe si el puntaje lo permite; un centavo mas es grande", () => {
    // 1 trabajador: puntaje = 0.1 + 0.9 * 100 = 90.1 <= 95
    expect(estratificarMipyme({ sector: "servicios", employeeCount: 1, annualSalesCents: mdp(100) }, fichaPrueba)).toMatchObject({ estrato: "pequena", puntajeCombinado: "90.1" });
    expect(estratificarMipyme({ sector: "servicios", employeeCount: 1, annualSalesCents: mdp(100) + 1 }, fichaPrueba)).toMatchObject({ estrato: "grande" });
  });

  it("el tope combinado puede excluir aunque trabajadores y ventas cumplan sus rangos", () => {
    // comercio, 30 trabajadores, 100 mdp: puntaje = 3 + 90 = 93 <= 93 cumple; 30 trabajadores con 100.00 mdp + 1 centavo ya no.
    expect(estratificarMipyme({ sector: "comercio", employeeCount: 30, annualSalesCents: mdp(100) }, fichaPrueba)).toMatchObject({ estrato: "pequena", puntajeCombinado: "93" });
    expect(estratificarMipyme({ sector: "comercio", employeeCount: 30, annualSalesCents: mdp(100) + 1 }, fichaPrueba)).toMatchObject({ estrato: "grande" });
  });

  it("dato ausente o invalido: no_evaluable con el motivo, nunca un estrato inventado", () => {
    for (const input of [
      { sector: null, employeeCount: 5, annualSalesCents: 10 },
      { sector: "servicios", employeeCount: null, annualSalesCents: 10 },
      { sector: "servicios", employeeCount: 5, annualSalesCents: null },
      { sector: "servicios", employeeCount: -1, annualSalesCents: 10 },
      { sector: "servicios", employeeCount: 2.5, annualSalesCents: 10 },
      { sector: "servicios", employeeCount: 5, annualSalesCents: -3 },
    ] as const) {
      const r = estratificarMipyme(input, fichaPrueba);
      expect(r.status).toBe("no_evaluable");
      expect("estrato" in r).toBe(false);
    }
    const r = estratificarMipyme({ sector: null, employeeCount: null, annualSalesCents: 1 }, fichaPrueba);
    expect(r.status === "no_evaluable" && r.faltan).toEqual(["sector", "numero de trabajadores"]);
  });

  it("acepta ventas como bigint y no pierde precision con cifras enormes", () => {
    expect(estratificarMipyme({ sector: "servicios", employeeCount: 1, annualSalesCents: 10n ** 15n }, fichaPrueba)).toMatchObject({ estrato: "grande" });
  });
});

describe("ficha real del registro", () => {
  it("existe, esta sin verificar y todo resultado lo declara (pendiente de verificacion legal)", () => {
    expect(real.estadoVerificacion).toBe("sin_verificar");
    expect(real.validarConAbogado).toBe(true);
    const r = estratificarMipyme({ sector: "servicios", employeeCount: 5, annualSalesCents: mdp(1) });
    expect(r).toMatchObject({ status: "calculado", verificacion: "sin_verificar", validarConAbogado: true, fichaId: MIPYME_FICHA_ID });
    const sinDato = estratificarMipyme({ sector: "servicios", employeeCount: null, annualSalesCents: 1 });
    expect(sinDato).toMatchObject({ status: "no_evaluable", verificacion: "sin_verificar", validarConAbogado: true });
  });

  it("las cifras viven en la ficha, no en el codigo de la funcion", () => {
    const sinParametros = { ...real, parametros: undefined } as NormaFicha;
    expect(() => estratificarMipyme({ sector: "servicios", employeeCount: 5, annualSalesCents: 1 }, sinParametros)).toThrow(/parametros/);
  });

  it("decimalAEscala rechaza cifras mal formadas de la ficha", () => {
    expect(decimalAEscala("4.6")).toBe(4_600_000_000n);
    expect(() => decimalAEscala("4,6")).toThrow();
    expect(() => decimalAEscala("-1")).toThrow();
  });
});
