// ds3 «Guía» de restaurantes: el recorrido de cada rol sale de SU menu real (buildSections), toda pantalla del menu tiene contenido propio
// en ES y EN, ninguna entrada de contenido apunta a una pantalla que no existe, el corto mide 7 pasos y el repartidor tiene su guia.
import { describe, expect, it } from "vitest";
import { construirTour, contarPasos, crearTraductor, pantallasDelMenu, registrarModuloEs, rutaRelativa, TIPOS_ILUSTRACION } from "@atiende/ui";
import { nav } from "@atiende/ui/i18n/nav";
import { buildSections } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { puedeEn } from "../src/verticals/restaurantes/lib/permisos.ts";
import { esencialesRestaurantes, GUIA_REPARTIDOR, GUIA_RESTAURANTES, menuRepartidor } from "../src/verticals/restaurantes/guia-restaurantes.ts";

const ORG = "taqueria";
const BASE = `/restaurantes/${ORG}`;
const GESTION = new Set(["owner", "admin"]);
registrarModuloEs(nav);
const t = crearTraductor("es");
/** Mismo armado que RestaurantesShell (con el panel movil del operador encendido, para cubrir tambien sus pantallas). */
const menuDe = (rol: string, operacion = false) =>
  buildSections(t, ORG, GESTION.has(rol), ["owner", "admin", "staff"].includes(rol), puedeEn(rol, "promociones.ver"), puedeEn(rol, "cfo.ver"), operacion && puedeEn(rol, "pedidos.capturar"), puedeEn(rol, "pedidos.agregados"));

describe("guia de restaurantes", () => {
  for (const rol of ["owner", "admin", "staff"]) {
    it(`${rol}: cada pantalla de su menu tiene contenido propio (ES y EN) y el recorrido corto mide 7 pasos`, () => {
      for (const operacion of [false, true]) {
        const menu = menuDe(rol, operacion);
        for (const p of pantallasDelMenu(menu)) {
          const c = GUIA_RESTAURANTES[rutaRelativa(p.href, BASE)];
          expect(c, `${rol} sin contenido para ${p.href}`).toBeDefined();
          expect(c!.que.es.length).toBeGreaterThan(20);
          expect(c!.que.en.length).toBeGreaterThan(20);
        }
        const corto = construirTour(menu, "corto", { base: BASE, contenido: GUIA_RESTAURANTES, esenciales: esencialesRestaurantes(rol) });
        expect(contarPasos(corto)).toBe(7);
      }
    });
  }

  it("owner: recorrido completo de nivel Rovaq (≈58 pasos) que visita todo su menu", () => {
    const completo = construirTour(menuDe("owner"), "completo", { base: BASE, contenido: GUIA_RESTAURANTES });
    expect(contarPasos(completo)).toBeGreaterThanOrEqual(50);
    expect(contarPasos(completo)).toBeLessThanOrEqual(66);
    expect(new Set(completo.map((p) => p.pantalla).filter(Boolean)).size).toBe(pantallasDelMenu(menuDe("owner")).length);
  });

  it("staff: su recorrido no visita Agente, Configuracion, Staff ni Auditoria (no estan en su menu)", () => {
    const hrefs = construirTour(menuDe("staff"), "completo", { base: BASE, contenido: GUIA_RESTAURANTES }).map((p) => p.pantalla);
    for (const prohibida of ["agente-voz", "configuracion", "staff", "auditoria", "primeros-pasos"]) expect(hrefs).not.toContain(`${BASE}/${prohibida}`);
  });

  it("sin contenido huerfano: cada entrada es una pantalla real del menu de algun rol", () => {
    const reales = new Set(["owner", "admin", "staff"].flatMap((r) => [false, true].flatMap((o) => pantallasDelMenu(menuDe(r, o)).map((p) => rutaRelativa(p.href, BASE)))));
    for (const clave of Object.keys(GUIA_RESTAURANTES)) expect(reales.has(clave), `contenido sin pantalla: «${clave}»`).toBe(true);
  });

  it("ilustraciones validas y textos sin cifras escritas a mano", () => {
    for (const [clave, c] of Object.entries({ ...GUIA_RESTAURANTES, ...GUIA_REPARTIDOR })) {
      expect(TIPOS_ILUSTRACION as readonly string[], clave).toContain(c.ilu);
      const textos = [c.que, c.queT, c.clave?.titulo, c.clave?.cuerpo, c.accion?.titulo, c.accion?.cuerpo].filter(Boolean).flatMap((x) => [x!.es, x!.en]);
      for (const x of textos) expect(x, clave).not.toMatch(/\$\s?\d|\d+\s?%/);
    }
  });

  it("repartidor: guia de su unica pantalla (que + clave + cierre)", () => {
    const pasos = construirTour(menuRepartidor(ORG), "completo", { base: BASE, contenido: GUIA_REPARTIDOR });
    expect(pasos.map((p) => p.id)).toEqual(["repartidor.ir", "repartidor.que", "repartidor.clave", "cierre"]);
    expect(contarPasos(pasos)).toBe(3);
  });
});
