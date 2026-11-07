// i18n ES/EN — paginas por vertical (`packages/ui/src/i18n/mensajes/<vertical>/<modulo>.ts`). El espanol de cada modulo se registra
// cuando quien lo usa lo pasa a `useT(...)` / `traductorActivo(...)`, asi viaja en el chunk de la pagina y no en el de arranque. Si
// un archivo traduce claves de un modulo sin importarlo, en produccion pintaria la clave cruda y el typecheck no lo ve: aqui se exige
// archivo por archivo. Solo cuentan las claves que existen en el catalogo (un id como "restaurantes.pedido.nuevo" no es texto).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const mensajes = path.join(raiz, "packages/ui/src/i18n/mensajes");
const VERTICALES = readdirSync(mensajes, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "en")
  .map((d) => d.name);

function fuentes(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : fuentes(p);
    return /\.(ts|tsx)$/.test(n) && !n.endsWith(".d.ts") ? [p] : [];
  });
}

describe("modulos de pagina importados por quien los usa", () => {
  it("hay al menos una vertical con paginas migradas", () => {
    expect(VERTICALES.length).toBeGreaterThan(0);
  });

  it("cada archivo que usa claves de un modulo de pagina importa ese modulo", () => {
    const faltan: string[] = [];
    for (const vertical of VERTICALES) {
      // clave -> modulo que la declara
      const moduloDe = new Map<string, string>();
      for (const archivo of readdirSync(path.join(mensajes, vertical)).filter((n) => n.endsWith(".ts") && n !== "index.ts")) {
        for (const m of readFileSync(path.join(mensajes, vertical, archivo), "utf8").matchAll(/^\s*"([^"]+)":/gm)) moduloDe.set(m[1] as string, archivo.replace(/\.ts$/, ""));
      }
      const patron = new RegExp(`["'\`](${vertical}\\.[A-Za-z0-9_.]+)["'\`]`, "g");
      for (const f of fuentes(path.join(raiz, "apps/web/src"))) {
        const codigo = readFileSync(f, "utf8");
        const modulos = new Set<string>();
        for (const m of codigo.matchAll(patron)) {
          const modulo = moduloDe.get(m[1] as string);
          if (modulo) modulos.add(modulo);
        }

        for (const modulo of modulos) {
          if (!codigo.includes(`@atiende/ui/i18n/${vertical}/${modulo}"`)) faltan.push(`${path.relative(raiz, f)} usa claves de ${vertical}/${modulo} sin importar su modulo`);
        }
      }
    }
    expect(faltan).toEqual([]);
  });
});
