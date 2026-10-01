// Guard estatico GLOBAL del PR-11 de diseno-ux: fija en 0 los patrones que el plan prohibe en TODO
// apps/web/src (shell, paginas publicas, componentes, superadmin y las 6 verticales) para que no
// reaparezcan. Los guards por vertical (restaurantes, hoteles, rentas, despachos, licitaciones,
// superadmin) son un subconjunto de este y se consolidan en PR-12. Escanea el codigo SIN comentarios.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RAIZ = join(fileURLToPath(new URL(".", import.meta.url)), "../src");

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
  { nombre: "<table> crudo (usar Table o DataTable de @atiende/ui)", patron: /<table[\s>]/ },
  { nombre: "<Badge> con colores propios (usar StatusBadge)", patron: /<Badge[\s>]/ },
  { nombre: "relleno interno p-6 de pagina (usar PageContainer)", patron: /className="[^"]*\bp-6\b/ },
];

const FUENTES = archivos(RAIZ).map((ruta) => ({ ruta: relative(RAIZ, ruta), codigo: sinComentarios(readFileSync(ruta, "utf8")) }));

describe("apps/web/src — guard global del DS v2 (baseline 0)", () => {
  it("encuentra los archivos de la app (no escanea un directorio vacio)", () => {
    expect(FUENTES.length).toBeGreaterThan(200);
  });

  for (const regla of REGLAS) {
    it(`sin ${regla.nombre}`, () => {
      const candidatos = regla.soloPaginas ? FUENTES.filter((f) => /(^|\/)pages\//.test(f.ruta)) : FUENTES;
      const infractores = candidatos.filter((f) => regla.patron.test(f.codigo)).map((f) => f.ruta);
      expect(infractores).toEqual([]);
    });
  }
});
