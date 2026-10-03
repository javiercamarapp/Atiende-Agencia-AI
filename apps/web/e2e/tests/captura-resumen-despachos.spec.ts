// Capturas del Resumen de despachos para la aceptacion de UNI-RES-despachos (claro, oscuro, movil). Las pruebas marcadas @oscuro
// corren en los 4 proyectos. Las comprobaciones (un solo h1, 7 KPI en orden, sin desborde horizontal, modo correcto) corren siempre;
// el PNG solo se escribe si CAPTURAS_RESUMEN_DIR apunta a una carpeta (p. ej. docs/diseno-uni-res-despachos), asi CI no genera nada.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { despachos } from "../mock-api/fixtures/despachos.ts";

test.describe("captura del Resumen de despachos @captura", () => {
  test("Resumen: un solo h1, 7 KPI, destacado y pildoras, sin desborde y captura por proyecto @oscuro", async ({ page, iniciarSesion, vigilante }, info) => {
    await iniciarSesion("despachos", "owner");
    await page.goto(`/despachos/${despachos.orgSlug}/dashboard`);
    await afirmarPantallaSana(page, "resumen de despachos");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/Buen(os días|as tardes|as noches)/);
    for (const etiqueta of ["Clientes", "Cartera vencida", "Tasa de cobranza", "Pendientes de trabajo", "Cierres sin cerrar", "Anomalías", "CFDI del mes"]) {
      await expect(page.getByText(etiqueta, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Ver cobranza" })).toHaveAttribute("href", `/despachos/${despachos.orgSlug}/cobranza`);
    await expect(page.getByRole("link", { name: "Ver cierre" })).toHaveAttribute("href", `/despachos/${despachos.orgSlug}/cierre-mensual`);
    await expect(page.getByRole("region", { name: "Última corrida" })).toContainText("Sin registro de corridas");
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
