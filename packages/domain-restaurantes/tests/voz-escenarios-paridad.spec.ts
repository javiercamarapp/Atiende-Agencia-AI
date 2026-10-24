// Suite de paridad de voz con WhatsApp (proveedor falso, sin costo): cada escenario corre con su reloj y su horario y pasa por los graders deterministas.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluarLlamada } from "../src/voz/simulador/graders-voz.ts";
import { ESCENARIOS_PARIDAD, correrEscenario } from "../src/voz/simulador/guiones-paridad.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

describe("paridad de voz con WhatsApp (proveedor falso)", () => {
  it("ids unicos", () => expect(new Set(ESCENARIOS_PARIDAD.map((e) => e.guion.id)).size).toBe(ESCENARIOS_PARIDAD.length));
  describe.each(ESCENARIOS_PARIDAD.map((e) => [e.guion.id, e] as const))("%s", (_id, esc) => {
    it("pasa todos los graders deterministas", async () => {
      vi.setSystemTime(new Date(esc.ahora));
      const { llamada } = await correrEscenario(esc);
      const fallos = (await evaluarLlamada(llamada)).filter((r) => !r.ok);
      expect(fallos, JSON.stringify({ fallos, tools: llamada.tools.map((t) => ({ n: t.nombre, r: JSON.stringify(t.resultado).slice(0, 220) })) }, null, 1)).toEqual([]);
    });
  });
});
