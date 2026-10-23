// Turno de hoy (paquete C2) contra la API simulada: cifras del contrato, alerta roja >90 min, corte «Todo el día» y estado honesto cuando el servidor
// aun no tiene la ruta. El mock abre las rutas con `op.chofer.habilitado` (mismo interruptor que el chofer).
import { expect, test } from "../helpers/fixtures.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const RUTA = `/restaurantes/${restaurantes.orgSlug}/operacion/turno`;

test.describe("Turno de hoy", () => {
  test("sin la ruta en el servidor dice «No disponible aún»", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(RUTA);
    await expect(page.getByText("No disponible aún")).toBeVisible();
    vigilante.verificar();
  });

  test("con la ruta: tarjetas reales, alerta roja y corte «Todo el día» @oscuro", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(RUTA);
    await expect(page.getByText("No disponible aún")).toBeVisible();
    await mock.agregarAEstado("op.chofer.habilitado", true);
    await page.reload();
    await expect(page.getByRole("heading", { name: /Turno de hoy/ })).toBeVisible();
    await expect(page.getByText("$16,300.00")).toBeVisible();
    await expect(page.getByText("91%")).toBeVisible();
    await expect(page.getByText("#141 lleva 104 min en camino")).toBeVisible();
    await expect(page.locator('[data-alerta="roja"]')).toHaveCount(1);
    await expect(page.getByLabel("Hora pico: sin dato")).toBeVisible();
    await expect(page.getByText("Chofer de prueba").first()).toBeVisible();
    const relleno = await page.locator("svg[role=img] rect").first().evaluate((r) => getComputedStyle(r).fill);
    expect(relleno, "la barra de canales usa un color del tema (no negro por omision)").not.toBe("rgb(0, 0, 0)");
    await page.getByText("Todo el día").click();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "turno=dia" })).length).toBeGreaterThan(0);
    const ancho = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(ancho, "sin scroll horizontal").toBeLessThanOrEqual(0);
    vigilante.verificar();
  });
});
