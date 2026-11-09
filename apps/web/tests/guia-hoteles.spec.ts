// ds3 «Guía» de hoteles: el recorrido de cada rol sale de SU menu real (buildSections), toda pantalla del menu tiene contenido propio
// en ES y EN, ninguna entrada de contenido apunta a una pantalla que no existe y el corto mide 7 pasos para los 8 roles.
import { describe, expect, it } from "vitest";
import { construirTour, contarPasos, crearTraductor, pantallasDelMenu, registrarModuloEs, rutaRelativa, TIPOS_ILUSTRACION } from "@atiende/ui";
import { nav } from "@atiende/ui/i18n/nav";
import { buildSections } from "../src/verticals/hoteles/HotelesShell.tsx";
import { esencialesHoteles, GUIA_HOTELES } from "../src/verticals/hoteles/guia-hoteles.ts";

const ORG = "hotel-demo";
const BASE = `/hoteles/${ORG}`;
registrarModuloEs(nav);
const t = crearTraductor("es");
const ROLES = ["owner", "gm", "frontdesk", "reservations", "housekeeping", "maintenance", "fnb", "accountant"];

describe("guia de hoteles", () => {
  for (const rol of ROLES) {
    it(`${rol}: cada pantalla de su menu tiene contenido propio (ES y EN) y el recorrido corto mide 7 pasos`, () => {
      const menu = buildSections(t, ORG, rol);
      const pantallas = pantallasDelMenu(menu);
      // Todos los roles tienen al menos 8 pantallas (Resumen, Reservas, Mantenimiento, Tickets, Asistencia, CFDI, Fraude + la suya).
      expect(pantallas.length).toBeGreaterThanOrEqual(8);
      for (const p of pantallas) {
        const c = GUIA_HOTELES[rutaRelativa(p.href, BASE)];
        expect(c, `${rol} sin contenido para ${p.href}`).toBeDefined();
        expect(c!.que.es.length).toBeGreaterThan(20);
        expect(c!.que.en.length).toBeGreaterThan(20);
      }
      const corto = construirTour(menu, "corto", { base: BASE, contenido: GUIA_HOTELES, esenciales: esencialesHoteles(rol) });
      expect(new Set(corto.map((p) => p.pantalla).filter(Boolean)).size).toBe(5);
      expect(contarPasos(corto)).toBe(7);
    });
  }

  it("rol desconocido: el respaldo usa pantallas que todo rol tiene (7 pasos)", () => {
    const corto = construirTour(buildSections(t, ORG, "housekeeping"), "corto", { base: BASE, contenido: GUIA_HOTELES, esenciales: esencialesHoteles("otro") });
    expect(contarPasos(corto)).toBe(7);
  });

  it("owner: recorrido completo de nivel Rovaq (53 pasos) que visita todo su menu", () => {
    const menu = buildSections(t, ORG, "owner");
    const completo = construirTour(menu, "completo", { base: BASE, contenido: GUIA_HOTELES });
    expect(contarPasos(completo)).toBeGreaterThanOrEqual(48);
    expect(contarPasos(completo)).toBeLessThanOrEqual(60);
    expect(new Set(completo.map((p) => p.pantalla).filter(Boolean)).size).toBe(pantallasDelMenu(menu).length);
  });

  it("housekeeping: su recorrido no visita P&L, Catálogo, Mensajería ni Copiloto (no estan en su menu)", () => {
    const hrefs = construirTour(buildSections(t, ORG, "housekeeping"), "completo", { base: BASE, contenido: GUIA_HOTELES }).map((p) => p.pantalla);
    for (const prohibida of ["pl", "catalogo", "mensajeria", "copiloto", "identidad"]) expect(hrefs).not.toContain(`${BASE}/${prohibida}`);
  });

  it("sin contenido huerfano: cada entrada es una pantalla real del menu de algun rol", () => {
    const reales = new Set(ROLES.flatMap((r) => pantallasDelMenu(buildSections(t, ORG, r)).map((p) => rutaRelativa(p.href, BASE))));
    for (const clave of Object.keys(GUIA_HOTELES)) expect(reales.has(clave), `contenido sin pantalla: «${clave}»`).toBe(true);
  });

  it("ilustraciones validas y textos sin cifras escritas a mano", () => {
    for (const [clave, c] of Object.entries(GUIA_HOTELES)) {
      expect(TIPOS_ILUSTRACION as readonly string[], clave).toContain(c.ilu);
      const textos = [c.que, c.queT, c.clave?.titulo, c.clave?.cuerpo, c.accion?.titulo, c.accion?.cuerpo].filter(Boolean).flatMap((x) => [x!.es, x!.en]);
      for (const x of textos) expect(x, clave).not.toMatch(/\$\s?\d|\d+\s?%/);
    }
  });
});
