// @vitest-environment jsdom
//
// ds3 / componentes de contenido, parte 2 (PARIDAD-ATIENDE-ROVAQ §R1 #6, #9 y P2 de radios): ganchos de marcado y reglas de
// ds3/contenido.css para (1) periodo segmentado en azul suave y en una linea, (2) aviso de agregados como callout de Rovaq y nunca sobre
// el chat, (3) primario solido suelto -> primario suave, (4) tarjetas de radio 12 / padding 14 / 1 px, (5) th Hanken 13/600 y tabla
// dentro de tarjeta. La bandera vive en CSS: sin ella las clases de Likida no cambian (las fijan resumen-piezas y consola-kit). Solo AÑADE.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { GlobalFilter, RadioSegmentado, resolverRango } from "@atiende/ui";
import { BannerAgregados } from "../src/verticals/restaurantes/components/operacion/BannerAgregados.tsx";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/ui/src/ds3/contenido.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const FUENTE_BANNER = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/verticals/restaurantes/components/operacion/BannerAgregados.tsx"), "utf8");

/** Cuerpo de la regla cuyo selector (texto antes de la llave) contiene `fragmento`. */
function regla(fragmento: string): string {
  const i = CSS.indexOf(fragmento);
  expect(i, `falta la regla ${fragmento}`).toBeGreaterThanOrEqual(0);
  const abre = CSS.indexOf("{", i);
  return CSS.slice(abre + 1, CSS.indexOf("}", abre));
}

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

describe("periodo segmentado (RadioSegmentado / GlobalFilter)", () => {
  it("RadioSegmentado lleva el gancho ds3-segmentado y conserva sus clases de Likida", () => {
    rendered = renderComponent(
      <RadioSegmentado name="p" label="Periodo" opciones={[{ id: "7", rotulo: "7 días" }, { id: "30", rotulo: "30 días" }]} value="30" onChange={() => {}} />,
    );
    const grupo = rendered.container.querySelector('[role="radiogroup"]')!;
    expect(grupo.classList.contains("ds3-segmentado")).toBe(true);
    expect(grupo.className).toContain("flex flex-wrap gap-2");
    expect(rendered.container.querySelectorAll("label")[1]!.className).toContain("bg-primary text-primary-foreground");
  });

  it("GlobalFilter marca cada opcion con data-ds3-segmento y la activa con aria-current", () => {
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/x?rango=30"]}>
        <GlobalFilter base="/x" r={resolverRango("30", "7")} />
      </MemoryRouter>,
    );
    const enlaces = [...rendered.container.querySelectorAll("a")];
    expect(enlaces).toHaveLength(3);
    for (const a of enlaces) expect(a.hasAttribute("data-ds3-segmento")).toBe(true);
    expect(enlaces.filter((a) => a.getAttribute("aria-current") === "true").map((a) => a.textContent)).toEqual(["30d"]);
  });

  it("CSS: pildora de 1 px en una linea (sin envolver, con scroll), opciones de 28 px radio 8 y activa en azul suave", () => {
    const cont = regla('html[data-diseno="ds3"] .ds3-segmentado.ds3-segmentado,');
    expect(cont).toMatch(/flex-wrap: nowrap;/);
    expect(cont).toMatch(/overflow-x: auto;/);
    expect(cont).toMatch(/justify-content: flex-start;/);
    expect(cont).toMatch(/border: 1px solid hsl\(var\(--border\)\);/);
    const op = regla('html[data-diseno="ds3"] .ds3-segmentado.ds3-segmentado > label,');
    expect(op).toMatch(/height: 28px;/);
    expect(op).toMatch(/border-radius: 8px;/);
    const activa = regla("label:has(> input:checked),");
    expect(activa).toMatch(/background-color: hsl\(var\(--primary-soft\)\);/);
    expect(activa).toMatch(/color: hsl\(var\(--primary-ink\)\);/);
    expect(CSS).toMatch(/\[data-ds3-segmento\]\[data-ds3-segmento\]\[aria-current="true"\] \{/);
  });
});

describe("aviso de agregados y primario suave", () => {
  it("BannerAgregados lleva los ganchos ds3-aviso / ds3-aviso-texto / ds3-aviso-cta", () => {
    expect(FUENTE_BANNER).toMatch(/className="ds3-aviso mb-3/);
    expect(FUENTE_BANNER).toMatch(/className="ds3-aviso-texto /);
    expect(FUENTE_BANNER).toMatch(/className="ds3-aviso-cta /);
    expect(typeof BannerAgregados).toBe("function");
  });

  it("CSS: aviso teñido de 1 px radio 12, CTA de 30 px radio 8 en tinta azul, y oculto en el chat", () => {
    const a = regla('html[data-diseno="ds3"] .ds3-aviso.ds3-aviso {');
    expect(a).toMatch(/border: 1px solid hsl\(var\(--primary\) \/ 0\.3\);/);
    expect(a).toMatch(/border-radius: 12px;/);
    expect(a).toMatch(/background-color: hsl\(var\(--primary-soft\)\);/);
    const cta = regla('html[data-diseno="ds3"] .ds3-aviso-cta.ds3-aviso-cta {');
    expect(cta).toMatch(/height: 30px;/);
    expect(cta).toMatch(/border-radius: 8px;/);
    expect(cta).toMatch(/color: hsl\(var\(--primary-ink\)\);/);
    expect(regla('.ds3-shell-marco[data-pantalla="chat"] .ds3-aviso.ds3-aviso')).toMatch(/display: none;/);
  });

  it("CSS: el primario solido suelto pasa a azul suave, sin tocar switch/checkbox/radio/pestana ni el Button ds3", () => {
    const sel = 'html[data-diseno="ds3"] main :is(a, button).bg-primary.text-primary-foreground:not(.ds3-btn, [role="switch"], [role="checkbox"], [role="radio"], [role="tab"])';
    const r = regla(sel);
    expect(r).toMatch(/background-color: hsl\(var\(--primary-soft\)\);/);
    expect(r).toMatch(/color: hsl\(var\(--primary-ink\)\);/);
  });
});

describe("tarjetas y tablas", () => {
  it("CSS: Card con padding --pad-card (14/12) y tarjetas a mano a radio 12, 1 px, sin sombra", () => {
    expect(regla('html[data-diseno="ds3"] main .ds3-card.ds3-card:is(.p-2, .p-3, .p-4, .p-5):not(.ds3-stat)')).toMatch(/padding: var\(--pad-card\);/);
    const mano = regla(":is(.card, .border.bg-card:is(.rounded-lg, .rounded-xl, .rounded-2xl)):not(.ds3-card, .ds3-aviso) {");
    expect(mano).toMatch(/border-width: 1px;/);
    expect(mano).toMatch(/border-radius: 12px;/);
    expect(mano).toMatch(/box-shadow: none;/);
  });

  it("CSS: th Hanken 13/600 sin MAYUSCULAS, cabecera teñida, y la tabla suelta queda en una tarjeta de 1 px radio 12", () => {
    const th = regla('html[data-diseno="ds3"] main th {');
    expect(th).toMatch(/font-family: var\(--font-sans\);/);
    expect(th).toMatch(/font-size: 13px;/);
    expect(th).toMatch(/font-weight: 600;/);
    expect(th).toMatch(/text-transform: none;/);
    expect(th).toMatch(/color: hsl\(var\(--foreground-2\)\);/);
    expect(regla('html[data-diseno="ds3"] main thead th {')).toMatch(/background-color: hsl\(var\(--soft\)\);/);
    const suelta = regla("main div.overflow-x-auto:has(> table):not(.card *, .ds3-card *, .bg-card *)");
    expect(suelta).toMatch(/border: 1px solid hsl\(var\(--border\)\);/);
    expect(suelta).toMatch(/border-radius: 12px;/);
  });
});
