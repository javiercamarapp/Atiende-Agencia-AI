// Matriz visual del panel de restaurantes: cada pagina del menu en claro, oscuro, escritorio y movil (los 4 proyectos corren las
// pruebas @oscuro; el movil es el Pixel 7 de la config, 375x812): sin desborde horizontal, sin errores de consola ni 5xx, un solo <main>
// y a lo mucho un <h1> por pagina.
import { afirmarModo, afirmarSinScrollHorizontal } from "../../helpers/ds.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { DESTINOS, ir } from "../../helpers/recorrido.ts";

test.describe("restaurantes: matriz visual @oscuro @recorrido", () => {
  test("owner: cada pagina del panel se ve sana, sin desbordes y con un solo h1", async ({ page, iniciarSesion, vigilante }, info) => {
    test.setTimeout(120_000);
    await iniciarSesion("restaurantes", "owner");
    const oscuro = info.project.name.endsWith("oscuro");
    const defectos: string[] = [];
    for (const d of DESTINOS) {
      await ir(page, d.sub);
      // Espera a que termine la carga (ningun estado "Cargando…" visible) antes de medir.
      await expect(page.getByText(/^Cargando/)).toHaveCount(0, { timeout: 15_000 });
      await afirmarPantallaSana(page, d.nombre);
      await afirmarModo(page, oscuro ? "oscuro" : "claro");
      const h1 = await page.locator("h1").count();
      if (h1 > 1) defectos.push(`${d.sub || "/"}: ${h1} <h1>`);
      const desborda = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      if (desborda) defectos.push(`${d.sub || "/"}: desborde horizontal`);
    }
    expect(defectos, "defectos visuales por pagina").toEqual([]);
    await afirmarSinScrollHorizontal(page);
    vigilante.verificar();
  });

  // BUG-E2E-REST-004: /repartidor vive fuera del VerticalShell, que es quien aplica el tema: con el sistema en oscuro, Mis entregas se
  // queda en claro (<html> sin la clase "dark"). test.fail solo en los proyectos oscuros; en los claros comprueba el desborde.
  test("repartidor: Mis entregas sigue el tema del sistema y no desborda (BUG-E2E-REST-004 en oscuro)", async ({ page, iniciarSesion, vigilante }, info) => {
    const oscuro = info.project.name.endsWith("oscuro");
    test.fail(oscuro, "BUG-E2E-REST-004: Mis entregas ignora el modo oscuro del sistema; aplicar el tema en la ruta /repartidor (hoy solo lo hace VerticalShell)");
    await iniciarSesion("restaurantes", "repartidor");
    await afirmarSinScrollHorizontal(page);
    await afirmarModo(page, oscuro ? "oscuro" : "claro");
    vigilante.verificar();
  });
});
