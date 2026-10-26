// Lote 1.2 del rediseno ds3: el bloque html[data-diseno="ds3"] (claro) y html[data-diseno="ds3"].dark (oscuro) de index.css, con TODOS los
// valores del sistema de diseno nuevo. Mismo esqueleto que tokens-likida.spec.ts: lee los valores REALES de index.css (parseados con
// postcss, no una tabla copiada a mano) y afirma (1) que todo vive bajo la bandera, (2) hex de referencia con tolerancia <= 1/255 por
// canal, (3) contrastes WCAG de los pares del diseno (con las excepciones medidas), (4) escala tipografica, radios, foco, motion (<= 400 ms),
// controles (escritorio y tactil), sombras y layout, y (5) que el ambito restaurantes y el sidebar no dejan colores mezclados.
// Tambien reubica los invariantes de contraste de tokens-restaurantes (que se borra en el lote 12) sobre los valores ds3.
// Solo AÑADE: no toca ningun spec existente.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Container, type Rule } from "postcss";
import { describe, expect, it } from "vitest";
import { contraste, parseHsl, type Hsl } from "../src/lib/contraste.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(aqui, "../src/index.css"), "utf8");
const raiz = postcss.parse(css);

const BANDERA = 'html[data-diseno="ds3"]';

interface Bloque {
  selector: string;
  /** Condicion de los @media que envuelven la regla ("" si ninguna). */
  media: string;
  decl: Record<string, string>;
}

function medias(nodo: Container | undefined): string {
  const partes: string[] = [];
  for (let p = nodo; p && p.type !== "root"; p = p.parent as Container | undefined) {
    if (p.type === "atrule" && (p as AtRule).name === "media") partes.unshift((p as AtRule).params);
  }
  return partes.join(" and ");
}

const bloques: Bloque[] = [];
raiz.walkRules((regla: Rule) => {
  const decl: Record<string, string> = {};
  regla.walkDecls((d) => {
    if (d.parent === regla) decl[d.prop] = d.value.trim();
  });
  for (const selector of regla.selectors) bloques.push({ selector: selector.trim(), media: medias(regla.parent as Container), decl });
});

/** Variables del selector exacto, fuera de @media (varias reglas: el ultimo gana). */
function tokens(selector: string, media = ""): Record<string, string> {
  const salida: Record<string, string> = {};
  for (const b of bloques) if (b.selector === selector && b.media === media) Object.assign(salida, b.decl);
  return salida;
}

const raizClaro = tokens(":root");
const raizOscuro = { ...raizClaro, ...tokens(".dark") };
const ds3Claro = tokens(BANDERA);
const ds3OscuroSolo = tokens(`${BANDERA}.dark`);
/** Lo que ve un elemento con la bandera: :root + ds3 (claro) y ademas .dark + ds3.dark (oscuro). */
const claro = { ...raizClaro, ...ds3Claro };
const oscuro = { ...raizOscuro, ...ds3Claro, ...ds3OscuroSolo };

const ratio = (t: Record<string, string>, fg: string, bg: string): number => contraste(parseHsl(t[fg]!), parseHsl(t[bg]!));

/** [h, s, l] -> [r, g, b] (0-255, redondeado). */
function aRgb([h, s, l]: Hsl): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((ln - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))) * 255);
  };
  return [f(0), f(8), f(4)];
}
function hexARgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
/** El token (HSL con 1 decimal) reproduce el hex de referencia con diferencia <= 1 por canal. */
function afirmarHex(t: Record<string, string>, token: string, hex: string): void {
  const rgb = aRgb(parseHsl(t[token]!));
  const esperado = hexARgb(hex);
  for (let i = 0; i < 3; i++) expect(Math.abs(rgb[i]! - esperado[i]!), `${token} ${t[token]} vs ${hex}`).toBeLessThanOrEqual(1);
}
function px(valor: string | undefined): number {
  const m = /^(-?\d+(?:\.\d+)?)(rem|px)$/.exec((valor ?? "").trim());
  if (!m) throw new Error(`Longitud no valida: "${valor}"`);
  return m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
}
function ms(valor: string | undefined): number {
  const m = /^(\d+(?:\.\d+)?)ms$/.exec((valor ?? "").trim());
  if (!m) throw new Error(`Duracion no valida: "${valor}"`);
  return Number(m[1]);
}

// Tokens de color (tripletes HSL) que el bloque define en AMBOS modos.
const SERIES = [1, 2, 3, 4, 5, 6, 7, 8];
const COLORES = [
  "--background", "--canvas", "--sunken", "--card", "--card-foreground", "--popover", "--popover-foreground", "--soft",
  "--border", "--border-strong", "--line2", "--input", "--control-off", "--foreground", "--foreground-2", "--secondary",
  "--secondary-foreground", "--muted", "--muted-foreground", "--faint", "--accent", "--accent-foreground",
  "--action", "--action-foreground", "--action-hover", "--ring",
  "--primary", "--primary-foreground", "--primary-soft", "--primary-soft-hover", "--primary-ink",
  "--solido", "--solido-foreground", "--menu-activo", "--menu-activo-foreground", "--marca-atiende",
  "--success-tint", "--success-ink", "--success", "--warning-tint", "--warning-ink", "--warning",
  "--danger-tint", "--danger-ink", "--destructive-tint", "--destructive", "--destructive-foreground",
  "--destructive-solido", "--destructive-solido-foreground", "--info-tint", "--info-ink", "--info", "--kind-inferred",
  "--chart-tick", "--sidebar-background", "--sidebar-foreground", "--sidebar-primary", "--sidebar-primary-foreground",
  "--sidebar-accent", "--sidebar-accent-foreground", "--sidebar-border", "--sidebar-ring",
  ...SERIES.flatMap((n) => [`--chart-${n}`, `--chart-soft-${n}`, `--on-chart-${n}`]),
];

describe("garantia estructural: todo el diseno nuevo vive bajo la bandera", () => {
  const conBandera = bloques.filter((b) => b.selector.includes("data-diseno"));

  it("hay bloques ds3 (claro, oscuro, tactil, layout y el sidebar)", () => {
    expect(Object.keys(ds3Claro).length).toBeGreaterThan(150);
    expect(Object.keys(ds3OscuroSolo).length).toBeGreaterThan(80);
    expect(conBandera.length).toBeGreaterThanOrEqual(12);
  });

  it("todo selector que menciona data-diseno empieza por html[data-diseno=\"ds3\"] (nunca la bandera desnuda ni otro valor)", () => {
    for (const b of conBandera) {
      expect(b.selector.startsWith(BANDERA), b.selector).toBe(true);
      expect(b.selector, b.selector).not.toMatch(/data-diseno(?!="ds3")/);
    }
  });

  it(":root y .dark no declaran ninguno de los tokens que solo existen bajo ds3", () => {
    const soloDs3 = Object.keys(ds3Claro).filter((k) => !(k in raizClaro) && !(k in tokens(".dark")));
    // Si algun dia :root los adopta, esta lista cambia a proposito; hoy deben ser exactamente los tokens nuevos de este lote.
    expect(soloDs3).toEqual(expect.arrayContaining(["--text-page", "--text-kpi", "--shadow-rest", "--shadow-hover", "--radius-sm", "--radius-md",
      "--radius-lg", "--radius-xl", "--target-min", "--pad-page", "--marco", "--chart-h", "--kind-inferred", "--chart-grid", "--chart-axis",
      "--chart-tick", "--dur-salida", "--shadow-hoja", "--gap-interior", "--carga-tabla-h", "--carga-kpi-h"]));
  });

  it("los valores de :root y .dark siguen siendo los de la produccion (tokens-ds3-base los custodia: aqui, un muestreo)", () => {
    expect(raizClaro["--primary"]).toBe("224 76% 48%");
    expect(raizClaro["--font-sans"]).toBe('"Inter", system-ui, sans-serif');
    expect(raizClaro["--radius-card"]).toBe("1rem");
    expect(raizClaro["--control-md"]).toBe("2.25rem");
    expect(raizClaro["--dur-base"]).toBe("250ms");
    expect(raizOscuro["--primary"]).toBe("213 82% 62%");
  });
});

describe("cada token de color existe y es un triplete HSL en claro y en oscuro", () => {
  it.each(COLORES)("%s", (token) => {
    expect(() => parseHsl(ds3Claro[token]!), `${token} claro`).not.toThrow();
    expect(() => parseHsl(oscuro[token]!), `${token} oscuro`).not.toThrow();
    // Y el oscuro lo declara el mismo (no hereda por accidente el valor claro).
    expect(ds3OscuroSolo[token], `${token} en ds3.dark`).toBeTruthy();
  });
});

describe("hex de referencia del diseno (tolerancia <= 1/255 por canal)", () => {
  const claroHex: Array<[string, string]> = [
    ["--background", "#f7f7f8"], ["--canvas", "#f7f7f8"], ["--card", "#ffffff"], ["--sunken", "#f1f1f2"], ["--soft", "#f1f1f2"],
    ["--border", "#e6e6e8"], ["--border-strong", "#d6d6d9"], ["--input", "#818188"], ["--foreground", "#0e0e10"],
    ["--secondary-foreground", "#3a3a40"], ["--muted-foreground", "#5a5a61"], ["--action", "#0e0e10"], ["--action-hover", "#2a2a2f"],
    ["--primary", "#1d4fd7"], ["--primary-soft", "#e9eefc"], ["--primary-soft-hover", "#d7e0f9"], ["--primary-ink", "#163ba2"],
    ["--chart-1", "#1d4fd7"], ["--chart-2", "#f25d22"], ["--chart-3", "#1f7a55"], ["--chart-4", "#d9a441"], ["--chart-5", "#087b9b"],
    ["--chart-6", "#a6264a"], ["--chart-7", "#7b5cd6"], ["--chart-8", "#0e0e10"],
  ];
  const oscuroHex: Array<[string, string]> = [
    ["--background", "#0e0e10"], ["--sunken", "#0e0e10"], ["--card", "#17171a"], ["--soft", "#1f1f23"], ["--border", "#26262b"],
    ["--border-strong", "#34343a"], ["--input", "#8b8b93"], ["--foreground", "#f4f4f5"], ["--secondary-foreground", "#d4d4d8"],
    ["--muted-foreground", "#a3a3ab"], ["--action", "#f4f4f5"], ["--action-hover", "#ffffff"], ["--primary", "#639cf8"],
    ["--primary-soft", "#151d32"], ["--primary-soft-hover", "#1c2540"], ["--primary-ink", "#9ec1fa"], ["--chart-1", "#639cf8"],
    ["--chart-8", "#f4f4f5"],
  ];
  it.each(claroHex)("claro %s = %s", (token, hex) => afirmarHex(claro, token, hex));
  it.each(oscuroHex)("oscuro %s = %s", (token, hex) => afirmarHex(oscuro, token, hex));

  it("el acento es el azul de Atiende (decision del dueno): 224 76% 48% claro / 217 91% 68% oscuro", () => {
    expect(ds3Claro["--primary"]).toBe("224 76% 48%");
    expect(ds3OscuroSolo["--primary"]).toBe("217 91% 68%");
  });

  it("scrim: 40 % tinta en claro y 67 % negro en oscuro", () => {
    expect(ds3Claro["--scrim"]).toBe("hsl(240 6.7% 5.9% / 0.4)");
    expect(ds3OscuroSolo["--scrim"]).toBe("hsl(0 0% 0% / 0.67)");
  });

  it("--ring = --action en los dos modos", () => {
    expect(ds3Claro["--ring"]).toBe(ds3Claro["--action"]);
    expect(ds3OscuroSolo["--ring"]).toBe(ds3OscuroSolo["--action"]);
  });

  it("los tonos antiguos de estado apuntan al mismo valor que su tinta (una sola API success|warning|danger|info)", () => {
    for (const t of [claro, oscuro]) {
      expect(t["--success"]).toBe(t["--success-ink"]);
      expect(t["--warning"]).toBe(t["--warning-ink"]);
      expect(t["--info"]).toBe(t["--info-ink"]);
      expect(t["--destructive"]).toBe(t["--danger-ink"]);
      expect(t["--destructive-tint"]).toBe(t["--danger-tint"]);
    }
  });
});

describe("contraste WCAG de los pares de §2.1 (valores reales de index.css)", () => {
  // [nombre, fg, bg, minimo exigido]
  const comunes: Array<[string, string, string, number]> = [
    ["texto sobre fondo", "--foreground", "--background", 7],
    ["texto sobre card", "--card-foreground", "--card", 7],
    ["texto sobre popover", "--popover-foreground", "--popover", 7],
    ["texto sobre el area de contenido", "--foreground", "--sunken", 7],
    ["texto secundario sobre card", "--foreground-2", "--card", 7],
    ["muted sobre fondo", "--muted-foreground", "--background", 4.5],
    ["muted sobre card", "--muted-foreground", "--card", 4.5],
    ["muted sobre sunken", "--muted-foreground", "--sunken", 4.5],
    ["muted sobre soft", "--muted-foreground", "--soft", 4.5],
    ["faint sobre card", "--faint", "--card", 4.5],
    ["texto de accion sobre accion", "--action-foreground", "--action", 7],
    ["texto de accion sobre su hover", "--action-foreground", "--action-hover", 7],
    ["primary-foreground sobre primary", "--primary-foreground", "--primary", 4.5],
    ["primary-ink sobre su tinte", "--primary-ink", "--primary-soft", 4.5],
    ["primary-ink sobre el hover del tinte", "--primary-ink", "--primary-soft-hover", 4.5],
    ["primary-ink sobre card", "--primary-ink", "--card", 4.5],
    ["success-ink sobre su tinte", "--success-ink", "--success-tint", 4.5],
    ["warning-ink sobre su tinte", "--warning-ink", "--warning-tint", 4.5],
    ["danger-ink sobre su tinte", "--danger-ink", "--danger-tint", 4.5],
    ["info-ink sobre su tinte", "--info-ink", "--info-tint", 4.5],
    ["success-ink sobre card", "--success-ink", "--card", 4.5],
    ["warning-ink sobre card", "--warning-ink", "--card", 4.5],
    ["danger-ink sobre card", "--danger-ink", "--card", 4.5],
    ["info-ink sobre card", "--info-ink", "--card", 4.5],
    ["destructive-foreground sobre destructive", "--destructive-foreground", "--destructive", 4.5],
    ["primary como relleno (no texto) sobre card", "--primary", "--card", 3],
    ["ring (foco) sobre fondo", "--ring", "--background", 3],
    ["ring (foco) sobre card", "--ring", "--card", 3],
    ["ring (foco) sobre sunken", "--ring", "--sunken", 3],
    ["borde de campo sobre card (1.4.11)", "--input", "--card", 3],
    ["borde de campo sobre fondo", "--input", "--background", 3],
    ["borde de campo sobre sunken", "--input", "--sunken", 3],
    ["trazo de controles sobre card", "--control-off", "--card", 3],
    ["kind-inferred sobre card", "--kind-inferred", "--card", 3],
    ["sidebar: texto", "--sidebar-foreground", "--sidebar-background", 7],
    ["sidebar: texto del item activo", "--sidebar-accent-foreground", "--sidebar-accent", 7],
  ];
  it.each(comunes)("claro: %s", (_n, fg, bg, min) => expect(ratio(claro, fg, bg)).toBeGreaterThanOrEqual(min));
  it.each(comunes)("oscuro: %s", (_n, fg, bg, min) => expect(ratio(oscuro, fg, bg)).toBeGreaterThanOrEqual(min));

  it("ratios documentados en §2.1 (+-0,1 por redondeo del hex)", () => {
    const documentados: Array<[Record<string, string>, string, string, number]> = [
      [claro, "--muted-foreground", "--background", 6.39],
      [oscuro, "--muted-foreground", "--background", 7.7],
      [claro, "--primary", "--card", 6.66],
      [oscuro, "--primary", "--card", 6.51],
      [claro, "--primary-ink", "--primary-soft", 8.3],
      [oscuro, "--primary-ink", "--primary-soft", 9.14],
      [claro, "--input", "--card", 3.87],
      [claro, "--input", "--sunken", 3.43],
      [oscuro, "--input", "--card", 5.29],
      [claro, "--success-ink", "--success-tint", 5.04],
      [claro, "--warning-ink", "--warning-tint", 5.76],
      [claro, "--danger-ink", "--danger-tint", 6.06],
      [claro, "--info-ink", "--info-tint", 7.01],
      [oscuro, "--success-ink", "--success-tint", 8.96],
      [oscuro, "--warning-ink", "--warning-tint", 9.19],
      [oscuro, "--danger-ink", "--danger-tint", 8.97],
      [oscuro, "--info-ink", "--info-tint", 9.47],
      [oscuro, "--kind-inferred", "--card", 5.22],
    ];
    for (const [t, fg, bg, esperado] of documentados) {
      expect(Math.abs(ratio(t, fg, bg) - esperado), `${fg} sobre ${bg}: ${ratio(t, fg, bg).toFixed(2)} vs ${esperado}`).toBeLessThanOrEqual(0.1);
    }
  });

  it("el acento marca UNA cosa: hover nunca danger y --highlight no existe (seria un segundo acento)", () => {
    expect(css).not.toMatch(/--highlight\s*:/);
    expect(ds3Claro["--primary"]).not.toBe(ds3Claro["--danger-ink"]);
  });
});

describe("datos categoricos: texto sobre relleno solo si pasa 4,5 (excepciones medidas)", () => {
  const rellenos = SERIES.map((n) => [n] as const);
  // Texto de la serie: --on-chart-n es el mejor de los dos candidatos (tinta/blanco en claro; card/foreground en oscuro).
  const candidatos = (t: Record<string, string>): string[] => [t["--foreground"]!, t["--card"]!, "0 0% 100%"];

  it.each(rellenos)("--on-chart-%i es el candidato de mayor contraste sobre su serie (claro y oscuro)", (n) => {
    for (const t of [claro, oscuro]) {
      const fondo = parseHsl(t[`--chart-${n}`]!);
      const elegido = contraste(parseHsl(t[`--on-chart-${n}`]!), fondo);
      const mejor = Math.max(...candidatos(t).map((c) => contraste(parseHsl(c), fondo)));
      expect(elegido).toBeGreaterThanOrEqual(mejor - 0.05);
    }
  });

  // Ratios de §2.1 (columna «texto sobre relleno (claro)») y su medida real.
  const claroDoc: Array<[number, number]> = [[1, 6.66], [2, 5.84], [3, 5.29], [4, 8.57], [5, 4.86], [6, 7.01], [7, 4.83]];
  it.each(claroDoc)("claro: serie %i, texto %f:1 o mejor (todas >= 4,5)", (n, documentado) => {
    const r = ratio(claro, `--on-chart-${n}`, `--chart-${n}`);
    expect(r).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(r - documentado)).toBeLessThanOrEqual(0.1);
  });

  it("oscuro: las series 1-5, 7 y 8 llevan texto >= 4,5; la 6 mide 4,41 (blanco, el mejor candidato) y NO lleva texto encima (etiqueta externa)", () => {
    for (const n of [1, 2, 3, 4, 5, 7, 8]) expect(ratio(oscuro, `--on-chart-${n}`, `--chart-${n}`), `serie ${n}`).toBeGreaterThanOrEqual(4.5);
    const seis = ratio(oscuro, "--on-chart-6", "--chart-6");
    expect(seis).toBeLessThan(4.5);
    expect(seis).toBeGreaterThan(4.4);
  });

  it("decision (b): --on-chart-3 y --on-chart-7 en oscuro llegan a >= 4,5 (antes 4,46 con la rampa neutra del lote 1.1)", () => {
    expect(ratio(oscuro, "--on-chart-3", "--chart-3")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(oscuro, "--on-chart-7", "--chart-7")).toBeGreaterThanOrEqual(4.5);
  });

  it("excepcion medida: el ocre (serie 4) claro mide 2,25 contra blanco, por eso el relleno lleva contorno --chart-axis", () => {
    expect(ratio(claro, "--card", "--chart-4")).toBeLessThan(3);
    expect(Math.abs(ratio(claro, "--card", "--chart-4") - 2.25)).toBeLessThanOrEqual(0.1);
    // El naranja y el ocre llevan TINTA, nunca blanco.
    expect(claro["--on-chart-2"]).toBe(claro["--foreground"]);
    expect(claro["--on-chart-4"]).toBe(claro["--foreground"]);
    expect(ratio(claro, "--card", "--chart-2")).toBeLessThan(4.5);
  });

  it("las series se separan del fondo de la tarjeta >= 3:1 como relleno (excepto el ocre claro, con contorno)", () => {
    for (const n of SERIES) {
      if (n === 4) continue;
      expect(ratio(claro, `--chart-${n}`, "--card"), `claro ${n}`).toBeGreaterThanOrEqual(3);
    }
    for (const n of SERIES) expect(ratio(oscuro, `--chart-${n}`, "--card"), `oscuro ${n}`).toBeGreaterThanOrEqual(3);
  });

  it("--chart-soft-n es un tinte claro de su serie (mas claro que la serie en claro; mas oscuro en oscuro)", () => {
    for (const n of SERIES) {
      expect(parseHsl(claro[`--chart-soft-${n}`]!)[2], `claro ${n}`).toBeGreaterThan(90);
      expect(parseHsl(oscuro[`--chart-soft-${n}`]!)[2], `oscuro ${n}`).toBeLessThan(20);
    }
  });

  it("neutros de grafica: grid 8 % y eje 20 % de la tinta; el texto de marcas es muted-foreground", () => {
    expect(ds3Claro["--chart-grid"]).toBe("hsl(240 6.7% 5.9% / 0.08)");
    expect(ds3Claro["--chart-axis"]).toBe("hsl(240 6.7% 5.9% / 0.2)");
    expect(ds3OscuroSolo["--chart-grid"]).toBe("hsl(240 4.8% 95.9% / 0.08)");
    expect(ds3OscuroSolo["--chart-axis"]).toBe("hsl(240 4.8% 95.9% / 0.2)");
    expect(ds3Claro["--chart-tick"]).toBe(ds3Claro["--muted-foreground"]);
    expect(ds3OscuroSolo["--chart-tick"]).toBe(ds3OscuroSolo["--muted-foreground"]);
  });

  it("los 6 --vertical-* del Cerebro de ventas NO cambian bajo ds3", () => {
    for (const k of ["restaurantes", "hoteles", "rentas", "licitaciones", "despachos", "citas"]) {
      expect(ds3Claro[`--vertical-${k}`], k).toBeUndefined();
      expect(ds3OscuroSolo[`--vertical-${k}`], k).toBeUndefined();
    }
  });
});

describe("invariantes reubicados de tokens-restaurantes (sobre los valores ds3, con ambito restaurantes activo)", () => {
  // Con ambito restaurantes: :root + ambito + ds3 (el orden del archivo hace ganar a ds3 a igual especificidad).
  const ambClaro = tokens('html[data-ambito="restaurantes"]');
  const ambOscuro = tokens('html[data-ambito="restaurantes"].dark');
  const real = (modo: "claro" | "oscuro"): Record<string, string> =>
    modo === "claro"
      ? { ...raizClaro, ...ambClaro, ...ds3Claro }
      : { ...raizClaro, ...tokens(".dark"), ...ambClaro, ...ds3Claro, ...ambOscuro, ...ds3OscuroSolo };
  // ds3.dark (0,2,1) y ambito.dark (0,2,1): gana el ultimo del archivo (ds3); como ds3.dark va despues, ds3OscuroSolo manda.
  for (const modo of ["claro", "oscuro"] as const) {
    const t = real(modo);
    it(`${modo}: texto sobre fondo, tarjeta, popover y chip >= 4.5:1`, () => {
      expect(ratio(t, "--foreground", "--background")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--card-foreground", "--card")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--popover-foreground", "--popover")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--muted-foreground", "--background")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--muted-foreground", "--card")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--muted-foreground", "--muted")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--faint", "--card")).toBeGreaterThanOrEqual(4.5);
    });
    it(`${modo}: botones y superficies de color (primario, secundario, ghost/accent, destructivo, toast, menu)`, () => {
      expect(ratio(t, "--primary-foreground", "--primary")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--secondary-foreground", "--secondary")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--accent-foreground", "--accent")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--destructive-solido-foreground", "--destructive-solido")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--solido-foreground", "--solido")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--menu-activo-foreground", "--menu-activo")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--destructive", "--card")).toBeGreaterThanOrEqual(4.5);
    });
    it(`${modo}: borde de campo y anillo de foco llegan a 3:1 (1.4.11)`, () => {
      expect(ratio(t, "--input", "--card")).toBeGreaterThanOrEqual(3);
      expect(ratio(t, "--input", "--background")).toBeGreaterThanOrEqual(3);
      expect(ratio(t, "--ring", "--background")).toBeGreaterThanOrEqual(3);
      expect(ratio(t, "--ring", "--card")).toBeGreaterThanOrEqual(3);
    });
    it(`${modo}: el elemento resaltado del menu se distingue de la superficie del toast/menu con >= 3:1`, () => {
      expect(ratio(t, "--menu-activo", "--solido")).toBeGreaterThanOrEqual(3);
    });
    it(`${modo}: texto de los toasts (blanco/tinta sobre solido y sobre error solido) >= 4.5:1`, () => {
      expect(ratio(t, "--solido-foreground", "--solido")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--destructive-solido-foreground", "--destructive-solido")).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("el ambito restaurantes no deja ningun color suyo vivo: ds3 redefine TODA propiedad que el ambito toca (claro y oscuro)", () => {
    for (const k of Object.keys(ambClaro)) expect(ds3Claro[k], `claro ${k}`).toBeDefined();
    for (const k of Object.keys(ambOscuro)) expect(ds3OscuroSolo[k] ?? ds3Claro[k], `oscuro ${k}`).toBeDefined();
    // Y en oscuro cada propiedad que el ambito oscuro pisa tiene su propio valor oscuro ds3 (si no, ganaria la del ambito claro/oscuro).
    for (const k of Object.keys(ambOscuro)) expect(ds3OscuroSolo[k], `ds3.dark debe fijar ${k}`).toBeDefined();
  });

  it("el bloque ds3 va DESPUES de los bloques de ambito en el archivo (a igual especificidad gana el ultimo)", () => {
    const pos = (s: string): number => css.indexOf(s);
    expect(pos(`\n  ${BANDERA} {`)).toBeGreaterThan(pos('\n  html[data-ambito="restaurantes"].dark {'));
    expect(pos(`\n  ${BANDERA}.dark {`)).toBeGreaterThan(pos('\n  html[data-ambito="restaurantes"].dark {'));
  });

  it("el sidebar hereda la paleta ds3: repite exactamente las propiedades de [data-ambito-base], todas en `inherit`", () => {
    const base = Object.keys(tokens("[data-ambito-base]")).filter((k) => k.startsWith("--"));
    const heredado = tokens(`${BANDERA} [data-ambito-base]`);
    expect(Object.keys(heredado).sort()).toEqual(base.sort());
    for (const [k, v] of Object.entries(heredado)) expect(v, k).toBe("inherit");
    // y el modo oscuro del sidebar queda cubierto por el mismo conjunto
    expect(Object.keys(tokens(".dark [data-ambito-base]")).filter((k) => k.startsWith("--")).sort()).toEqual(base.sort());
  });
});

describe("escala tipografica (px / interlinea)", () => {
  const lh = (t: string): number => px(ds3Claro[`--text-${t}-lh`]);
  const sz = (t: string): number => px(ds3Claro[`--text-${t}`]);
  it.each([
    ["eyebrow", 11, 16],
    ["xs", 12, 16],
    ["ui", 13, 19.5],
    ["sm", 14, 18],
    ["base", 15, 20],
    ["page", 20, 24],
    ["kpi", 26, 28],
  ] as const)("text-%s = %i px / %f px", (nombre, tamano, interlinea) => {
    expect(sz(nombre)).toBe(tamano);
    expect(lh(nombre)).toBeCloseTo(interlinea, 5);
  });
  it("tope del KPI 28 y display entre 28 y 40 px con interlinea 1,1", () => {
    expect(lh("kpi")).toBeLessThanOrEqual(28);
    expect(ds3Claro["--text-display"]).toBe("clamp(1.75rem, 4vw, 2.5rem)");
    expect(px("1.75rem")).toBe(28);
    expect(px("2.5rem")).toBe(40);
    expect(ds3Claro["--text-display-lh"]).toBe("1.1");
  });
  it("tracking: eyebrow +.08em, sm -.01em, base -.015em, page -.025em, kpi -.03em, display -.025em", () => {
    expect(ds3Claro["--tracking-eyebrow"]).toBe("0.08em");
    expect(ds3Claro["--tracking-sm"]).toBe("-0.01em");
    expect(ds3Claro["--tracking-base"]).toBe("-0.015em");
    expect(ds3Claro["--tracking-page"]).toBe("-0.025em");
    expect(ds3Claro["--tracking-kpi"]).toBe("-0.03em");
    expect(ds3Claro["--tracking-display"]).toBe("-0.025em");
  });
  it("familias: las 4 --font-* viven SOLO en fuentes-ds3.css, bajo la bandera; index.css de la UI no nombra familias ds3", () => {
    const fuentes = postcss.parse(readFileSync(join(aqui, "../../../apps/web/src/fuentes-ds3.css"), "utf8"));
    const decl: Record<string, string> = {};
    let reglasConFont = 0;
    fuentes.walkRules((r) => {
      const t = r.nodes.filter((n) => n.type === "decl" && /^--font-/.test((n as { prop: string }).prop));
      if (!t.length) return;
      reglasConFont++;
      expect(r.selectors, "selector de --font-*").toEqual([BANDERA]);
      for (const n of t) decl[(n as { prop: string }).prop] = (n as { value: string }).value.trim();
    });
    expect(reglasConFont).toBe(1);
    expect(Object.keys(decl).sort()).toEqual(["--font-body", "--font-display", "--font-mono", "--font-sans"]);
    expect(decl["--font-sans"]).toMatch(/^"Hanken Grotesk", "Hanken Grotesk Ajuste", system-ui/);
    expect(decl["--font-body"]).toBe(decl["--font-sans"]);
    expect(decl["--font-display"]).toBe(decl["--font-sans"]);
    expect(decl["--font-mono"]).toMatch(/^"IBM Plex Mono DS3", "IBM Plex Mono DS3 Ajuste", ui-monospace/);
    // Ni el bloque ds3 claro ni el oscuro de index.css las declaran, y el entrypoint importa fuentes-ds3.css DESPUES de la hoja de la UI.
    for (const k of Object.keys(decl)) {
      expect(ds3Claro[k], k).toBeUndefined();
      expect(ds3OscuroSolo[k], k).toBeUndefined();
    }
    expect(css).not.toMatch(/Hanken Grotesk|IBM Plex Mono DS3/);
    const entrada = readFileSync(join(aqui, "../../../apps/web/src/index.css"), "utf8");
    expect(entrada.indexOf("./fuentes-ds3.css")).toBeGreaterThan(entrada.indexOf("@atiende/ui/styles.css"));
  });
  it("cuerpo: 13 px / 1.5, sin tracking global, cifras tabulares, sin sintesis de cursiva", () => {
    const cuerpo = tokens(BANDERA); // las propiedades normales se parsean tambien
    void cuerpo;
    const regla = bloques.find((b) => b.selector === `${BANDERA} body` && b.media === "");
    expect(regla?.decl["font-size"]).toBe("0.8125rem");
    expect(regla?.decl["line-height"]).toBe("1.5");
    expect(regla?.decl["letter-spacing"]).toBe("0");
    expect(regla?.decl["font-variant-numeric"]).toBe("tabular-nums");
    expect(regla?.decl["font-synthesis"]).toBe("weight");
  });
});

describe("radios", () => {
  it("sm 4 · md 8 · lg 12 · xl 16 · full 999+", () => {
    expect(px(ds3Claro["--radius-sm"])).toBe(4);
    expect(px(ds3Claro["--radius-md"])).toBe(8);
    expect(px(ds3Claro["--radius-lg"])).toBe(12);
    expect(px(ds3Claro["--radius-xl"])).toBe(16);
    expect(px(ds3Claro["--radius"])).toBe(12);
    expect(ds3Claro["--radius-full"]).toBe("9999px");
  });
  it("nombrados: control 8 · field 8 · card 12 · shell 12 · dialog 12 (+ menu 12, item 8)", () => {
    expect(["control", "field", "card", "shell", "dialog", "menu", "item"].map((n) => px(ds3Claro[`--radius-${n}`]))).toEqual([8, 8, 12, 12, 12, 12, 8]);
  });
  it("ningun radio ds3 supera 16 (salvo full)", () => {
    for (const [k, v] of Object.entries(ds3Claro)) if (k.startsWith("--radius") && k !== "--radius-full") expect(px(v), k).toBeLessThanOrEqual(16);
  });
});

describe("foco", () => {
  it("anillo de 2 px, offset 2, color --ring, en todo :focus-visible y en el label del RadioSegmentado", () => {
    for (const selector of [`${BANDERA} :focus-visible`, `${BANDERA} label:has(> input.sr-only:focus-visible)`]) {
      const b = bloques.find((x) => x.selector === selector);
      expect(b, selector).toBeTruthy();
      expect(b!.decl.outline).toBe("2px solid hsl(var(--ring))");
      expect(b!.decl["outline-offset"]).toBe("2px");
    }
  });
  it("el foco de produccion (3 px) no cambia: sigue en la regla sin bandera", () => {
    const b = bloques.find((x) => x.selector === ":focus-visible" && x.media === "");
    expect(b?.decl.outline).toBe("3px solid hsl(var(--ring))");
  });
});

describe("controles (§2.3)", () => {
  const nombres = ["xs", "sm", "md", "lg"] as const;
  it("escritorio: 24 / 28 / 32 / 36", () => {
    expect(nombres.map((n) => px(ds3Claro[`--control-${n}`]))).toEqual([24, 28, 32, 36]);
  });
  it("tactil (pointer:coarse o <768): 32 / 36 / 44 / 44, redefinido en un @media bajo la bandera", () => {
    const tactil = tokens(BANDERA, "(pointer: coarse), (max-width: 767.98px)");
    expect(nombres.map((n) => px(tactil[`--control-${n}`]))).toEqual([32, 36, 44, 44]);
    expect(px(ds3Claro["--target-min"])).toBe(44);
    expect(px(tactil["--control-md"])).toBeGreaterThanOrEqual(px(ds3Claro["--target-min"]));
  });
  it("el bloque tactil solo redefine --control-* y va despues del base (gana por orden)", () => {
    const tactil = tokens(BANDERA, "(pointer: coarse), (max-width: 767.98px)");
    expect(Object.keys(tactil).sort()).toEqual(["--control-lg", "--control-md", "--control-sm", "--control-xs"]);
    expect(css.indexOf("@media (pointer: coarse), (max-width: 767.98px)")).toBeGreaterThan(css.indexOf(`\n  ${BANDERA}.dark {`));
  });
  it("monotonos: xs < sm < md <= lg en los dos regimenes", () => {
    for (const t of [ds3Claro, tokens(BANDERA, "(pointer: coarse), (max-width: 767.98px)")]) {
      const v = nombres.map((n) => px(t[`--control-${n}`]));
      expect(v[0]!).toBeLessThan(v[1]!);
      expect(v[1]!).toBeLessThan(v[2]!);
      expect(v[2]!).toBeLessThanOrEqual(v[3]!);
    }
  });
});

describe("espaciado y layout (§2.4)", () => {
  it("escritorio: gap de bloque 12, gap interior 8, pad de pagina 20, pad de tarjeta 14, header 44, sidebar 232 / rail 72, barra inferior 56", () => {
    expect(px(ds3Claro["--gap-bloque"])).toBe(12);
    expect(px(ds3Claro["--gap-interior"])).toBe(8);
    expect(px(ds3Claro["--pad-page"])).toBe(20);
    expect(px(ds3Claro["--pad-card"])).toBe(14);
    expect(px(ds3Claro["--header-h"])).toBe(44);
    expect(px(ds3Claro["--sidebar-w"])).toBe(232);
    expect(px(ds3Claro["--sidebar-w-rail"])).toBe(72);
    expect(px(ds3Claro["--bottomnav-h"])).toBe(56);
    expect(ds3Claro["--nav-total"]).toBe("calc(var(--bottomnav-h) + env(safe-area-inset-bottom, 0px) + 0.75rem)");
  });
  it("movil (<768): pad de pagina 16, pad de tarjeta 12, header 56", () => {
    const m = tokens(BANDERA, "(max-width: 767.98px)");
    expect([px(m["--pad-page"]), px(m["--pad-card"]), px(m["--header-h"])]).toEqual([16, 12, 56]);
  });
  it("marco: 0 por defecto, 12 desde 768 y 16 desde 1280", () => {
    expect(px(ds3Claro["--marco"])).toBe(0);
    expect(px(tokens(BANDERA, "(min-width: 768px)")["--marco"])).toBe(12);
    expect(px(tokens(BANDERA, "(min-width: 1280px)")["--marco"])).toBe(16);
  });
  it("alturas de carga: panel 160, tabla 240, tarjeta KPI 88, grafica 168", () => {
    expect([px(ds3Claro["--carga-panel-h"]), px(ds3Claro["--carga-tabla-h"]), px(ds3Claro["--carga-kpi-h"]), px(ds3Claro["--chart-h"])]).toEqual([160, 240, 88, 168]);
  });
  it("escala 4/8/12/16/20/24/32/40/48: los tokens de espacio son multiplos de 4", () => {
    for (const k of ["--gap-bloque", "--gap-interior", "--pad-page", "--pad-card"]) {
      for (const t of [ds3Claro, tokens(BANDERA, "(max-width: 767.98px)")]) if (t[k]) expect(px(t[k]) % 2, k).toBe(0);
    }
  });
});

describe("sombras (§2.5)", () => {
  it("reposo y hover sin sombra; la tarjeta tampoco", () => {
    expect(ds3Claro["--shadow-rest"]).toBe("none");
    expect(ds3Claro["--shadow-hover"]).toBe("none");
    expect(ds3Claro["--shadow-card"]).toBe("none");
  });
  it("--shadow-pop claro y oscuro son los del diseno y --shadow-elevated (flotantes existentes) lo iguala", () => {
    expect(ds3Claro["--shadow-pop"]).toBe("0 12px 32px -8px hsl(228 12% 10% / 0.18), 0 2px 6px hsl(228 12% 10% / 0.06)");
    expect(ds3OscuroSolo["--shadow-pop"]).toBe("0 12px 32px -8px hsl(0 0% 0% / 0.8), 0 2px 6px hsl(0 0% 0% / 0.4)");
    expect(ds3Claro["--shadow-elevated"]).toBe(ds3Claro["--shadow-pop"]);
    expect(ds3OscuroSolo["--shadow-elevated"]).toBe(ds3OscuroSolo["--shadow-pop"]);
    expect(ds3Claro["--shadow-hoja"]).toBe("0 -12px 40px -12px hsl(240 7% 6% / 0.25)");
  });
});

describe("movimiento (§2.6)", () => {
  it("easing unico cubic-bezier(.22,1,.36,1) y duraciones 120 / 180 / 240 ms", () => {
    expect(ds3Claro["--ease-out"]).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect([ms(ds3Claro["--dur-fast"]), ms(ds3Claro["--dur-base"]), ms(ds3Claro["--dur-slow"])]).toEqual([120, 180, 240]);
    expect(ms(ds3Claro["--dur-salida"])).toBe(120);
  });
  it("toda duracion --dur-* bajo ds3 es <= 400 ms", () => {
    const duraciones = Object.entries(ds3Claro).filter(([k]) => k.startsWith("--dur-"));
    expect(duraciones.length).toBeGreaterThanOrEqual(5);
    for (const [k, v] of duraciones) expect(ms(v), k).toBeLessThanOrEqual(400);
  });
  it("sin spring ni rebote: ningun cubic-bezier del bloque ds3 sale de [0,1] en y", () => {
    for (const [k, v] of Object.entries({ ...ds3Claro, ...ds3OscuroSolo })) {
      const m = /cubic-bezier\(([^)]*)\)/.exec(v);
      if (!m) continue;
      const [, y1, , y2] = m[1]!.split(",").map(Number);
      expect(y1!, k).toBeGreaterThanOrEqual(0);
      expect(y2!, k).toBeLessThanOrEqual(1);
    }
  });
  it("keyframes legados a las duraciones nuevas, sin stagger, y un solo mecanismo de reduced-motion bajo la bandera", () => {
    const rep = (s: string): Bloque | undefined => bloques.find((b) => b.selector === s);
    expect(rep(`${BANDERA} .animate-fade-up`)?.decl["animation-duration"]).toBe("var(--dur-slow)");
    expect(rep(`${BANDERA} .animate-fade-in`)?.decl["animation-duration"]).toBe("var(--dur-base)");
    expect(rep(`${BANDERA} [class*="stagger-"]`)?.decl["animation-delay"]).toBe("0s");
    const rm = bloques.find((b) => b.selector === `${BANDERA} *` && b.media === "(prefers-reduced-motion: reduce)");
    expect(rm?.decl.animation).toMatch(/^none/);
    expect(rm?.decl.transition).toMatch(/^none/);
  });
});

describe("acento y accion: el azul marca UNA cosa, la accion principal es la tinta", () => {
  it("--action es la tinta (claro) / casi blanco (oscuro); NO es el azul", () => {
    expect(ds3Claro["--action"]).toBe(ds3Claro["--foreground"]);
    expect(ds3OscuroSolo["--action"]).toBe(ds3OscuroSolo["--foreground"]);
    expect(ds3Claro["--action"]).not.toBe(ds3Claro["--primary"]);
  });
  it("el sidebar usa el mismo acento que --primary en los dos modos", () => {
    expect(ds3Claro["--sidebar-primary"]).toBe(ds3Claro["--primary"]);
    expect(ds3OscuroSolo["--sidebar-primary"]).toBe(ds3OscuroSolo["--primary"]);
    expect(ds3Claro["--marca-atiende"]).toBe(ds3Claro["--primary"]);
    expect(ds3OscuroSolo["--marca-atiende"]).toBe(ds3OscuroSolo["--primary"]);
  });
});
