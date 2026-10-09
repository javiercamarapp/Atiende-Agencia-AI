// UNI-4 (contrato de pagina): la barra superior de CADA pagina del panel muestra el nombre de esa pagina (el del
// item de navegacion activo), no un titulo fijo. Solo el Resumen conserva el titulo de la consola.
// Se recorre el menu real con clics en las 7 consolas (superadmin y las 6 verticales). La barra es de escritorio
// (en movil la oculta el shell), por eso el movil se salta.
// Tambien afirma que en CADA pagina la barra lleva a la derecha la campana de notificaciones (real: enlace a la pagina de
// notificaciones de la consola) y el chip de fecha (no solo en el Resumen): un solo componente (`BarraPagina`) las monta.
import { expect, test } from "../helpers/fixtures.ts";
import type { ObjetivoLogin } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil, irASeccion, seccionesDelPanel } from "../helpers/navegacion.ts";

// "4 oct 2026" / "15 sept 2026": dia, mes corto es-MX y ano.
const FORMATO_FECHA = /^\d{1,2} [a-z]{3,5}\.? \d{4}$/;

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
            return titulo.test(actual) || actual === seccion.texto;
          }, { message: `${seccion.href}: la barra debe pasar a llevar el nombre de la pagina`, timeout: 10_000 })
          .toBe(true);
        const texto = ((await barra.textContent()) ?? "").trim();
        if (titulo.test(texto)) {
          // Solo el Resumen (la raiz del panel) conserva el titulo de la consola.
          resumenes += 1;
        } else {
          expect(texto, `${objetivo}: la barra de ${seccion.href} debe llevar el nombre de la pagina`).toBe(seccion.texto);
        }
        // Campana y fecha en CADA pagina (no solo en la de aterrizaje).
        const barraCompleta = page.getByTestId("barra-pagina");
        await expect(barraCompleta, `${seccion.href}: la barra superior debe estar visible`).toBeVisible();
        const campana = barraCompleta.getByRole("button", { name: /^Notificaciones/ });
        await expect(campana, `${seccion.href}: la campana debe estar en la barra`).toHaveCount(1);
        const fecha = ((await barraCompleta.getByTestId("barra-pagina-fecha").textContent()) ?? "").trim();
        expect(fecha, `${seccion.href}: el chip de fecha debe llevar la fecha de hoy`).toMatch(FORMATO_FECHA);
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
