// Prueba ciega es-MX de VOZ contra el simulador local: guiones de llamada completos (jerga, numeros y direcciones habladas,
// correcciones, interrupciones, silencio, ruido, DTMF, caidas del proveedor, limites) corridos contra la maquina de estados
// real, el ejecutor de herramientas del registro unico y el motor de pedidos sobre el repositorio en memoria, con el proveedor
// FALSO. Prueba la plomeria, las reglas duras y los graders; que un modelo real entienda es-MX se prueba a mano contra Gemini
// (`npm run evals:voz:real -w @atiende/domain-restaurantes`, ver docs/VOZ-PM.md).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { correrGuion } from "../src/voz/simulador/correr-guion.ts";
import { evaluarLlamada } from "../src/voz/simulador/graders-voz.ts";
import { GUIONES_ES_MX } from "../src/voz/simulador/guiones-es-mx.ts";

// Reloj fijo: miercoles 12:00 de Merida (UTC-6), dentro del horario de servicio de las sucursales. Los guiones con plazo relativo
// (V27, "paso en cuarenta minutos" -> minutos_para_recoger) hacen que el SERVIDOR calcule la hora de recogida con el reloj real;
// de noche (p. ej. 05:20 UTC) la sucursal esta cerrada y el pedido se rechazaba (bomba de tiempo). Solo se falsea Date.
const MIERCOLES_12 = new Date("2026-10-07T12:00:00-06:00");

describe("prueba ciega es-MX de voz (proveedor falso)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MIERCOLES_12);
  });
  afterEach(() => vi.useRealTimers());

  it("el set trae al menos 20 guiones con ids unicos", () => {
    expect(GUIONES_ES_MX.length).toBeGreaterThanOrEqual(20);
    expect(new Set(GUIONES_ES_MX.map((g) => g.id)).size).toBe(GUIONES_ES_MX.length);
  });

  describe.each(GUIONES_ES_MX.map((g) => [g.id, g] as const))("%s", (_id, guion) => {
    it("pasa todos los graders deterministas", async () => {
      const llamada = await correrGuion(guion);
      const resultados = await evaluarLlamada(llamada);
      const fallos = resultados.filter((r) => !r.ok);
      expect(fallos, JSON.stringify(fallos)).toEqual([]);
    });
  });
});
