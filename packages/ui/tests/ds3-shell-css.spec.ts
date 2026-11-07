// ds3 / lote 5 (shell): guard de la hoja `src/ds3/shell.css`. Lee la hoja REAL con postcss y afirma que (1) toda regla cuelga de la
// bandera html[data-diseno="ds3"] (sin ella nada coincide: produccion igual), (2) no hay colores literales (solo tokens), (3) ningun
// !important, (4) duraciones <= 400 ms salvo la respiracion del logo y el seguro del arranque, (5) el entrypoint la importa DESPUES de la hoja
// de la UI, y (6) los valores de referencia del marco: padding/gap 16, tarjetas de 1 px con radio 12 sin sombra, contenido 24/24/28.
// Solo AÑADE: no toca ningun spec existente.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Container, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const aqui = dirname(fileURLToPath(import.meta.url));
const RUTA = join(aqui, "../src/ds3/shell.css");
const css = readFileSync(RUTA, "utf8");
const raiz = postcss.parse(css);
const BANDERA = 'html[data-diseno="ds3"]';

interface Bloque {
  selector: string;
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

function dentroDeKeyframes(regla: Rule): boolean {
  for (let p = regla.parent as Container | undefined; p && p.type !== "root"; p = p.parent as Container | undefined) {
    if (p.type === "atrule" && /keyframes$/.test((p as AtRule).name)) return true;
  }
  return false;
}

const bloques: Bloque[] = [];
raiz.walkRules((regla: Rule) => {
  if (dentroDeKeyframes(regla)) return;
  const decl: Record<string, string> = {};
  regla.walkDecls((d) => {
    if (d.parent === regla) decl[d.prop] = d.value.trim();
  });
  bloques.push({ selector: regla.selector, media: medias(regla.parent as Container), decl });
});

/** Declaracion `prop` de la regla cuyo selector contiene `fragmento` (y opcionalmente dentro de un @media que contiene `media`). */
function valor(fragmento: string, prop: string, media?: string): string | undefined {
  const b = bloques.find((x) => x.selector.includes(fragmento) && (media === undefined || x.media.includes(media)) && prop in x.decl);
  return b?.decl[prop];
}

function ms(texto: string): number[] {
  return [...texto.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)].map((m) => (m[2] === "s" ? parseFloat(m[1]!) * 1000 : parseFloat(m[1]!)));
}

describe("ds3/shell.css: guard de la hoja del shell", () => {
  it("la hoja tiene reglas (no pasa en vacio)", () => {
    expect(bloques.length).toBeGreaterThan(5);
  });

  it("toda regla (cada selector de la lista) cuelga de html[data-diseno=\"ds3\"]", () => {
    const fuera: string[] = [];
    for (const b of bloques) {
      for (const sel of b.selector.split(",").map((s) => s.trim())) {
        if (!sel.startsWith(BANDERA)) fuera.push(sel);
      }
    }
    expect(fuera, `selectores fuera de la bandera: ${fuera.join(" | ")}`).toEqual([]);
  });

  it("sin colores literales: ni hex ni rgb/hsl con numeros (solo hsl(var(--token)) y palabras de sistema)", () => {
    const sinComentarios = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(sinComentarios).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(sinComentarios).not.toMatch(/\b(rgba?|hsla?)\(\s*(?!var\()[0-9]/);
    expect(sinComentarios).not.toMatch(/\b(oklch|oklab|lab|lch)\(/);
  });

  it("sin !important (gana por especificidad: doble clase o atributo)", () => {
    const conImportant: string[] = [];
    raiz.walkDecls((d) => {
      if (d.important) conImportant.push(`${(d.parent as Rule).selector} { ${d.prop} }`);
    });
    expect(conImportant).toEqual([]);
  });

  it("duraciones de transicion y animacion <= 400 ms (la respiracion del logo y el seguro del arranque son las unicas excepciones)", () => {
    const largas: string[] = [];
    raiz.walkDecls((d) => {
      if (!/^(transition|animation)(-duration|-delay)?$/.test(d.prop)) return;
      const valorTexto = d.value;
      if (/ds3-respira|ds3-arranque-tope/.test(valorTexto)) return;
      if (ms(valorTexto).some((n) => n > 400)) largas.push(`${(d.parent as Rule).selector} { ${d.prop}: ${valorTexto} }`);
    });
    expect(largas).toEqual([]);
  });

  it("el entrypoint de apps/web importa la hoja del shell DESPUES de la hoja de la UI", () => {
    const entrada = readFileSync(join(aqui, "../../../apps/web/src/index.css"), "utf8");
    expect(entrada).toContain('@import "@atiende/ui/ds3-shell.css"');
    expect(entrada.indexOf("@atiende/ui/ds3-shell.css")).toBeGreaterThan(entrada.indexOf("@atiende/ui/styles.css"));
    const paquete = JSON.parse(readFileSync(join(aqui, "../package.json"), "utf8")) as { exports: Record<string, string> };
    expect(paquete.exports["./ds3-shell.css"]).toBe("./src/ds3/shell.css");
  });
});

describe("ds3/shell.css: marco (escritorio >= 768)", () => {
  it("lienzo con padding 16 y gap 16 sobre --background", () => {
    expect(valor(".ds3-shell.ds3-shell", "padding", "min-width: 768px")).toBe("16px");
    expect(valor(".ds3-shell.ds3-shell", "gap", "min-width: 768px")).toBe("16px");
    expect(valor(".ds3-shell.ds3-shell", "background-color", "min-width: 768px")).toBe("hsl(var(--background))");
  });

  it("sidebar y marco son tarjetas blancas de 1 px, radio 12 y sin sombra, a toda la altura menos el lienzo", () => {
    for (const clase of [".ds3-shell-marco.ds3-shell-marco", ".ds3-sidebar.ds3-sidebar"]) {
      expect(valor(clase, "border", "min-width: 768px")).toBe("1px solid hsl(var(--border))");
      expect(valor(clase, "border-radius", "min-width: 768px")).toBe("12px");
      expect(valor(clase, "background-color", "min-width: 768px")).toBe("hsl(var(--card))");
      expect(valor(clase, "box-shadow", "min-width: 768px")).toBe("none");
      expect(valor(clase, "height", "min-width: 768px")).toBe("calc(100dvh - 32px)");
    }
  });

  it("el contenido es el tercer gris (--sunken) con padding 24/24/28 y su propio scroll estable", () => {
    expect(valor(".ds3-shell-contenido", "padding", "min-width: 768px")).toBe("24px 24px 28px");
    expect(valor(".ds3-shell-contenido", "background-color", "min-width: 768px")).toBe("hsl(var(--sunken))");
    expect(valor(".ds3-shell-contenido", "scrollbar-gutter", "min-width: 768px")).toBe("stable");
  });

  it("los elementos solo-ds3 se revelan con la bandera y los reemplazados se ocultan", () => {
    expect(valor(".ds3-solo[hidden]", "display")).toBe("block");
    expect(valor(".ds3-no.ds3-no", "display")).toBe("none");
  });

  it("forced-colors: las tarjetas conservan su contorno con el color del sistema", () => {
    const b = bloques.find((x) => x.media.includes("forced-colors: active") && x.selector.includes(".ds3-shell-marco"));
    expect(b?.decl.border).toBe("1px solid CanvasText");
  });
});
