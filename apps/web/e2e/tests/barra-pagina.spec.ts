// UNI-4 (contrato de pagina): la barra superior de CADA pagina del panel muestra el nombre de esa pagina (el del
// item de navegacion activo), no un titulo fijo. Solo el Resumen conserva el titulo de la consola.
// Se recorre el menu real con clics en las 7 consolas (superadmin y las 6 verticales). La barra es de escritorio
// (en movil la oculta el shell), por eso el movil se salta.
import { expect, test } from "../helpers/fixtures.ts";
import type { ObjetivoLogin } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil, irASeccion, seccionesDelPanel } from "../helpers/navegacion.ts";

const CONSOLAS: ReadonlyArray<{ objetivo: ObjetivoLogin; titulo: RegExp }> = [
  { objetivo: "superadmin", titulo: /^Consola de Atiende$/ },
  { objetivo: "citas", titulo: /^Citas · / },
  { objetivo: "restaurantes", titulo: /^Restaurantes · / },
  { objetivo: "hoteles", titulo: /^Hoteles · / },
  { objetivo: "rentas", titulo: / · / },
  { objetivo: "despachos", titulo: /^Despachos · / },
  { objetivo: "licitaciones", titulo: /^Licitaciones · / },
];

test.describe("barra de pagina: cada pagina muestra su nombre @ds", () => {
  for (const { objetivo, titulo } of CONSOLAS) {
    test(`${objetivo}: la barra superior lleva el nombre de cada pagina y un solo <h1>`, async ({ page, iniciarSesion, vigilante }) => {
      test.skip(esMovil(page), "la barra superior es de escritorio");
      await iniciarSesion(objetivo, objetivo === "superadmin" ? undefined : "owner");
      await afirmarPantallaSana(page, `${objetivo}: aterrizaje`);
      const barra = page.getByTestId("barra-pagina-titulo");

      const secciones = await seccionesDelPanel(page);
      expect(secciones.length).toBeGreaterThanOrEqual(3);
      const nombres = new Set<string>();
      let resumenes = 0;
      for (const seccion of secciones) {
        await irASeccion(page, seccion);
        await afirmarPantallaSana(page, `${seccion.texto} (${seccion.href})`);
        // La URL cambia antes de que React pinte la pagina nueva (la barra conserva <100 ms el nombre de la anterior): se espera
        // a que la barra muestre el nombre de ESTA seccion o el titulo de la consola, en vez de leerla al instante.
        await expect.poll(async () => {
          const t = ((await barra.textContent()) ?? "").trim();
          return t === seccion.texto || titulo.test(t);
        }, { message: `${objetivo}: la barra de ${seccion.href} no llego a mostrar su nombre` }).toBe(true);
        const texto = ((await barra.textContent()) ?? "").trim();
        if (titulo.test(texto)) {
          // Solo el Resumen (la raiz del panel) conserva el titulo de la consola.
          resumenes += 1;
        } else {
          expect(texto, `${objetivo}: la barra de ${seccion.href} debe llevar el nombre de la pagina`).toBe(seccion.texto);
        }
        nombres.add(texto);
        await expect(page.getByRole("heading", { level: 1 }), `${seccion.href}: un solo <h1> por pantalla`).toHaveCount(1);
      }
      expect(resumenes, `${objetivo}: el titulo de la consola solo va en el Resumen`).toBe(1);
      // Antes del cambio todas las paginas decian lo mismo: ahora hay un nombre distinto por pagina.
      expect(nombres.size).toBeGreaterThanOrEqual(secciones.length - 1);
      vigilante.verificar();
    });
  }
});
