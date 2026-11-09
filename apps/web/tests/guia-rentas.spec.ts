// ds3 «Guía» de rentas: el recorrido de cada rol sale de SU menu real (buildSections de RentasShell), toda pantalla del menu tiene
// contenido propio en ES y EN, ninguna entrada de contenido apunta a una pantalla que no existe y el corto mide 7 pasos (limpieza: 4,
// ver abajo).
import { describe, expect, it } from "vitest";
import { construirTour, contarPasos, crearTraductor, pantallasDelMenu, registrarModuloEs, rutaRelativa, TIPOS_ILUSTRACION } from "@atiende/ui";
import { nav } from "@atiende/ui/i18n/nav";
import { buildSections } from "../src/verticals/rentas/RentasShell.tsx";
import { esencialesRentas, excluirRentas, GUIA_RENTAS } from "../src/verticals/rentas/guia-rentas.ts";

const ORG = "gestora";
const BASE = `/rentas/${ORG}`;
registrarModuloEs(nav);
const t = crearTraductor("es");
/** Los 6 roles de packages/domain-rentas/src/roles.ts (RENTAS_VERTICAL_ROLES; apps/web no depende de ese paquete). */
const RENTAS_VERTICAL_ROLES = ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria", "operador:solo_calendario", "contador", "limpieza"] as const;
/** Mismo armado que RentasShell (COPILOTO_ROLES = admin_gestora/contador; Privacidad solo admin_gestora). */
const menuDe = (rol: string) => buildSections(t, ORG, rol === "admin_gestora" || rol === "contador", rol === "admin_gestora");
const opciones = (rol: string) => ({ base: BASE, contenido: GUIA_RENTAS, excluir: excluirRentas(rol) });

describe("guia de rentas", () => {
  for (const rol of RENTAS_VERTICAL_ROLES) {
    it(`${rol}: cada pantalla de su menu tiene contenido propio (ES y EN) y su recorrido corto`, () => {
      const menu = menuDe(rol);
      for (const p of pantallasDelMenu(menu)) {
        const c = GUIA_RENTAS[rutaRelativa(p.href, BASE)];
        expect(c, `${rol} sin contenido para ${p.href}`).toBeDefined();
        expect(c!.que.es.length).toBeGreaterThan(20);
        expect(c!.que.en.length).toBeGreaterThan(20);
      }
      const corto = construirTour(menu, "corto", { ...opciones(rol), esenciales: esencialesRentas(rol) });
      // Limpieza solo opera «Mis tareas» y lee el Calendario (las demas paginas le dicen «sin acceso» y el Resumen la redirige):
      // su corto son 2 pantallas = que + clave + que + cierre = 4 pasos. Los demas roles: 5 pantallas = 7 pasos.
      expect(contarPasos(corto)).toBe(rol === "limpieza" ? 4 : 7);
    });
  }

  it("admin_gestora: recorrido completo de nivel Rovaq (17 pantallas, 49 pasos) que visita todo su menu", () => {
    const completo = construirTour(menuDe("admin_gestora"), "completo", opciones("admin_gestora"));
    expect(contarPasos(completo)).toBeGreaterThanOrEqual(45);
    expect(contarPasos(completo)).toBeLessThanOrEqual(54);
    expect(new Set(completo.map((p) => p.pantalla).filter(Boolean)).size).toBe(pantallasDelMenu(menuDe("admin_gestora")).length);
  });

  it("limpieza: su recorrido nunca va al Resumen (la pagina la redirige a Mis tareas)", () => {
    for (const modo of ["corto", "completo"] as const) {
      const hrefs = construirTour(menuDe("limpieza"), modo, { ...opciones("limpieza"), esenciales: esencialesRentas("limpieza") }).map((p) => p.pantalla);
      expect(hrefs).not.toContain(BASE);
      expect(hrefs).toContain(`${BASE}/mis-tareas`);
    }
  });

  it("solo admin_gestora ve Privacidad; Copiloto solo admin_gestora y contador", () => {
    for (const rol of RENTAS_VERTICAL_ROLES) {
      const rels = pantallasDelMenu(menuDe(rol)).map((p) => rutaRelativa(p.href, BASE));
      expect(rels.includes("privacidad")).toBe(rol === "admin_gestora");
      expect(rels.includes("copiloto")).toBe(rol === "admin_gestora" || rol === "contador");
    }
  });

  it("sin contenido huerfano: cada entrada es una pantalla real del menu de algun rol", () => {
    const reales = new Set(RENTAS_VERTICAL_ROLES.flatMap((r) => pantallasDelMenu(menuDe(r)).map((p) => rutaRelativa(p.href, BASE))));
    for (const clave of Object.keys(GUIA_RENTAS)) expect(reales.has(clave), `contenido sin pantalla: «${clave}»`).toBe(true);
  });

  it("ilustraciones validas y textos sin cifras escritas a mano", () => {
    for (const [clave, c] of Object.entries(GUIA_RENTAS)) {
      expect(TIPOS_ILUSTRACION as readonly string[], clave).toContain(c.ilu);
      const textos = [c.que, c.queT, c.clave?.titulo, c.clave?.cuerpo, c.accion?.titulo, c.accion?.cuerpo].filter(Boolean).flatMap((x) => [x!.es, x!.en]);
      for (const x of textos) expect(x, clave).not.toMatch(/\$\s?\d|\d+\s?%/);
    }
  });
});
