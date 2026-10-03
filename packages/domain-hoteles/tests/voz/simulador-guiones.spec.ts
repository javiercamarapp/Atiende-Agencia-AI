// Prueba ciega es-MX del agente de VOZ de hoteles con el proveedor FALSO guionado (sin red, sin credenciales): cada guion corre contra el nucleo real de
// @atiende/voice-core (maquina de la llamada + controlador + ejecutor) y el motor real de reservas en memoria, y lo juzgan graders deterministas.
import { describe, expect, it } from "vitest";
import { GUIONES_ES_MX, correrGuion, evaluarLlamada } from "../../src/voz/simulador/index.ts";

describe("guiones es-MX de la voz de hoteles", () => {
  it("hay al menos los 8 escenarios que exige el brief, con ids unicos", () => {
    expect(GUIONES_ES_MX.length).toBeGreaterThanOrEqual(8);
    expect(new Set(GUIONES_ES_MX.map((g) => g.id)).size).toBe(GUIONES_ES_MX.length);
    const ids = GUIONES_ES_MX.map((g) => g.id).join(" ");
    for (const clave of ["feliz", "cambio", "cancelacion", "sin-disponibilidad", "humano", "fuera-de-horario", "ambiguo", "abuso"]) expect(ids).toContain(clave);
  });

  for (const guion of GUIONES_ES_MX) {
    it(`${guion.id}: pasan TODOS los graders`, async () => {
      const llamada = await correrGuion(guion);
      const fallos = (await evaluarLlamada(llamada)).filter((r) => !r.ok);
      expect(fallos).toEqual([]);
    });
  }
});
