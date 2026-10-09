// Notificaciones de punta a punta contra la API simulada, en las 7 consolas (6 verticales + superadmin):
// la campana (boton con punto rojo SIN numero que abre el centro de notificaciones) se enciende con avisos sin leer y se APAGA al leerlos, lleva a
// la pagina (lista, filtros, marcar leida / todas, 'Resolver' a la pantalla origen) y una notificacion que llega
// despues enciende el punto sin recargar. Escritorio y movil.
import { expect, test } from "../helpers/fixtures.ts";
import type { ObjetivoLogin } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil } from "../helpers/navegacion.ts";

const CONSOLAS: ReadonlyArray<{ objetivo: ObjetivoLogin; destino: RegExp }> = [
  { objetivo: "superadmin", destino: /\/superadmin\/salud$/ },
  { objetivo: "restaurantes", destino: /\/restaurantes\/[^/]+\/pedidos$/ },
  { objetivo: "hoteles", destino: /\/hoteles\/[^/]+\/tickets$/ },
  { objetivo: "rentas", destino: /\/rentas\/[^/]+\/calendario$/ },
  { objetivo: "despachos", destino: /\/despachos\/[^/]+\/cola-cobranza$/ },
  { objetivo: "licitaciones", destino: /\/licitaciones\/[^/]+\/seguimiento$/ },
  { objetivo: "citas", destino: /\/citas\/[^/]+\/agenda$/ },
];

for (const { objetivo, destino } of CONSOLAS) {
  test.describe(`notificaciones: ${objetivo}`, () => {
    test("el punto rojo se enciende con avisos, se apaga al leerlos y vuelve al llegar uno nuevo", async ({ page, iniciarSesion, mock, vigilante }) => {
      await iniciarSesion(objetivo, objetivo === "superadmin" ? undefined : "owner");
      await afirmarPantallaSana(page, `${objetivo}: aterrizaje`);
      const campana = page.locator('button[aria-label^="Notificaciones"]:visible');
      const punto = campana.locator('[data-testid="campana-punto"]');

      // Hay dos sin leer en la semilla: punto rojo, sin ningun numero.
      await expect(campana).toHaveAttribute("data-no-leidas", "true");
      await expect(punto).toBeVisible();
      expect(((await campana.textContent()) ?? "").trim()).toBe("");

      // La campana abre el centro (popover con las recientes) y "Ver todas" lleva a la pagina; la barra superior dice "Notificaciones" y hay un solo <h1>.
      await campana.click();
      await expect(page.getByTestId("centro-item")).toHaveCount(2);
      await page.getByRole("link", { name: "Ver todas las notificaciones" }).click();
      await expect(page).toHaveURL(/\/notificaciones$/);
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
      await expect(punto).toBeVisible();
      expect((await mock.buscar({ metodo: "POST", ruta: /\/notifications\/ntf-[^/]+\/read$/ })).length).toBe(1);

      // Marcar todas: lista vacia honesta y el punto SE APAGA.
      await page.getByRole("button", { name: "Marcar todas" }).click();
      await expect(page.getByText("Sin novedades.")).toBeVisible();
      await expect(tarjetas).toHaveCount(0);
      await expect(punto).toHaveCount(0);
      await expect(campana).toHaveAttribute("data-no-leidas", "false");

      // Llega un aviso nuevo (evento del ciclo): el sondeo lo detecta al volver el foco y el punto se enciende,
      // y la pagina abierta lo muestra sin recargar.
      await mock.emitirNotificacion({ titulo: "Llegó un aviso nuevo", severidad: "atencion", categoria: "operacion", enlace: "/superadmin/salud" });
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(punto).toBeVisible();
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
      await page.locator('button[aria-label^="Notificaciones"]:visible').click();
      await page.getByRole("link", { name: "Ver todas las notificaciones" }).click();
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
      await page.locator('button[aria-label^="Notificaciones"]:visible').click();
      await page.getByRole("link", { name: "Ver todas las notificaciones" }).click();
      await expect(page.getByTestId("notificacion")).toHaveCount(2);
      vigilante.permitirRespuesta5xx(/\/notifications\/ntf-1\/read/);
      await mock.inyectarFalla({ metodo: "POST", ruta: "/notifications/ntf-1/read", status: 500, veces: 1 });
      await page.getByTestId("notificacion").filter({ hasText: "Hay algo nuevo por atender" }).getByRole("button", { name: "Marcar leído" }).click();
      await expect(page.getByRole("alert")).toContainText("El servidor no pudo atender la solicitud");
      await expect(page.getByTestId("notificacion")).toHaveCount(2);
      await expect(page.locator('button[aria-label^="Notificaciones"]:visible').locator('[data-testid="campana-punto"]')).toBeVisible();
      vigilante.verificar();
    });
  });
}
