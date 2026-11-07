// ds3 «Guía» de despachos: el recorrido de cada rol sale de SU menu real (buildSidebarSections), toda pantalla del menu tiene contenido
// propio en ES y EN, ninguna entrada de contenido apunta a una pantalla que no existe y el corto mide 7 pasos.
import { describe, expect, it } from "vitest";
import { construirTour, contarPasos, pantallasDelMenu, rutaRelativa, TIPOS_ILUSTRACION } from "@atiende/ui";
import { buildSidebarSections } from "../src/verticals/despachos/DespachosShell.tsx";
import { COPILOTO_DESPACHOS_ROLES } from "../src/verticals/despachos/pages/Copiloto.tsx";
import { esencialesDespachos, GUIA_DESPACHOS } from "../src/verticals/despachos/guia-despachos.ts";

const ORG = "despacho-demo";
const BASE = `/despachos/${ORG}`;
const ROLES = ["admin", "contador", "auditor", "readonly"];
/** Mismo armado que DespachosShell (el Copiloto depende del rol); `conCopiloto` forzado cubre ambas formas del menu. */
const menuDe = (rol: string, conCopiloto = COPILOTO_DESPACHOS_ROLES.has(rol)) => buildSidebarSections(ORG, conCopiloto);

describe("guia de despachos", () => {
  for (const rol of ROLES) {
    it(`${rol}: cada pantalla de su menu tiene contenido propio (ES y EN) y el recorrido corto mide 7 pasos`, () => {
      for (const conCopiloto of [COPILOTO_DESPACHOS_ROLES.has(rol), false]) {
        const menu = menuDe(rol, conCopiloto);
        for (const p of pantallasDelMenu(menu)) {
          const c = GUIA_DESPACHOS[rutaRelativa(p.href, BASE)];
          expect(c, `${rol} sin contenido para ${p.href}`).toBeDefined();
          expect(c!.que.es.length).toBeGreaterThan(20);
          expect(c!.que.en.length).toBeGreaterThan(20);
        }
        const corto = construirTour(menu, "corto", { base: BASE, contenido: GUIA_DESPACHOS, esenciales: esencialesDespachos(rol) });
        expect(contarPasos(corto)).toBe(7);
      }
    });
  }

  it("rol desconocido: cae al corto de solo lectura (7 pasos)", () => {
    const corto = construirTour(menuDe("readonly"), "corto", { base: BASE, contenido: GUIA_DESPACHOS, esenciales: esencialesDespachos("otro") });
    expect(contarPasos(corto)).toBe(7);
  });

  it("admin: recorrido completo de nivel Rovaq (45 a 65 pasos) que visita todo su menu", () => {
    const completo = construirTour(menuDe("admin"), "completo", { base: BASE, contenido: GUIA_DESPACHOS });
    expect(contarPasos(completo)).toBeGreaterThanOrEqual(45);
    expect(contarPasos(completo)).toBeLessThanOrEqual(65);
    expect(new Set(completo.map((p) => p.pantalla).filter(Boolean)).size).toBe(pantallasDelMenu(menuDe("admin")).length);
  });

  it("sin contenido huerfano: cada entrada es una pantalla real del menu de algun rol", () => {
    const reales = new Set([true, false].flatMap((c) => pantallasDelMenu(buildSidebarSections(ORG, c)).map((p) => rutaRelativa(p.href, BASE))));
    for (const clave of Object.keys(GUIA_DESPACHOS)) expect(reales.has(clave), `contenido sin pantalla: «${clave}»`).toBe(true);
  });

  it("ilustraciones validas y textos sin cifras escritas a mano", () => {
    for (const [clave, c] of Object.entries(GUIA_DESPACHOS)) {
      expect(TIPOS_ILUSTRACION as readonly string[], clave).toContain(c.ilu);
      const textos = [c.que, c.queT, c.clave?.titulo, c.clave?.cuerpo, c.accion?.titulo, c.accion?.cuerpo].filter(Boolean).flatMap((x) => [x!.es, x!.en]);
      for (const x of textos) expect(x, clave).not.toMatch(/\$\s?\d|\d+\s?%/);
    }
  });
});
