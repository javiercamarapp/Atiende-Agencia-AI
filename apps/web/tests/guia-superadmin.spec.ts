// ds3 «Guía» de la consola de plataforma: el recorrido sale del menu real (SECTIONS), toda pantalla del menu tiene contenido propio en
// ES y EN, ninguna entrada de contenido apunta a una pantalla que no existe y el corto mide 7 pasos.
import { describe, expect, it } from "vitest";
import { construirTour, contarPasos, crearTraductor, pantallasDelMenu, registrarModuloEs, rutaRelativa, TIPOS_ILUSTRACION } from "@atiende/ui";
import { nav } from "@atiende/ui/i18n/nav";
import { consola } from "@atiende/ui/i18n/consola";
import { construirSecciones } from "../src/superadmin/SuperAdminShell.tsx";
import { ESENCIALES_SUPERADMIN, GUIA_SUPERADMIN } from "../src/superadmin/guia-superadmin.ts";

const BASE = "/superadmin";
registrarModuloEs(nav);
registrarModuloEs(consola);
const t = crearTraductor("es");
const SECTIONS = construirSecciones(t);

describe("guia del superadmin", () => {
  it("cada pantalla del menu tiene contenido propio (ES y EN)", () => {
    for (const p of pantallasDelMenu(SECTIONS)) {
      const c = GUIA_SUPERADMIN[rutaRelativa(p.href, BASE)];
      expect(c, `sin contenido para ${p.href}`).toBeDefined();
      expect(c!.que.es.length).toBeGreaterThan(20);
      expect(c!.que.en.length).toBeGreaterThan(20);
    }
  });

  it("el recorrido corto mide 7 pasos y visita las 5 esenciales", () => {
    const corto = construirTour(SECTIONS, "corto", { base: BASE, contenido: GUIA_SUPERADMIN, esenciales: ESENCIALES_SUPERADMIN });
    expect(contarPasos(corto)).toBe(7);
    expect(new Set(corto.map((p) => p.pantalla).filter(Boolean)).size).toBe(5);
  });

  it("el recorrido completo visita todo el menu", () => {
    const completo = construirTour(SECTIONS, "completo", { base: BASE, contenido: GUIA_SUPERADMIN });
    expect(new Set(completo.map((p) => p.pantalla).filter(Boolean)).size).toBe(pantallasDelMenu(SECTIONS).length);
    expect(contarPasos(completo)).toBeLessThanOrEqual(70);
  });

  it("sin contenido huerfano: cada entrada es una pantalla real del menu", () => {
    const reales = new Set(pantallasDelMenu(SECTIONS).map((p) => rutaRelativa(p.href, BASE)));
    for (const clave of Object.keys(GUIA_SUPERADMIN)) expect(reales.has(clave), `contenido sin pantalla: «${clave}»`).toBe(true);
  });

  it("ilustraciones validas y textos sin cifras escritas a mano", () => {
    for (const [clave, c] of Object.entries(GUIA_SUPERADMIN)) {
      expect(TIPOS_ILUSTRACION as readonly string[], clave).toContain(c.ilu);
      const textos = [c.que, c.queT, c.clave?.titulo, c.clave?.cuerpo, c.accion?.titulo, c.accion?.cuerpo].filter(Boolean).flatMap((x) => [x!.es, x!.en]);
      for (const x of textos) expect(x, clave).not.toMatch(/\$\s?\d|\d+\s?%/);
    }
  });
});
