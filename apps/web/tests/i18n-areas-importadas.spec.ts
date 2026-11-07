// i18n ES/EN: el espanol de cada modulo de area se registra al IMPORTAR su archivo (viaja con el chunk de quien lo usa). Si un
// archivo usa claves de un area sin importarla, en produccion pintaria la clave cruda y el typecheck no lo ve. Esta prueba lo
// exige archivo por archivo, y que @atiende/ui no declare `sideEffects: false` (Rollup tiraria esos imports laterales).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const carpetaMensajes = path.join(raiz, "packages/ui/src/i18n/mensajes");
const AREAS = readdirSync(carpetaMensajes).filter((f) => f.endsWith(".ts") && f !== "index.ts").map((f) => f.replace(/\.ts$/, ""));

/** Fuentes de apps/web y packages/ui, sin el nucleo i18n (sus comentarios citan claves de ejemplo). */
function fuentes(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" || p === path.dirname(carpetaMensajes) ? [] : fuentes(p);
    return /\.(ts|tsx)$/.test(n) && !n.endsWith(".d.ts") ? [p] : [];
  });
}

describe("modulos de area importados por quien los usa", () => {
  it("cada archivo que usa claves de un area importa ese modulo", () => {
    const faltan: string[] = [];
    const patron = new RegExp(`["'\`](${AREAS.join("|")})\\.[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+)*["'\`]`, "g");
    for (const f of [...fuentes(path.join(raiz, "apps/web/src")), ...fuentes(path.join(raiz, "packages/ui/src"))]) {
      const codigo = readFileSync(f, "utf8");
      const usadas = new Set([...codigo.matchAll(patron)].map((m) => m[1] as string));
      for (const area of usadas) {
        const importa = codigo.includes(`@atiende/ui/i18n/${area}"`) || codigo.includes(`mensajes/${area}.ts"`);
        if (!importa) faltan.push(`${path.relative(raiz, f)} usa «${area}.*» sin importar su modulo`);
      }
    }
    expect(faltan).toEqual([]);
  });

  it("@atiende/ui no declara sideEffects: false", () => {
    const pkg = JSON.parse(readFileSync(path.join(raiz, "packages/ui/package.json"), "utf8")) as { sideEffects?: unknown };
    expect(pkg.sideEffects).not.toBe(false);
  });
});
