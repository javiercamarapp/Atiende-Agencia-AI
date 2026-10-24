// Privacidad a 375 px: la tabla de solicitudes ARCO no ensancha la pagina (antes la pagina medía ~549 px y se cortaba por la derecha).
import { expect, test } from "../../helpers/fixtures.ts";
import { esMovil } from "../../helpers/navegacion.ts";
import { BASE } from "../../helpers/recorrido.ts";

test("Privacidad: sin desborde horizontal en movil", async ({ page, iniciarSesion, vigilante }) => {
  test.skip(!esMovil(page), "solo movil");
  await iniciarSesion("restaurantes", "owner");
  await page.goto(`${BASE}/privacidad`);
  await expect(page.getByText("ARCO-0001")).toBeVisible();
  const medidas = await page.evaluate(() => {
    const ancho = document.documentElement.clientWidth;
    const fuera = Array.from(document.querySelectorAll("main *")).filter((el) => !el.closest(".overflow-x-auto") && el.getBoundingClientRect().right > ancho + 1).length;
    // Toda tabla debe caber en su contenedor con scroll o, si es mas ancha, ese contenedor debe poder enfocarse (teclado).
    const tablas = Array.from(document.querySelectorAll("main table")).map((t) => {
      // Contenedor que de verdad hace scroll horizontal (estilo calculado, no por nombre de clase).
      let cont: Element | null = t.parentElement;
      while (cont && cont !== document.body && !["auto", "scroll"].includes(getComputedStyle(cont).overflowX)) cont = cont.parentElement;
      if (cont === document.body) cont = null;
      return { tieneContenedor: cont !== null, masAncha: cont !== null && t.scrollWidth > cont.clientWidth + 1, enfocable: cont?.getAttribute("tabindex") === "0" };
    });
    return { fuera, paginaAncha: document.documentElement.scrollWidth - ancho, tablas };
  });
  expect(medidas.fuera, "elementos fuera de la pantalla (fuera de un contenedor con scroll propio)").toBe(0);
  expect(medidas.paginaAncha, "la pagina no debe tener scroll horizontal").toBeLessThanOrEqual(1);
  expect(medidas.tablas.length, "debe haber al menos una tabla").toBeGreaterThan(0);
  for (const t of medidas.tablas) {
    expect(t.tieneContenedor, "toda tabla va dentro de un contenedor con scroll propio").toBe(true);
    if (t.masAncha) expect(t.enfocable, "una tabla mas ancha que su contenedor exige un contenedor enfocable").toBe(true);
  }
  const region = page.getByRole("region", { name: "Solicitudes ARCO" });
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute("tabindex", "0");
  vigilante.verificar();
});
