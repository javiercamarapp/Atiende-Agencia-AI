// ds3 «Guía» de citas: el recorrido de cada rol sale de SU menu real (buildSections de CitasShell), toda pantalla del menu tiene
// contenido propio en ES y EN, ninguna entrada de contenido apunta a una pantalla que no existe y el corto mide 7 pasos.
import { describe, expect, it } from "vitest";
import { construirTour, contarPasos, crearTraductor, pantallasDelMenu, registrarModuloEs, rutaRelativa, TIPOS_ILUSTRACION } from "@atiende/ui";
import { nav } from "@atiende/ui/i18n/nav";
import { buildSections } from "../src/verticals/citas/CitasShell.tsx";
import { COPILOTO_CITAS_ROLES } from "../src/verticals/citas/pages/Copiloto.tsx";
import { esencialesCitas, GUIA_CITAS } from "../src/verticals/citas/guia-citas.ts";

const ORG = "clinica";
const BASE = `/citas/${ORG}`;
registrarModuloEs(nav);
const t = crearTraductor("es");
const ROLES = ["owner", "admin", "staff"];
/** Mismo armado que CitasShell. */
const menuDe = (rol: string) => buildSections(t, ORG, COPILOTO_CITAS_ROLES.has(rol));

describe("guia de citas", () => {
  for (const rol of ROLES) {
    it(`${rol}: cada pantalla de su menu tiene contenido propio (ES y EN) y el recorrido corto mide 7 pasos`, () => {
      const menu = menuDe(rol);
      for (const p of pantallasDelMenu(menu)) {
        const c = GUIA_CITAS[rutaRelativa(p.href, BASE)];
        expect(c, `${rol} sin contenido para ${p.href}`).toBeDefined();
        expect(c!.que.es.length).toBeGreaterThan(20);
        expect(c!.que.en.length).toBeGreaterThan(20);
      }
      const esenciales = esencialesCitas(rol);
      expect(esenciales).toHaveLength(5);
      const corto = construirTour(menu, "corto", { base: BASE, contenido: GUIA_CITAS, esenciales });
      expect(new Set(corto.map((p) => p.pantalla).filter(Boolean)).size).toBe(5);
      expect(contarPasos(corto)).toBe(7);
    });
  }

  it("owner: recorrido completo de nivel Rovaq (16 pantallas, 47 pasos) que visita todo su menu", () => {
    const completo = construirTour(menuDe("owner"), "completo", { base: BASE, contenido: GUIA_CITAS });
    expect(contarPasos(completo)).toBeGreaterThanOrEqual(42);
    expect(contarPasos(completo)).toBeLessThanOrEqual(50);
    expect(new Set(completo.map((p) => p.pantalla).filter(Boolean)).size).toBe(pantallasDelMenu(menuDe("owner")).length);
  });

  it("staff: su menu no tiene Copiloto y su recorrido corto no pasa por pantallas de gestion", () => {
    const hrefs = construirTour(menuDe("staff"), "completo", { base: BASE, contenido: GUIA_CITAS }).map((p) => p.pantalla);
    expect(hrefs).not.toContain(`${BASE}/copiloto`);
    for (const prohibida of ["primeros-pasos", "agente-whatsapp", "mensajes-whatsapp", "staff", "auditoria", "privacidad"]) expect(esencialesCitas("staff")).not.toContain(prohibida);
  });

  it("rol desconocido cae al recorrido corto de staff", () => {
    expect(esencialesCitas("otro")).toEqual(esencialesCitas("staff"));
  });

  it("sin contenido huerfano: cada entrada es una pantalla real del menu de algun rol", () => {
    const reales = new Set(ROLES.flatMap((r) => pantallasDelMenu(menuDe(r)).map((p) => rutaRelativa(p.href, BASE))));
    for (const clave of Object.keys(GUIA_CITAS)) expect(reales.has(clave), `contenido sin pantalla: «${clave}»`).toBe(true);
  });

  it("ilustraciones validas y textos sin cifras escritas a mano", () => {
    for (const [clave, c] of Object.entries(GUIA_CITAS)) {
      expect(TIPOS_ILUSTRACION as readonly string[], clave).toContain(c.ilu);
      const textos = [c.que, c.queT, c.clave?.titulo, c.clave?.cuerpo, c.accion?.titulo, c.accion?.cuerpo].filter(Boolean).flatMap((x) => [x!.es, x!.en]);
      for (const x of textos) expect(x, clave).not.toMatch(/\$\s?\d|\d+\s?%/);
    }
  });
});
