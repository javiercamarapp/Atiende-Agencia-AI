// Andamiaje del panel del operador (PLAN-PANEL-OPERADOR §6): ya no queda ninguna pantalla stub (Cola, Nuevo pedido, Viajes y Turno son reales;
// Turno se prueba en operacion-turno.spec.tsx). Queda la garantia de que el interruptor del panel sigue apagado, de modo que el menu del shell
// no anuncia el panel hasta que se encienda a proposito.
import { describe, expect, it } from "vitest";
import { OPERACION_PANEL_ACTIVO } from "../src/verticals/restaurantes/lib/operacion-flag.ts";

describe("panel del operador", () => {
  it("el interruptor del panel esta apagado hasta que se encienda a proposito", () => {
    expect(OPERACION_PANEL_ACTIVO).toBe(false);
  });
});
