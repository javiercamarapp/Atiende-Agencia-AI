// Paridad visual del panel del operador (grupo C): en movil nada desborda el ancho de pantalla y todo importe lleva «$» como el resto de Restaurantes.
import { expect, test } from "../helpers/fixtures.ts";
import { esMovil } from "../helpers/navegacion.ts";
import { BASE } from "../helpers/recorrido.ts";

test.describe("operacion paridad visual @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "staff");
  });

  test("Cola: sin desborde horizontal a 375 px y el importe lleva «$»", async ({ page, vigilante }) => {
    await page.goto(`${BASE}/operacion`);
    await expect(page.getByRole("heading", { name: "Cola de pedidos" })).toBeVisible();
    await expect(page.getByText("$708.00")).toBeVisible();
    if (esMovil(page)) {
      const desborde = await page.evaluate(() => {
        const ancho = document.documentElement.clientWidth;
        return Array.from(document.querySelectorAll("main *")).filter((el) => el.getBoundingClientRect().right > ancho + 1).length;
      });
      expect(desborde, "elementos que se salen del ancho de la pantalla").toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
    vigilante.verificar();
  });

  test("Viajes y Nuevo pedido: importes con «$»", async ({ page, vigilante }) => {
    await page.goto(`${BASE}/operacion/viajes`);
    await expect(page.getByText("$520.00").first()).toBeVisible();
    await page.goto(`${BASE}/operacion/nuevo`);
    await expect(page.getByRole("heading", { name: "Nuevo pedido" })).toBeVisible();
    await expect(page.getByText("$95.00").first()).toBeVisible();
    vigilante.verificar();
  });
});
