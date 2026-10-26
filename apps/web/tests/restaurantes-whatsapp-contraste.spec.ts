// Contraste AA de las parejas de colores --wa-* del chat de WhatsApp (claro y oscuro), calculado sobre el CSS real:
// texto normal >= 4.5:1 y glifos/iconos (palomitas) >= 3:1. Los colores con alfa se componen sobre el fondo en el que se pintan.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/verticals/restaurantes/preview/widget-whatsapp.css", import.meta.url), "utf8");

function variables(selector: string): Record<string, string> {
  const i = css.indexOf(`${selector} {`);
  const bloque = css.slice(i, css.indexOf("}", i));
  const salida: Record<string, string> = {};
  for (const m of bloque.matchAll(/(--wa-[\w-]+):\s*([^;]+);/g)) salida[m[1]!] = m[2]!.trim();
  return salida;
}
const CLARO = variables(".wa-widget");
const OSCURO = { ...CLARO, ...variables(".dark .wa-widget") };

type RGBA = readonly [number, number, number, number];
function parsear(valor: string): RGBA {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(valor);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const f = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(valor);
  if (f) return [Number(f[1]), Number(f[2]), Number(f[3]), f[4] ? Number(f[4]) : 1];
  throw new Error(`color no soportado: ${valor}`);
}
function componer(frente: RGBA, fondo: RGBA): RGBA {
  const a = frente[3];
  return [0, 1, 2].map((i) => frente[i]! * a + fondo[i]! * (1 - a)).concat(1) as unknown as RGBA;
}
function luminancia([r, g, b]: RGBA): number {
  const l = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * l[0]! + 0.7152 * l[1]! + 0.0722 * l[2]!;
}
function contraste(frente: string, fondo: string, vars: Record<string, string>, base: string): number {
  const bg = componer(parsear(vars[fondo]!), parsear(vars[base]!));
  const fg = componer(parsear(vars[frente]!), bg);
  const [a, b] = [luminancia(fg), luminancia(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// [frente, fondo sobre el que se pinta, mínimo]
const PAREJAS: ReadonlyArray<readonly [string, string, number]> = [
  ["--wa-texto", "--wa-burbuja-cliente", 4.5],
  ["--wa-texto", "--wa-burbuja-agente", 4.5],
  ["--wa-texto-tenue", "--wa-burbuja-cliente", 4.5],
  ["--wa-texto-tenue", "--wa-burbuja-agente", 4.5],
  ["--wa-texto-tenue", "--wa-fondo", 4.5],
  ["--wa-enlace", "--wa-burbuja-cliente", 4.5],
  ["--wa-enlace", "--wa-burbuja-agente", 4.5],
  ["--wa-palomitas", "--wa-burbuja-cliente", 3],
  ["--wa-sistema-texto", "--wa-sistema-fondo", 4.5],
  ["--wa-fecha-texto", "--wa-fecha-fondo", 4.5],
  ["--wa-cabecera-texto", "--wa-cabecera", 4.5],
  ["--wa-cabecera-tenue", "--wa-cabecera", 4.5],
  ["--wa-avatar-texto", "--wa-verde", 4.5],
];

describe("contraste AA del chat de WhatsApp (--wa-*)", () => {
  for (const [nombre, vars] of [["claro", CLARO], ["oscuro", OSCURO]] as const) {
    for (const [frente, fondo, minimo] of PAREJAS) {
      it(`${nombre}: ${frente} sobre ${fondo} >= ${minimo}`, () => {
        // Los fondos con alfa (sistema, fecha) se pintan sobre el fondo del chat; el resto sobre sí mismos.
        const base = fondo.includes("sistema") || fondo.includes("fecha") ? "--wa-fondo" : fondo;
        expect(contraste(frente, fondo, vars, base)).toBeGreaterThanOrEqual(minimo);
      });
    }
  }
});
