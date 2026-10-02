// Capturas del Resumen de hoteles para la aceptacion de UNI-RES-hoteles (claro, oscuro, movil 375 px). Las pruebas marcadas @oscuro
// corren en los 4 proyectos. Las comprobaciones (un solo h1, sin desborde horizontal, modo correcto) corren siempre; el archivo PNG
// solo se escribe si CAPTURAS_RESUMEN_DIR apunta a una carpeta (p. ej. docs/diseno-ux-capturas-uni-res-hoteles), asi CI no genera nada.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { hoteles } from "../mock-api/fixtures/hoteles.ts";

test.describe("captura del Resumen de hoteles @captura", () => {
  test("Resumen: un solo h1, sin desborde y captura por proyecto @oscuro", async ({ page, iniciarSesion, vigilante }, info) => {
    await iniciarSesion("hoteles", "owner");
    await page.goto(`/hoteles/${hoteles.orgSlug}`);
    await afirmarPantallaSana(page, "resumen de hoteles");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Última corrida" })).toContainText("Night audit");
    await expect(page.getByText("Aprobaciones pendientes")).toBeVisible();
    await afirmarSinScrollHorizontal(page);
    await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
    vigilante.verificar();

    const destino = process.env["CAPTURAS_RESUMEN_DIR"];
    if (destino) {
      mkdirSync(destino, { recursive: true });
      await page.screenshot({ path: join(destino, `${info.project.name}.png`), fullPage: true });
    }
  });
});
