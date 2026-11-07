// Utilidades de los specs de la hoja del shell ds3 (`src/ds3/shell.css`): la leen con postcss y devuelven las declaraciones reales.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Container, type Rule } from "postcss";

const aqui = dirname(fileURLToPath(import.meta.url));
export const CSS_SHELL = readFileSync(join(aqui, "../src/ds3/shell.css"), "utf8");
const raiz = postcss.parse(CSS_SHELL);

export interface BloqueCss {
  readonly selector: string;
  /** Condiciones de los @media que envuelven la regla, unidas con " and " ("" si ninguna). */
  readonly media: string;
  readonly decl: Readonly<Record<string, string>>;
}

function medias(nodo: Container | undefined): string {
  const partes: string[] = [];
  for (let p = nodo; p && p.type !== "root"; p = p.parent as Container | undefined) {
    if (p.type === "atrule" && (p as AtRule).name === "media") partes.unshift((p as AtRule).params);
  }
  return partes.join(" and ");
}

export const BLOQUES: readonly BloqueCss[] = (() => {
  const salida: BloqueCss[] = [];
  raiz.walkRules((regla: Rule) => {
    const decl: Record<string, string> = {};
    regla.walkDecls((d) => {
      if (d.parent === regla) decl[d.prop] = d.value.trim();
    });
    salida.push({ selector: regla.selector, media: medias(regla.parent as Container), decl });
  });
  return salida;
})();

/** Valor de `prop` en la primera regla cuyo selector contiene `fragmento` (y cuyo @media contiene `media`, si se pide). */
export function valorCss(fragmento: string, prop: string, media?: string): string | undefined {
  const b = BLOQUES.find((x) => x.selector.includes(fragmento) && (media === undefined || x.media.includes(media)) && prop in x.decl);
  return b?.decl[prop];
}

/** Cuerpo de un @keyframes por nombre (texto), o undefined. */
export function keyframes(nombre: string): string | undefined {
  let texto: string | undefined;
  raiz.walkAtRules(/keyframes$/, (r) => {
    if (r.params === nombre) texto = r.toString();
  });
  return texto;
}
