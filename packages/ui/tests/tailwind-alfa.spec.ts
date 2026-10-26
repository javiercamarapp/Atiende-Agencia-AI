// Lote 1.1 del rediseno ds3: compila Tailwind 3.4 de verdad (postcss) con el preset y confirma que los tripletes HSL
// ("224 76% 48%" dentro de hsl(var(--x))) componen alfa con el modificador `/N`. El preset no usa <alpha-value>:
// el plan de ds3 depende de bg-primary/10, border-destructive/40 y bg-sunken/50.
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import preset from "../src/tailwind-preset.ts";

async function compilar(clases: string): Promise<string> {
  const resultado = await postcss([
    tailwindcss({
      presets: [preset],
      content: [{ raw: clases, extension: "html" }],
      corePlugins: { preflight: false },
    }),
  ]).process("@tailwind utilities;", { from: undefined });
  return resultado.css;
}

/** Cuerpo del bloque de la clase (el selector va escapado en el CSS). */
function regla(css: string, clase: string): string {
  const escapada = clase.replace(/[/:.]/g, (c) => `\\${c}`);
  const i = css.indexOf(`.${escapada}`);
  expect(i, `${clase} no se genero`).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf("}", i) + 1);
}

describe("alfa sobre colores del preset (Tailwind 3.4 real)", () => {
  it.each([
    ["bg-primary/10", "background-color", "hsl(var(--primary) / 0.1)"],
    ["border-destructive/40", "border-color", "hsl(var(--destructive) / 0.4)"],
    ["bg-sunken/50", "background-color", "hsl(var(--sunken) / 0.5)"],
  ])("%s", async (clase, propiedad, valor) => {
    const css = await compilar(clase);
    const r = regla(css, clase);
    expect(r).toContain(`${propiedad}: ${valor}`);
  });

  it("los colores nuevos tambien componen alfa", async () => {
    const clases = ["bg-primary-soft/50", "text-primary-ink/80", "bg-action/90", "border-border-strong/40", "bg-soft/60", "bg-danger-tint/50", "text-success-ink/90", "bg-chart-6/20", "bg-chart-soft-3/50", "text-on-chart-2/90"];
    const css = await compilar(clases.join(" "));
    const esperado: Record<string, string> = {
      "bg-primary-soft/50": "hsl(var(--primary-soft) / 0.5)",
      "text-primary-ink/80": "hsl(var(--primary-ink) / 0.8)",
      "bg-action/90": "hsl(var(--action) / 0.9)",
      "border-border-strong/40": "hsl(var(--border-strong) / 0.4)",
      "bg-soft/60": "hsl(var(--soft) / 0.6)",
      "bg-danger-tint/50": "hsl(var(--danger-tint) / 0.5)",
      "text-success-ink/90": "hsl(var(--success-ink) / 0.9)",
      "bg-chart-6/20": "hsl(var(--chart-6) / 0.2)",
      "bg-chart-soft-3/50": "hsl(var(--chart-soft-3) / 0.5)",
      "text-on-chart-2/90": "hsl(var(--on-chart-2) / 0.9)",
    };
    for (const clase of clases) expect(regla(css, clase), clase).toContain(esperado[clase]!);
  });

  it("sin modificador sale el color pleno y shadow-pop usa su variable", async () => {
    const css = await compilar("bg-primary-soft text-primary-ink shadow-pop");
    expect(regla(css, "bg-primary-soft")).toContain("hsl(var(--primary-soft)");
    expect(regla(css, "shadow-pop")).toContain("var(--shadow-pop)");
  });
});
