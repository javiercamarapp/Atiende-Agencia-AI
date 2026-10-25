// Notificaciones de punta a punta contra la API simulada, en las 7 consolas (6 verticales + superadmin):
// la campana YA NO va en el encabezado (orden del dueno): es la pildora "Notificaciones" del pie del menu lateral (escritorio) y de
// "Mas" > Cuenta (movil). Su punto rojo (SIN numero) se enciende con avisos sin leer y se APAGA al leerlos, lleva a
// la pagina (lista, filtros, marcar leida / todas, 'Resolver' a la pantalla origen) y una notificacion que llega
// despues enciende el punto sin recargar (el punto se verifica en escritorio: en movil la pildora vive dentro de la hoja "Mas").
import { expect, test } from "../helpers/fixtures.ts";
import type { ObjetivoLogin } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { abrirMasMovil, esMovil, sidebar } from "../helpers/navegacion.ts";
import type { Page } from "@playwright/test";

const CONSOLAS: ReadonlyArray<{ objetivo: ObjetivoLogin; destino: RegExp }> = [
  { objetivo: "superadmin", destino: /\/superadmin\/salud$/ },
  { objetivo: "restaurantes", destino: /\/restaurantes\/[^/]+\/pedidos$/ },
  { objetivo: "hoteles", destino: /\/hoteles\/[^/]+\/tickets$/ },
  { objetivo: "rentas", destino: /\/rentas\/[^/]+\/calendario$/ },
  { objetivo: "despachos", destino: /\/despachos\/[^/]+\/cola-cobranza$/ },
  { objetivo: "licitaciones", destino: /\/licitaciones\/[^/]+\/seguimiento$/ },
  { objetivo: "citas", destino: /\/citas\/[^/]+\/agenda$/ },
];

/** Abre la pagina de notificaciones desde donde vive ahora el acceso: pildora del pie (escritorio) u hoja "Mas" (movil). */
async function irANotificaciones(page: Page): Promise<void> {
  if (esMovil(page)) {
    const hoja = await abrirMasMovil(page);
    await hoja.getByRole("link", { name: "Notificaciones" }).click();
  } else {
    await sidebar(page).getByRole("link", { name: "Notificaciones" }).click();
  }
  await expect(page).toHaveURL(/\/notificaciones$/);
}

for (const { objetivo, destino } of CONSOLAS) {
  test.describe(`notificaciones: ${objetivo}`, () => {
    test("el punto rojo se enciende con avisos, se apaga al leerlos y vuelve al llegar uno nuevo", async ({ page, iniciarSesion, mock, vigilante }) => {
      await iniciarSesion(objetivo, objetivo === "superadmin" ? undefined : "owner");
      await afirmarPantallaSana(page, `${objetivo}: aterrizaje`);
      // Ni el encabezado de escritorio ni el movil traen campana, chat ni fecha.
      await expect(page.getByTestId("barra-pagina").or(page.getByTestId("mobile-header")).locator('[aria-label^="Notificaciones"]')).toHaveCount(0);
      const pildora = sidebar(page).getByRole("link", { name: "Notificaciones" });
      const punto = pildora.locator('[data-testid="pildora-indicador"]');

      // Hay dos sin leer en la semilla: punto rojo, sin ningun numero (escritorio; en movil la pildora esta dentro de "Mas").
      if (!esMovil(page)) {
        await expect(punto).toBeVisible();
        expect(((await pildora.textContent()) ?? "").trim()).not.toMatch(/\d/);
      }

      // La pildora lleva a la pagina; la barra superior dice "Notificaciones" y hay un solo <h1>.
      await irANotificaciones(page);
      if (!esMovil(page)) await expect(page.getByTestId("barra-pagina-titulo")).toHaveText("Notificaciones");
      const tarjetas = page.getByTestId("notificacion");
      await expect(tarjetas).toHaveCount(2);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await afirmarPantallaSana(page, `${objetivo}: notificaciones`);

      // Severidades visibles con su rotulo de Likida.
      await expect(page.getByText("Requiere atención").first()).toBeVisible();
      await expect(page.getByText("Crítica").first()).toBeVisible();

      // Marcar una: la lista se queda con una y el punto sigue (aun hay otra sin leer).
      await tarjetas.first().getByRole("button", { name: "Marcar leído" }).click();
      await expect(tarjetas).toHaveCount(1);
      if (!esMovil(page)) await expect(punto).toBeVisible();
      expect((await mock.buscar({ metodo: "POST", ruta: /\/notifications\/ntf-[^/]+\/read$/ })).length).toBe(1);

      // Marcar todas: lista vacia honesta y el punto SE APAGA.
      await page.getByRole("button", { name: "Marcar todas" }).click();
      await expect(page.getByText("Sin novedades.")).toBeVisible();
      await expect(tarjetas).toHaveCount(0);
      if (!esMovil(page)) await expect(punto).toHaveCount(0);

      // Llega un aviso nuevo (evento del ciclo): el sondeo lo detecta al volver el foco y el punto se enciende,
      // y la pagina abierta lo muestra sin recargar.
      await mock.emitirNotificacion({ titulo: "Llegó un aviso nuevo", severidad: "atencion", categoria: "operacion", enlace: "/superadmin/salud" });
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      if (!esMovil(page)) await expect(punto).toBeVisible();
      await expect(tarjetas).toHaveCount(1);
      await expect(tarjetas.first()).toContainText("Llegó un aviso nuevo");

      // "Todas" muestra tambien lo leido; un filtro de categoria sin resultados lo dice.
      await page.getByRole("button", { name: "Todas", exact: true }).click();
      await expect(tarjetas).toHaveCount(4);
      // Dentro de <main>: el Sidebar de despachos tambien tiene una categoria "Fiscal".
      await page.locator("main").getByRole("button", { name: "Fiscal", exact: true }).click();
      await expect(page.getByText("Sin resultados.")).toBeVisible();
      vigilante.verificar();
    });

    test("'Resolver' lleva a la pantalla origen y marca el aviso como leido", async ({ page, iniciarSesion, mock, vigilante }) => {
      await iniciarSesion(objetivo, objetivo === "superadmin" ? undefined : "owner");
      await irANotificaciones(page);
      const primera = page.getByTestId("notificacion").filter({ hasText: "Hay algo nuevo por atender" });
      await expect(primera).toBeVisible();
      await primera.getByRole("link", { name: "Resolver" }).click();
      await expect(page).toHaveURL(destino);
      expect((await mock.buscar({ metodo: "POST", ruta: "/notifications/ntf-1/read" })).length).toBe(1);
      vigilante.verificar();
    });

    test("si el servidor falla al marcar, el aviso vuelve y se dice inline", async ({ page, iniciarSesion, mock, vigilante }) => {
      test.skip(esMovil(page), "el comportamiento es el mismo en escritorio");
      await iniciarSesion(objetivo, objetivo === "superadmin" ? undefined : "owner");
      await irANotificaciones(page);
      await expect(page.getByTestId("notificacion")).toHaveCount(2);
      vigilante.permitirRespuesta5xx(/\/notifications\/ntf-1\/read/);
      await mock.inyectarFalla({ metodo: "POST", ruta: "/notifications/ntf-1/read", status: 500, veces: 1 });
      await page.getByTestId("notificacion").filter({ hasText: "Hay algo nuevo por atender" }).getByRole("button", { name: "Marcar leído" }).click();
      await expect(page.getByRole("alert")).toContainText("El servidor no pudo atender la solicitud");
      await expect(page.getByTestId("notificacion")).toHaveCount(2);
      await expect(sidebar(page).getByRole("link", { name: "Notificaciones" }).locator('[data-testid="pildora-indicador"]')).toBeVisible();
      vigilante.verificar();
    });
  });
}
