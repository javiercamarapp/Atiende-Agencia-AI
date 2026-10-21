// La API simulada del panel del operador no puede desviarse del contrato: `conContrato` rechaza (lanza) un cuerpo que no cumple el esquema.
import { describe, expect, it } from "vitest";
import { esquemaListoSalida } from "../../../packages/domain-restaurantes/src/operacion/contratos.ts";
import { conContrato, respuestaNoImplementada } from "../e2e/mock-api/fixtures/operacion-comun.ts";

describe("mock-api del panel del operador", () => {
  it("conContrato deja pasar un cuerpo valido y lanza con el campo culpable si no cumple", () => {
    expect(conContrato(esquemaListoSalida, { yaAplicado: false, listoAt: "2026-10-21T20:41:00.000Z" }).status).toBe(200);
    expect(() => conContrato(esquemaListoSalida, { yaAplicado: "no", listoAt: null })).toThrow(/yaAplicado/);
  });

  it("el 501 simulado es el mismo cuerpo que el del servidor real", () => {
    const r = respuestaNoImplementada();
    expect(r.status).toBe(501);
    expect(r.cuerpo).toMatchObject({ code: "no_implementado" });
  });
});
