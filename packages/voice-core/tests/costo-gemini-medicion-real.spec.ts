// Costo de Gemini Live contra usageMetadata CRUDO de llamadas reales medidas (work/voz/medicion/resultados, 4-oct): el desglose por modalidad no suma el total
// (G1 turno 1: 4759 TEXT + 251 AUDIO = 5010 contra promptTokenCount 5804). Cobrar solo el desglose subestimaba la factura entre ~7 % y ~27 %.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { costoDeUsoGeminiMicroUsd } from "../src/index.ts";
import type { UsoGemini } from "../src/index.ts";

const cargar = (g: string): UsoGemini[] => JSON.parse(readFileSync(new URL(`./fixtures/usage-${g}-real.json`, import.meta.url), "utf8")) as UsoGemini[];
const totalUsd = (usos: readonly UsoGemini[]): number => usos.reduce((s, u) => s + costoDeUsoGeminiMicroUsd(u), 0) / 1e6;

describe("costoDeUsoGeminiMicroUsd contra usageMetadata real", () => {
  it("el primer turno de G1 cobra los 794 tokens sin desglose (5804 - 5010) a tarifa de audio", () => {
    const u = cargar("g1")[0]!;
    expect(u.promptTokenCount).toBe(5804);
    const desglosado = (u.promptTokensDetails ?? []).reduce((s, d) => s + (d.tokenCount ?? 0), 0);
    expect(desglosado).toBe(5010);
    // 4759*0.75 + 251*3 + 794*3 (sin desglose) + 95*12 (salida audio) + 49*4.5 (pensamiento)
    expect(costoDeUsoGeminiMicroUsd(u)).toBe(Math.ceil(4759 * 0.75 + 251 * 3 + 794 * 3 + 95 * 12 + 49 * 4.5));
  });

  it.each([
    // [llamada, calculo central de medicion/analizar.py, caso alto de analizar.py] en US$
    ["g1", 0.1683, 0.2159],
    ["g2", 0.173, 0.2201],
  ])("%s: nunca queda por debajo del calculo central de la medicion y no pasa del caso alto", (g, central, alto) => {
    const usd = totalUsd(cargar(g));
    expect(usd).toBeGreaterThanOrEqual(central);
    expect(usd).toBeLessThanOrEqual(alto);
  });
});
