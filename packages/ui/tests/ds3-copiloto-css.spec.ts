// ds3 / «Pregúntale a tus datos»: guard de la hoja `src/ds3/copiloto.css` (lee la hoja REAL con postcss). Afirma que (1) toda regla
// cuelga de html[data-diseno="ds3"] (sin la bandera nada coincide: produccion igual), (2) sin colores literales, (3) sin !important,
// (4) movimiento <= 400 ms y solo bajo prefers-reduced-motion: no-preference, (5) el entrypoint la importa despues de la hoja del shell,
// y (6) las medidas de la referencia: historial = Drawer sm de 420 a 8 px (hoja de 90dvh < 820), filas de 40, grupos 12/600,
// compositor de radio 12 con padding 8 y texto de 15, portada 20/600 y controles de 32 con radio 8.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Container, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const aqui = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(aqui, "../src/ds3/copiloto.css"), "utf8");
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
function enKeyframes(r: Rule): boolean {
  for (let p = r.parent as Container | undefined; p && p.type !== "root"; p = p.parent as Container | undefined) {
    if (p.type === "atrule" && /keyframes$/.test((p as AtRule).name)) return true;
  }
  return false;
}
const bloques: Bloque[] = [];
raiz.walkRules((r: Rule) => {
  if (enKeyframes(r)) return;
  const decl: Record<string, string> = {};
  r.walkDecls((d) => {
    if (d.parent === r) decl[d.prop] = d.value.trim();
  });
  bloques.push({ selector: r.selector, media: medias(r.parent as Container), decl });
});
const valor = (fragmento: string, prop: string, media?: string) =>
  bloques.find((b) => b.selector.includes(fragmento) && (media === undefined ? !b.media.includes("max-width") : b.media.includes(media)) && prop in b.decl)?.decl[prop];

describe("ds3/copiloto.css: guard", () => {
  it("tiene reglas y TODA regla cuelga de la bandera", () => {
    expect(bloques.length).toBeGreaterThan(20);
    const fuera = bloques.flatMap((b) => b.selector.split(",").map((s) => s.trim())).filter((s) => !s.startsWith(BANDERA));
    expect(fuera).toEqual([]);
  });

  it("sin colores literales (solo tokens) ni !important", () => {
    const sinComentarios = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(sinComentarios).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(sinComentarios).not.toMatch(/\b(rgba?|hsla?)\(\s*(?!var\()[0-9]/);
    const imp: string[] = [];
    raiz.walkDecls((d) => {
      if (d.important) imp.push(d.prop);
    });
    expect(imp).toEqual([]);
  });

  it("toda animacion vive bajo prefers-reduced-motion: no-preference y dura <= 400 ms", () => {
    const fuera: string[] = [];
    const largas: string[] = [];
    raiz.walkDecls((d) => {
      if (!/^(transition|animation)(-duration|-delay)?$/.test(d.prop)) return;
      const regla = d.parent as Rule;
      if (d.prop.startsWith("animation") && d.value !== "none" && !medias(regla.parent as Container).includes("prefers-reduced-motion: no-preference")) fuera.push(regla.selector);
      for (const m of d.value.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
        const n = m[2] === "s" ? parseFloat(m[1]!) * 1000 : parseFloat(m[1]!);
        if (n > 400) largas.push(`${regla.selector}: ${d.value}`);
      }
    });
    expect(fuera).toEqual([]);
    expect(largas).toEqual([]);
  });

  it("reutiliza las keyframes del Drawer de shell.css (no las duplica)", () => {
    expect(css).toContain("ds3-drawer-entra");
    expect(css).toContain("ds3-hoja-entra");
    expect(css).not.toMatch(/@keyframes ds3-drawer-/);
  });

  it("el entrypoint de apps/web la importa despues de la hoja del shell, y el paquete la exporta", () => {
    const entrada = readFileSync(join(aqui, "../../../apps/web/src/index.css"), "utf8");
    expect(entrada.indexOf("@atiende/ui/ds3-copiloto.css")).toBeGreaterThan(entrada.indexOf("@atiende/ui/ds3-shell.css"));
    const paquete = JSON.parse(readFileSync(join(aqui, "../package.json"), "utf8")) as { exports: Record<string, string> };
    expect(paquete.exports["./ds3-copiloto.css"]).toBe("./src/ds3/copiloto.css");
  });
});

describe("ds3/copiloto.css: medidas de la referencia", () => {
  it("historial: Drawer sm de 420 px a 8 px del borde, radio 12, sombra pop y velo", () => {
    expect(valor(".ds3-copiloto-hist.ds3-copiloto-hist", "width")).toBe("min(420px, calc(100vw - 16px))");
    for (const lado of ["top", "right", "bottom"]) expect(valor(".ds3-copiloto-hist.ds3-copiloto-hist", lado)).toBe("8px");
    expect(valor(".ds3-copiloto-hist.ds3-copiloto-hist", "border-radius")).toBe("12px");
    expect(valor(".ds3-copiloto-hist.ds3-copiloto-hist", "box-shadow")).toBe("var(--shadow-pop)");
    expect(valor(".ds3-copiloto-velo", "background")).toBe("var(--scrim)");
  });

  it("historial < 820 px: hoja inferior de 90dvh con radio 16 arriba, agarradera y sin logo", () => {
    expect(valor(".ds3-copiloto-hist.ds3-copiloto-hist", "height", "max-width: 819.98px")).toBe("90dvh");
    expect(valor(".ds3-copiloto-hist.ds3-copiloto-hist", "border-radius", "max-width: 819.98px")).toBe("16px 16px 0 0");
    expect(valor(".ds3-copiloto-hist-agarre", "display", "max-width: 819.98px")).toBe("flex");
    expect(valor(".ds3-copiloto-hist-marca", "display", "max-width: 819.98px")).toBe("none");
  });

  it("filas de 40 px, grupos 12/600 en mayusculas heredadas, «Chat nuevo» primario suave y logo al 60 %", () => {
    expect(valor(".ds3-copiloto-hist-titulo.ds3-copiloto-hist-titulo", "height")).toBe("40px");
    expect(valor(".ds3-copiloto-hist-grupo.ds3-copiloto-hist-grupo", "font-size")).toBe("12px");
    expect(valor(".ds3-copiloto-hist-grupo.ds3-copiloto-hist-grupo", "font-weight")).toBe("600");
    expect(valor(".ds3-copiloto-hist-nuevo.ds3-solo[hidden]", "background-color")).toBe("hsl(var(--primary-soft))");
    expect(valor(".ds3-copiloto-hist-marca", "opacity")).toBe("0.6");
  });

  it("compositor de radio 12 con padding 8, texto de 15/22 y portada 20/600", () => {
    expect(valor('[data-ds3="compositor"]', "border-radius")).toBe("12px");
    expect(valor('[data-ds3="compositor"]', "padding")).toBe("8px");
    expect(valor('[data-ds3="texto"]', "font-size")).toBe("15px");
    expect(valor('[data-ds3="titulo"]', "font-size")).toBe("20px");
    expect(valor('[data-ds3="titulo"]', "font-weight")).toBe("600");
  });

  it("controles de 32 px (36 en celular) con radio 8 y 13 px; acento del campo de puntos = accion de Atiende", () => {
    expect(valor("[data-ds3-copiloto]", "--ds3-ctl-h")).toBe("32px");
    expect(valor("[data-ds3-copiloto]", "--ds3-ctl-h", "max-width: 767.98px")).toBe("36px");
    expect(valor(".ds3-copiloto-ctl.ds3-copiloto-ctl", "border-radius")).toBe("8px");
    expect(valor(".ds3-copiloto-ctl.ds3-copiloto-ctl", "font-size")).toBe("13px");
    expect(valor("[data-ds3-copiloto]", "--copiloto-acento")).toBe("var(--action)");
  });

  it("con temas, «Consulta» y los chips sueltos se apagan", () => {
    const b = bloques.find((x) => x.selector.includes('[data-ds3="consulta"]'));
    expect(b?.selector).toContain('[data-ds3="chips-con-temas"]');
    expect(b?.decl.display).toBe("none");
  });
});
