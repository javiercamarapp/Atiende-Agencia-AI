// Barrido de estabilidad de V07 (G_SIN_PII_LOG): 3000 corridas del guion con UUID aleatorios distintos en cada una (antes fallaba ~12 %
// por UUID mutilados por `redactarPII`). Cero falsos positivos. Reloj fijo (solo Date); no depende de la zona horaria.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { correrGuion } from "../src/voz/simulador/correr-guion.ts";
import { evaluarLlamada } from "../src/voz/simulador/graders-voz.ts";
import { GUIONES_ES_MX } from "../src/voz/simulador/guiones-es-mx.ts";

const V07 = GUIONES_ES_MX.find((g) => g.id.startsWith("V07"));
const CORRIDAS = 3000;

describe("barrido V07", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00-06:00"));
  });
  afterEach(() => vi.useRealTimers());

  it(`${CORRIDAS} corridas de V07 sin falsos positivos de G_SIN_PII_LOG`, async () => {
    expect(V07).toBeDefined();
    let fallos = 0;
    let mutilados = 0;
    for (let i = 0; i < CORRIDAS; i++) {
      const llamada = await correrGuion(V07!);
      // Sin el arreglo ~13 % de las corridas traen un UUID mutilado ("...-5b[TELEFONO]-...") y ~0,03 % fallan el grader: se mide la causa, no solo el sintoma.
      if (JSON.stringify(llamada.logs).includes("[TELEFONO]")) mutilados++;
      const r = await evaluarLlamada(llamada);
      if (r.some((x) => x.grader === "G_SIN_PII_LOG" && !x.ok)) fallos++;
    }
    expect({ fallos, mutilados }).toEqual({ fallos: 0, mutilados: 0 });
  }, 600_000);
});
