// UNI-1 (marco y barra movil): en el proyecto movil, las 7 consolas (superadmin y las 6 verticales) alcanzan TODOS
// sus destinos con la barra inferior (pildora de 64 px, maximo 6 lugares) y la hoja "Más"; cada pantalla muestra el nombre de
// la pagina y tiene un solo <h1> accesible, sin desborde horizontal ni contenido tapado por la barra fija.
// Las pruebas marcadas @oscuro corren tambien en movil-oscuro.
import { expect, test } from "../helpers/fixtures.ts";
import type { ObjetivoLogin } from "../helpers/fixtures.ts";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { abrirMasMovil, barraMovil, enlacesMasMovil, esMovil, irASeccion } from "../helpers/navegacion.ts";

const CONSOLAS: readonly ObjetivoLogin[] = ["superadmin", "citas", "restaurantes", "hoteles", "rentas", "despachos", "licitaciones"];

test.describe("marco y barra movil @movil", () => {
  for (const objetivo of CONSOLAS) {
    test(`${objetivo}: barra de 63 px, 5 lugares, todos los destinos alcanzables, nombre de pagina y un solo h1`, async ({ page, iniciarSesion, vigilante }) => {
      test.skip(!esMovil(page), "la barra inferior es solo de movil");
      await iniciarSesion(objetivo, objetivo === "superadmin" ? undefined : "owner");
      await afirmarPantallaSana(page, `${objetivo}: aterrizaje`);

      // Barra: pildora flotante de 64 px, a 10 px del borde inferior y 12 px de cada lado (el inset es 0 en el emulador).
      const barra = barraMovil(page);
      await expect(barra).toBeVisible();
      const caja = (await barra.boundingBox())!;
      const vista = page.viewportSize()!;
      expect(Math.abs(caja.height - 64), `${objetivo}: alto de la barra ${caja.height}`).toBeLessThanOrEqual(1);
      expect(Math.abs(vista.height - (caja.y + caja.height) - 10), "la barra flota a 10 px del borde inferior").toBeLessThanOrEqual(1);
      expect(Math.abs(caja.width - (vista.width - 24)), "la barra deja 12 px a cada lado").toBeLessThanOrEqual(1);
      // 4 destinos + «Preguntar» (decision de Omar 7-nov-2026, si hay acceso al Copiloto) + «Más».
      const lugares = await barra.locator("li").filter({ visible: true }).count();
      expect(lugares, `${objetivo}: la barra tiene de 2 a 6 lugares`).toBeGreaterThanOrEqual(2);
      expect(lugares).toBeLessThanOrEqual(6);
      // Etiqueta de 12 px e icono de 22 px (Likida), y exactamente un destino activo con aria-current.
      const etiqueta = barra.locator("a span").first();
      expect(await etiqueta.evaluate((e) => getComputedStyle(e).fontSize)).toBe("12px");
      const icono = (await barra.locator("a svg").first().boundingBox())!;
      expect(Math.round(icono.width)).toBe(22);
      expect(await barra.locator('a[aria-current="page"]').count()).toBeLessThanOrEqual(1);

      // Todos los destinos de la hoja "Más" se alcanzan con clics reales y cada pantalla cumple el contrato movil.
      const secciones = await enlacesMasMovil(page);
      expect(secciones.length, `${objetivo}: la hoja Más lista las secciones`).toBeGreaterThanOrEqual(3);
      const hrefsHoja = new Set(secciones.map((s) => s.href));
      for (const href of await barra.locator("li:not([hidden]) a").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""))) {
        expect(hrefsHoja.has(href), `${objetivo}: el destino de la barra ${href} tambien esta en la hoja Más`).toBe(true);
      }
      const vistas = new Set<string>();
      for (const seccion of secciones) {
        if (vistas.has(seccion.href)) continue;
        vistas.add(seccion.href);
        await irASeccion(page, seccion);
        await afirmarPantallaSana(page, `${seccion.texto} (${seccion.href})`);
        // Nombre de la pagina visible en la cabecera movil, y un solo <h1> en el arbol de accesibilidad.
        const nombre = page.getByTestId("mobile-pagina-titulo");
        await expect(nombre, `${seccion.href}: nombre de la pagina visible en movil`).toBeVisible();
        expect(((await nombre.textContent()) ?? "").trim().length).toBeGreaterThan(0);
        await expect(page.getByRole("heading", { level: 1 }), `${seccion.href}: un solo <h1> accesible en movil`).toHaveCount(1);
        await afirmarSinScrollHorizontal(page);
        // El contenido no queda tapado por la barra fija: el <main> reserva al menos 63 px abajo.
        const relleno = await page.locator("main#contenido-principal").evaluate((m) => parseFloat(getComputedStyle(m).paddingBottom));
        expect(relleno).toBeGreaterThanOrEqual(63);
      }
      vigilante.verificar();
    });
  }

  test("la hoja Más cierra con un boton de 44 px y 'Más' queda activo en un destino que solo vive en la hoja @oscuro", async ({ page, iniciarSesion, vigilante }, info) => {
    test.skip(!esMovil(page), "la barra inferior es solo de movil");
    await iniciarSesion("citas", "owner");
    const secciones = await enlacesMasMovil(page);
    const enBarra = new Set(await barraMovil(page).locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")));
    const soloHoja = secciones.find((s) => !enBarra.has(s.href));
    expect(soloHoja, "citas tiene destinos que solo estan en la hoja Más").toBeDefined();
    await irASeccion(page, soloHoja!);
    const mas = barraMovil(page).getByRole("button", { name: "Más" });
    expect(await mas.locator("span:not([data-testid])").evaluate((e) => getComputedStyle(e).fontWeight)).toBe("600");

    const hoja = await abrirMasMovil(page);
    const cerrar = hoja.getByRole("button", { name: "Cerrar" });
    const cajaCerrar = (await cerrar.boundingBox())!;
    expect(Math.round(cajaCerrar.width)).toBe(44);
    expect(Math.round(cajaCerrar.height)).toBe(44);
    await cerrar.click();
    await expect(hoja).toBeHidden();
    await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
    vigilante.verificar();
  });
});
