// Panel del chofer (PLAN-PANEL-OPERADOR, paquete C1) contra la API simulada: solo sus entregas, sin telefono, botones de 56 dp, Entregado con
// confirmacion, Deshacer, «No pude entregar» y Llamar auditado. El mock abre las rutas nuevas con el estado `op.chofer.habilitado`.
import { esMovil } from "../helpers/navegacion.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

test.describe("chofer: Mis entregas", () => {
  async function abrirPanelNuevo(page: import("@playwright/test").Page, iniciarSesion: (o: "restaurantes", r: "repartidor") => Promise<string>, mock: import("../mock-api/cliente.ts").ClienteMock) {
    await iniciarSesion("restaurantes", "repartidor");
    await page.goto(`/restaurantes/${restaurantes.orgSlug}/repartidor`);
    await expect(page.getByRole("heading", { name: "Mis entregas" })).toBeVisible();
    // La primera peticion crea la compuerta del mock (vista anterior); se abre y se recarga para ver el panel nuevo.
    await mock.agregarAEstado("op.chofer.habilitado", true);
    await page.reload();
    await expect(page.getByRole("article", { name: "Pedido 145" })).toBeVisible();
    // «Historial del dia» (efectivo a rendir) se conserva como pestana del panel nuevo.
    await expect(page.getByRole("tab", { name: "Historial del día" })).toBeVisible();
  }

  test("muestra solo sus pedidos en camino, sin telefono, con botones de 56 dp @oscuro", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirPanelNuevo(page, iniciarSesion, mock);
    await expect(page.getByRole("article", { name: "Pedido 146" })).toBeVisible();
    const ana = page.getByRole("article", { name: "Pedido 145" });
    await expect(ana).toContainText("Calle 60 #320, Centro");
    await expect(ana).toContainText("Total $708.00");
    await expect(ana).toContainText("cambio $292.00");
    await expect(ana).toContainText("Portón negro");
    await expect(page.locator("body")).not.toContainText(/\+?52999\d{7}/);
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
    for (const nombre of [/Entregado, pedido 145/, /Llamar al cliente del pedido 145/]) {
      const caja = await ana.getByRole("button", { name: nombre }).boundingBox();
      expect(caja?.height ?? 0, `alto de ${nombre}`).toBeGreaterThanOrEqual(56);
    }
    if (esMovil(page)) {
      const ancho = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(ancho, "sin scroll horizontal en el celular").toBeLessThanOrEqual(0);
    }
    vigilante.verificar();
  });

  test("Entregado pide confirmacion, envia una sola vez y permite Deshacer", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirPanelNuevo(page, iniciarSesion, mock);
    const ana = page.getByRole("article", { name: "Pedido 145" });
    await ana.getByRole("button", { name: /Entregado, pedido 145/ }).click();
    const dialogo = page.getByRole("alertdialog");
    await expect(dialogo).toContainText("¿Entregaste el pedido #145?");
    expect(await mock.buscar({ metodo: "POST", ruta: "/entregar" })).toHaveLength(0);
    await dialogo.getByRole("button", { name: "Sí, entregado" }).dblclick();
    await expect(dialogo).toBeHidden();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/entregar" })).length).toBe(1);
    const [peticion] = await mock.buscar({ metodo: "POST", ruta: "/entregar" });
    expect(peticion?.cuerpo).toMatchObject({ desdeEstado: "en_camino", cobradoMonto: 708 });
    await expect(ana).toContainText("Entregado");
    const deshacer = ana.getByRole("button", { name: /Deshacer la entrega del pedido 145/ });
    await expect(deshacer).toBeVisible();
    await deshacer.click();
    await expect(ana.getByRole("button", { name: /Entregado, pedido 145/ })).toBeVisible();
    expect(await mock.buscar({ metodo: "POST", ruta: "/deshacer-entrega" })).toHaveLength(1);
    vigilante.verificar();
  });

  test("No pude entregar manda el motivo cerrado y Llamar pide el numero sin mostrarlo", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirPanelNuevo(page, iniciarSesion, mock);
    const luis = page.getByRole("article", { name: "Pedido 146" });
    // Tarjeta: sin cobro en efectivo que registrar.
    await expect(luis).toContainText("Tarjeta");
    await luis.getByRole("button", { name: /No pude entregar el pedido 146/ }).click();
    const hoja = page.getByRole("dialog");
    await hoja.getByText("No encontré la dirección").click();
    await hoja.getByRole("button", { name: "Reportar problema" }).click();
    await expect(luis).toContainText("Problema reportado");
    const [peticion] = await mock.buscar({ metodo: "POST", ruta: "/problema" });
    expect(peticion?.cuerpo).toEqual({ motivo: "direccion" });

    // Llamar: el telefono viaja solo en esa respuesta; la pagina nunca lo pinta (se cancela la navegacion a tel:).
    await page.route(/^tel:/, (r) => r.abort()).catch(() => undefined);
    await page.getByRole("article", { name: "Pedido 145" }).getByRole("button", { name: /Llamar al cliente del pedido 145/ }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/llamar" })).length).toBe(1);
    await expect(page.locator("body")).not.toContainText("5550145");
    vigilante.verificar();
  });
});
