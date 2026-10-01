// Contraste WCAG 2.x entre dos colores HSL (h 0-360, s/l 0-100), el formato de
// los tokens de index.css. Lo usa packages/ui/tests/tokens-v2-contraste.spec.ts
// para que los valores de la paleta v2 no queden como "calculo manual".

export type Hsl = readonly [h: number, s: number, l: number];

function hslARgb([h, s, l]: Hsl): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return ln - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

export function luminancia(color: Hsl): number {
  const [r, g, b] = hslARgb(color).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contraste(a: Hsl, b: Hsl): number {
  const la = luminancia(a);
  const lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Lee "219 65% 41%" (valor de un token) -> [219, 65, 41]. */
export function parseHsl(valor: string): Hsl {
  const m = /^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*$/.exec(valor);
  if (!m) throw new Error(`Token HSL no válido: "${valor}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
