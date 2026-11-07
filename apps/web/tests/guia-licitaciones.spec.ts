// ds3 «Guía» de licitaciones: el recorrido de cada rol sale de SU menu real (buildSidebarSections), toda pantalla del menu tiene
// contenido propio en ES y EN, ninguna entrada apunta a una pantalla que no existe y el corto mide 7 pasos para los 6 roles.
import { describe, expect, it } from "vitest";
import { construirTour, contarPasos, pantallasDelMenu, rutaRelativa, TIPOS_ILUSTRACION } from "@atiende/ui";
import { buildSidebarSections } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { STAFF_NAV_ROLES, puedeVerPrivacidad } from "../src/verticals/licitaciones/roles-nav.ts";
import { esencialesLicitaciones, GUIA_LICITACIONES } from "../src/verticals/licitaciones/guia-licitaciones.ts";

const ORG = "constructora";
const BASE = `/licitaciones/${ORG}`;
const ROLES = ["owner", "admin", "analyst", "writer", "reviewer", "viewer"];
/** Mismo armado que LicitacionesShell. */
const menuDe = (rol: string) => buildSidebarSections(ORG, STAFF_NAV_ROLES.has(rol), puedeVerPrivacidad(rol));

describe("guia de licitaciones", () => {
  for (const rol of ROLES) {
    it(`${rol}: cada pantalla de su menu tiene contenido propio (ES y EN) y el recorrido corto mide 7 pasos`, () => {
      const menu = menuDe(rol);
      for (const p of pantallasDelMenu(menu)) {
        const c = GUIA_LICITACIONES[rutaRelativa(p.href, BASE)];
        expect(c, `${rol} sin contenido para ${p.href}`).toBeDefined();
        expect(c!.que.es.length).toBeGreaterThan(20);
        expect(c!.que.en.length).toBeGreaterThan(20);
      }
      const corto = construirTour(menu, "corto", { base: BASE, contenido: GUIA_LICITACIONES, esenciales: esencialesLicitaciones(rol) });
      expect(new Set(corto.map((p) => p.pantalla).filter(Boolean)).size).toBe(5);
      expect(contarPasos(corto)).toBe(7);
    });
  }

  it("owner: recorrido completo (43 pasos) que visita todo su menu", () => {
    const completo = construirTour(menuDe("owner"), "completo", { base: BASE, contenido: GUIA_LICITACIONES });
    expect(contarPasos(completo)).toBeGreaterThanOrEqual(40);
    expect(contarPasos(completo)).toBeLessThanOrEqual(50);
    expect(new Set(completo.map((p) => p.pantalla).filter(Boolean)).size).toBe(pantallasDelMenu(menuDe("owner")).length);
  });

  it("viewer: su recorrido no visita Staff, Bitácora ni Privacidad (no estan en su menu)", () => {
    const hrefs = construirTour(menuDe("viewer"), "completo", { base: BASE, contenido: GUIA_LICITACIONES }).map((p) => p.pantalla);
    for (const prohibida of ["staff", "bitacora", "privacidad"]) expect(hrefs).not.toContain(`${BASE}/${prohibida}`);
  });

  it("sin contenido huerfano: cada entrada es una pantalla real del menu de algun rol", () => {
    const reales = new Set(ROLES.flatMap((r) => pantallasDelMenu(menuDe(r)).map((p) => rutaRelativa(p.href, BASE))));
    for (const clave of Object.keys(GUIA_LICITACIONES)) expect(reales.has(clave), `contenido sin pantalla: «${clave}»`).toBe(true);
  });

  it("ilustraciones validas y textos sin cifras escritas a mano", () => {
    for (const [clave, c] of Object.entries(GUIA_LICITACIONES)) {
      expect(TIPOS_ILUSTRACION as readonly string[], clave).toContain(c.ilu);
      const textos = [c.que, c.queT, c.clave?.titulo, c.clave?.cuerpo, c.accion?.titulo, c.accion?.cuerpo].filter(Boolean).flatMap((x) => [x!.es, x!.en]);
      for (const x of textos) expect(x, clave).not.toMatch(/\$\s?\d|\d+\s?%/);
    }
  });
});
