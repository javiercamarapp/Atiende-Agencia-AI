// PM R22 (causa 4 / R3): una hora de recogida a menos de 25 minutos se aceptaba y se guardaba (SIM 114, 118, 119). Reloj fijo: martes 2026-10-06 13:00 America/Merida.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limpiarEntorno, prepararEntorno, setup } from "./support/cierre-r11.ts";

afterEach(limpiarEntorno);
beforeEach(() => prepararEntorno(true));

describe("R22: hora de recogida minima de 25 minutos", () => {
  it("«en 20 minutos» (minutos_para_recoger) se rechaza y pide otra hora", async () => {
    const s = setup();
    await expect(s.quote({ minutos_para_recoger: 20 })).rejects.toThrow(/25 minutos/);
    expect((await s.snap())?.state ?? null).toBeNull();
  });

  it("hora exacta 20 minutos adelante (13:20) se rechaza; 13:25 y 13:40 se aceptan", async () => {
    const s = setup();
    await expect(s.quote({ hora_recogida: "2026-10-06T13:20:00-06:00" })).rejects.toThrow(/otra hora/);
    await expect(s.quote({ hora_recogida: "2026-10-06T13:25:00-06:00" })).resolves.toBeTruthy();
    await expect(s.quote({ hora_recogida: "2026-10-06T13:40:00-06:00" })).resolves.toBeTruthy();
  });

  it("«en 25 minutos» y «en 40 minutos» pasan", async () => {
    const s = setup();
    await expect(s.quote({ minutos_para_recoger: 25 })).resolves.toBeTruthy();
    await expect(s.quote({ minutos_para_recoger: 40 })).resolves.toBeTruthy();
  });

  it("sin hora («en cuanto esté») no se valida nada", async () => {
    const s = setup();
    await expect(s.quote({})).resolves.toBeTruthy();
  });
});
