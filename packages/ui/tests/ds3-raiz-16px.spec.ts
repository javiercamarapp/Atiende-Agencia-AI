// ds3: la raiz <html> conserva 16 px. El cuerpo va a 13 px (0.8125rem SOLO en body); si la raiz bajara a 13 px, todo lo que mide en
// rem (alturas h-*, radios, paddings, --control-*, escala text-*) encogeria al 81 % (cuerpo de 10,6 px, encabezado de 36 en vez de 44).
// Lee index.css real con postcss. Solo AÑADE.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = postcss.parse(readFileSync(join(aqui, "../src/index.css"), "utf8"));
const BANDERA = 'html[data-diseno="ds3"]';

describe("ds3 — tamano de la raiz", () => {
  it("ninguna regla da font-size al propio <html> bajo la bandera (con o sin .dark)", () => {
    const culpables: string[] = [];
    raiz.walkRules((r: Rule) => {
      const selectores = r.selector.split(",").map((x) => x.trim());
      const alHtml = selectores.some((x) => x === BANDERA || x === `${BANDERA}.dark` || x === `.dark${BANDERA}`);
      if (!alHtml) return;
      r.walkDecls("font-size", (d) => {
        if (d.parent === r) culpables.push(`${r.selector} { font-size: ${d.value} }`);
      });
    });
    expect(culpables).toEqual([]);
  });

  it("el cuerpo sigue en 13 px (0.8125rem sobre la raiz de 16)", () => {
    let valor: string | undefined;
    raiz.walkRules((r: Rule) => {
      if (r.selector.split(",").map((x) => x.trim()).includes(`${BANDERA} body`)) {
        r.walkDecls("font-size", (d) => {
          if (d.parent === r) valor = d.value;
        });
      }
    });
    expect(valor).toBe("0.8125rem");
  });
});
