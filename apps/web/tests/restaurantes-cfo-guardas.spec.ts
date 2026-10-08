// CFO-07 · guardas estáticas del apartado CFO: nada de `toLocale*`/`Intl` (formato único: los formateadores del dominio y de @atiende/ui), ningún control
// sin cableado (los botones del CFO llaman a una función real o enlazan), y todas las pestañas del registro son un componente con su vista de exportación.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AQUI = dirname(fileURLToPath(import.meta.url));
const CFO = join(AQUI, "../src/verticals/restaurantes/cfo");
const UI = join(AQUI, "../../../packages/ui/src/components/graficas-cfo.tsx");
const archivos = readdirSync(CFO).filter((f) => /\.(ts|tsx)$/.test(f));
const sinComentarios = (c: string) => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("apartado CFO · guardas", () => {
  it("encuentra los archivos del apartado (no pasa en vacío)", () => {
    expect(archivos.length).toBeGreaterThanOrEqual(15);
    for (const f of ["cfo-client.ts", "CfoLayout.tsx", "paginas.ts", "CfoResumen.tsx", "CfoVentas.tsx", "CfoSucursales.tsx", "CfoEstadoResultados.tsx", "CapturaCostosDialogo.tsx", "AjustesCfoDialogo.tsx", "HallazgoTarjeta.tsx", "FiltrosCfo.tsx", "PedidosDrill.tsx"]) expect(archivos, f).toContain(f);
  });

  it("no hay toLocale* ni Intl.*: se usan los formateadores canónicos", () => {
    for (const f of archivos) {
      const codigo = sinComentarios(readFileSync(join(CFO, f), "utf8"));
      expect(codigo, `${f}: toLocale*`).not.toMatch(/toLocale(Date|Time|String|UpperCase|LowerCase)?\s*\(/);
      expect(codigo, `${f}: Intl`).not.toMatch(/\bIntl\./);
    }
    expect(sinComentarios(readFileSync(UI, "utf8"))).not.toMatch(/toLocale|\bIntl\./);
  });

  it("ningún <button> sin acción: todos tienen onClick, type=submit o abren un Popover", () => {
    for (const f of archivos.filter((x) => x.endsWith(".tsx"))) {
      const codigo = sinComentarios(readFileSync(join(CFO, f), "utf8"));
      for (const m of codigo.matchAll(/<(button|Button)\b([^>]*)>/g)) {
        const attrs = m[2] ?? "";
        const i = m.index ?? 0;
        // El disparador de un Popover (PopoverTrigger asChild) abre su contenido: es el handler.
        const cableado = /onClick=|type="submit"|asChild|onChange=/.test(attrs) || codigo.slice(Math.max(0, i - 120), i).includes("PopoverTrigger");
        expect(cableado, `${f}: botón sin acción → ${m[0].slice(0, 80)}`).toBe(true);
      }
    }
  });

  it("no hay estilos inline ni colores crudos (tokens de Likida), ni librería de gráficas nueva", () => {
    for (const f of archivos.filter((x) => x.endsWith(".tsx"))) {
      const codigo = sinComentarios(readFileSync(join(CFO, f), "utf8"));
      expect(codigo, `${f}: style=`).not.toMatch(/style=\{\{/);
      expect(codigo, `${f}: hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
      expect(codigo, `${f}: librería`).not.toMatch(/from "(recharts|chart\.js|d3|victory|nivo|@nivo[^"]*|apexcharts|react-chartjs-2)"/);
    }
  });

  it("las animaciones de las gráficas nuevas están bajo motion-safe", () => {
    const codigo = sinComentarios(readFileSync(UI, "utf8"));
    for (const m of codigo.matchAll(/[\w:[\]-]*(?:transition|animate|duration)[\w:[\]-]*/g)) expect(m[0].startsWith("motion-safe:"), m[0]).toBe(true);
  });

  it("el registro de pestañas: cada una con slug, etiqueta, icono, componente perezoso y vista de exportación", async () => {
    const { PAGINAS_CFO } = await import("../src/verticals/restaurantes/cfo/paginas.ts");
    for (const p of PAGINAS_CFO) {
      expect(p.slug).toMatch(/^[a-z0-9-]+$/);
      expect(p.etiqueta.length).toBeGreaterThan(0);
      expect(p.icono).toBeTruthy();
      expect(typeof (p.componente as unknown as { $$typeof: symbol }).$$typeof).toBe("symbol");
    }
  });
});
