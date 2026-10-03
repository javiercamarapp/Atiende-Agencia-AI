// Capturas del Resumen de la consola de superadmin para la aceptacion de UNI-RES-superadmin (claro, oscuro, movil 375 px). Las pruebas
// marcadas @oscuro corren en los 4 proyectos. Las comprobaciones (un solo h1, sin desborde horizontal, modo correcto) corren siempre; el
// PNG solo se escribe si CAPTURAS_RESUMEN_DIR apunta a una carpeta, asi CI no genera nada.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";

test.describe("captura del Resumen de superadmin @captura", () => {
  test("Resumen: un solo h1, sin desborde y captura por proyecto @oscuro", async ({ page, iniciarSesion, vigilante }, info) => {
    await iniciarSesion("superadmin");
    await afirmarPantallaSana(page, "resumen de superadmin");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByText("Agentes de las verticales — última corrida")).toBeVisible();
    await expect(page.getByText("Sincronización iCal de rentas")).toBeVisible();
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
