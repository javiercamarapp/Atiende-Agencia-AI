// Guard estatico del PR-9 de diseno-ux (migracion de licitaciones al DS v2): fija en 0 los
// patrones que el plan prohibe en web/verticals/licitaciones/** para que no reaparezcan
// (el guard global de CI llega en PR-12; este es el de esta vertical). Escanea el codigo
// SIN comentarios ni cadenas de documentacion.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RAIZ = join(fileURLToPath(new URL(".", import.meta.url)), "../src/superadmin");

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) return archivos(ruta);
    return /\.(tsx?)$/.test(nombre) ? [ruta] : [];
  });
}

/** Quita comentarios de linea y luego de bloque (primero los de linea: un comentario puede mencionar rutas con `/*`). Un `//` dentro de una URL en cadena puede recortar de mas: solo puede ocultar, nunca inventar, una coincidencia. */
function sinComentarios(codigo: string): string {
  return codigo.replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
}

const PALETA = "green|amber|red|yellow|blue|emerald|orange|slate|gray|zinc|sky|rose|stone|neutral|purple|indigo|teal|cyan|lime|pink|fuchsia|violet|white|black";

const REGLAS: ReadonlyArray<{ nombre: string; patron: RegExp; soloPaginas?: boolean }> = [
  { nombre: "window.confirm (usar useConfirm)", patron: /\bwindow\.confirm\s*\(|(^|[^.\w])confirm\s*\(\s*[`"']/m },
  { nombre: "tamano de texto arbitrario text-[Npx] (usar la escala text-2xs/xs/sm/base)", patron: /text-\[[0-9.]+px\]/ },
  { nombre: "paleta cruda de Tailwind (usar tokens o StatusBadge/Callout)", patron: new RegExp(`\\b(bg|text|border|ring|from|to|via|divide|fill|stroke)-(${PALETA})(-[0-9]+)?(/[0-9]+)?\\b`) },
  { nombre: "color hexadecimal literal", patron: /#[0-9a-fA-F]{3,8}\b(?![\w-])/ },
  { nombre: "estilo inline style={{...}}", patron: /style=\{\{/ },
  { nombre: "<select> crudo (usar NativeSelect)", patron: /<select[\s>]/ },
  { nombre: "<textarea> crudo (usar Textarea)", patron: /<textarea[\s>]/ },
  { nombre: 'checkbox crudo (usar Checkbox)', patron: /type="checkbox"/ },
  { nombre: "formatMoney local (usar formatMoney de @atiende/ui)", patron: /function\s+formatMoney\s*\(/, soloPaginas: true },
  { nombre: "ModalFormularioLateral (usar FormDialog de @atiende/ui)", patron: /ModalFormularioLateral/ },
  { nombre: "<Badge> con colores propios (usar StatusBadge)", patron: /<Badge[\s>]/ },
  { nombre: "relleno interno p-6 de pagina (usar PageContainer)", patron: /className="[^"]*\bp-6\b/ },
];

const FUENTES = archivos(RAIZ).map((ruta) => ({ ruta: relative(RAIZ, ruta), codigo: sinComentarios(readFileSync(ruta, "utf8")) }));

describe("superadmin — guard del DS v2 (baseline 0)", () => {
  it("encuentra los archivos de la vertical (no escanea un directorio vacio)", () => {
    expect(FUENTES.length).toBeGreaterThan(25);
  });

  for (const regla of REGLAS) {
    it(`sin ${regla.nombre}`, () => {
      const candidatos = regla.soloPaginas ? FUENTES.filter((f) => f.ruta.startsWith("pages")) : FUENTES;
      const infractores = candidatos.filter((f) => regla.patron.test(f.codigo)).map((f) => f.ruta);
      expect(infractores).toEqual([]);
    });
  }
});
