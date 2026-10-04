// Paleta de color por VERTICAL del Cerebro de ventas: los 6 tokens --vertical-* de index.css, leidos tal cual
// (no una tabla copiada a mano). Afirma (1) que existen en claro y en oscuro, (2) contraste no textual >= 3:1
// (WCAG 1.4.11) contra --card y --canvas en los dos temas y (3) que dos verticales distintas nunca se parecen
// demasiado (separacion de matiz >= 25 grados), para que el filtro por color sea legible.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contraste, parseHsl } from "../src/lib/contraste.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(aqui, "../src/index.css"), "utf8");

function escapar(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function tokens(selector: string): Record<string, string> {
  const re = new RegExp(`(?:^|\\n)\\s*${escapar(selector)}\\s*\\{([^}]*)\\}`, "g");
  const salida: Record<string, string> = {};
  for (const m of css.matchAll(re)) {
    for (const decl of (m[1] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) salida[decl[1]!] = decl[2]!.trim();
  }
  return salida;
}

const VERTICALES = ["restaurantes", "hoteles", "rentas", "licitaciones", "despachos", "citas"] as const;
const claro = tokens(":root");
const oscuro = { ...claro, ...tokens(".dark") };

describe("paleta por vertical (Cerebro)", () => {
  for (const [tema, t] of [["claro", claro], ["oscuro", oscuro]] as const) {
    it(`${tema}: los 6 tokens existen y llegan a 3:1 sobre --card y --canvas`, () => {
      for (const v of VERTICALES) {
        const valor = t[`--vertical-${v}`];
        expect(valor, `--vertical-${v} (${tema})`).toBeDefined();
        const hsl = parseHsl(valor!);
        expect(contraste(hsl, parseHsl(t["--card"]!)), `${v} sobre card (${tema})`).toBeGreaterThanOrEqual(3);
        expect(contraste(hsl, parseHsl(t["--canvas"]!)), `${v} sobre canvas (${tema})`).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${tema}: dos verticales distintas se separan >= 25 grados de matiz`, () => {
      const matices = VERTICALES.map((v) => parseHsl(t[`--vertical-${v}`]!)[0]);
      for (let i = 0; i < matices.length; i++) {
        for (let j = i + 1; j < matices.length; j++) {
          const d = Math.abs(matices[i]! - matices[j]!);
          expect(Math.min(d, 360 - d), `${VERTICALES[i]} vs ${VERTICALES[j]} (${tema})`).toBeGreaterThanOrEqual(25);
        }
      }
    });
  }
});
