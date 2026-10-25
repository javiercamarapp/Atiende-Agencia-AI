// UNI-4 (contrato de pagina): la barra superior de CADA pagina del panel muestra el nombre de esa pagina (el del
// item de navegacion activo), no un titulo fijo. Solo el Resumen conserva el titulo de la consola.
// Se recorre el menu real con clics en las 7 consolas (superadmin y las 6 verticales). La barra es de escritorio
// (en movil la oculta el shell), por eso el movil se salta.
// Tambien afirma que en CADA pagina la barra va delgada: sin campana, sin "Pregúntale a tus datos" y sin chip de fecha (orden del
// dueno); la campana sigue accesible como pildora "Notificaciones" del pie del menu lateral.
import { expect, test } from "../helpers/fixtures.ts";
import type { ObjetivoLogin } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil, irASeccion, seccionesDelPanel } from "../helpers/navegacion.ts";

// El Copiloto de cada consola pone en la barra el nombre de su portada ("Pregúntale a tus datos") con `useTituloBarra`, no el rotulo "Copiloto" del menu.
const TITULO_COPILOTO = "Pregúntale a tus datos";
// Las 6 verticales llevan el titulo nuevo; el superadmin tiene su propia pagina del Copiloto (rotulo "Copiloto").
const nombreEsperado = (texto: string, objetivo: ObjetivoLogin): string[] => (texto === "Copiloto" ? (objetivo === "superadmin" ? [texto] : [TITULO_COPILOTO]) : [texto]);


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
        // La barra cambia de nombre al montar la ruta nueva: se espera (con reintento) a que sea la de ESTA pagina antes de
        // leerla, para no leer el nombre de la pagina anterior (carrera vista al medir recien hecho el clic).
        await expect
          .poll(async () => {
            const actual = ((await barra.textContent()) ?? "").trim();
            return titulo.test(actual) || nombreEsperado(seccion.texto, objetivo).includes(actual);
          }, { message: `${seccion.href}: la barra debe pasar a llevar el nombre de la pagina`, timeout: 10_000 })
          .toBe(true);
        const texto = ((await barra.textContent()) ?? "").trim();
        if (titulo.test(texto)) {
          // Solo el Resumen (la raiz del panel) conserva el titulo de la consola.
          resumenes += 1;
        } else {
          expect(nombreEsperado(seccion.texto, objetivo), `${objetivo}: la barra de ${seccion.href} debe llevar el nombre de la pagina`).toContain(texto);
        }
        // La barra va delgada en CADA pagina: sin campana, sin chat, sin fecha. Las funciones siguen en el pie del menu lateral.
        const barraCompleta = page.getByTestId("barra-pagina");
        await expect(barraCompleta, `${seccion.href}: la barra superior debe estar visible`).toBeVisible();
        await expect(barraCompleta.locator('[aria-label^="Notificaciones"]'), `${seccion.href}: sin campana en la barra`).toHaveCount(0);
        await expect(barraCompleta.getByTestId("barra-pagina-fecha"), `${seccion.href}: sin chip de fecha en la barra`).toHaveCount(0);
        // (En el Copiloto el TITULO de la barra es ese nombre: lo que no debe haber es un boton o enlace de chat.)
        await expect(barraCompleta.getByRole("link", { name: /Pregúntale a tus datos/ }).or(barraCompleta.getByRole("button", { name: /Pregúntale a tus datos/ })), `${seccion.href}: sin boton de "Pregúntale a tus datos" en la barra`).toHaveCount(0);
        await expect(page.locator("aside").getByRole("link", { name: "Notificaciones" }), `${seccion.href}: Notificaciones accesible en el pie del menu`).toHaveCount(1);
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
