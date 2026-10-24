// Privacidad a 375 px: la tabla de solicitudes ARCO no ensancha la pagina (antes la pagina medía ~549 px y se cortaba por la derecha).
import { expect, test } from "../../helpers/fixtures.ts";
import { esMovil } from "../../helpers/navegacion.ts";
import { BASE } from "../../helpers/recorrido.ts";

test("Privacidad: sin desborde horizontal en movil", async ({ page, iniciarSesion, vigilante }) => {
  test.skip(!esMovil(page), "solo movil");
  await iniciarSesion("restaurantes", "owner");
  await page.goto(`${BASE}/privacidad`);
  await expect(page.getByText("ARCO-0001")).toBeVisible();
  const fuera = await page.evaluate(() => {
    const ancho = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll("main *")).filter((el) => !el.closest(".overflow-x-auto") && el.getBoundingClientRect().right > ancho + 1).length;
  });
  expect(fuera, "elementos fuera de la pantalla (fuera de un contenedor con scroll propio)").toBe(0);
  vigilante.verificar();
});
