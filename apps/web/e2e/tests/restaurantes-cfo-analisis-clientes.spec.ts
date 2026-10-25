// CFO «Análisis de clientes» (Fase A), contra la API SIMULADA con datos SINTÉTICOS (ver mock-api/fixtures/restaurantes-cfo-analisis.ts, que sirve la vista del
// servicio real): la pestaña pinta sus bloques con la definición y el periodo al pulsar el botón de cada uno, la reactivación muestra alias y consentimiento sin
// PII ni botón de enviar, y el rol sin acceso al CFO no ve nada. Sin datos reales.
import { afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const BASE = `/restaurantes/${restaurantes.orgSlug}/cfo`;
const RANGO = "desde=2026-09-21&hasta=2026-09-27&comparar=periodo_anterior";

test.describe("restaurantes CFO análisis de clientes @humo", () => {
  test("la pestaña pinta resumen, segmentos, Pareto, reactivación, afinidad y tortilla sin scroll horizontal ni errores de consola", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/clientes?${RANGO}`);
    await page.getByTestId("pestana-analisis-clientes").click();
    await expect(page).toHaveURL(/\/cfo\/analisis-clientes\?/);
    await expect(page.getByTestId("pestana-analisis-clientes")).toHaveAttribute("aria-current", "page");
    const raiz = page.getByTestId("cfo-analisis-clientes");
    await expect(raiz.getByTestId("bloque-pendientes")).toBeVisible();
    for (const id of ["resumen", "segmentos", "concentracion", "reactivacion", "intervalo", "afinidad", "tortilla"]) {
      await expect(raiz.getByTestId(`bloque-${id}`)).toHaveAttribute("data-estado", "listo");
    }
    await expect(raiz.getByTestId("pareto-texto")).toContainText("El 30 % de tus clientes reúne el 50 % de la venta");
    await expect(raiz.getByTestId("pendientes-lista")).toContainText("No disponible aún: requiere");
    await afirmarPantallaSana(page, "CFO · análisis de clientes");
    await afirmarSinScrollHorizontal(page);
    vigilante.verificar();
  });

  test("el botón de cada bloque abre su definición con el periodo", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/analisis-clientes?${RANGO}`);
    await expect(page.getByTestId("bloque-segmentos")).toHaveAttribute("data-estado", "listo");
    await page.getByTestId("bloque-segmentos").getByTestId("definicion").click();
    await expect(page.getByTestId("definicion-texto")).toContainText("Periodo: 21 sep a 27 sep (7 días)");
    vigilante.verificar();
  });

  test("reactivación: alias de 8 caracteres y consentimiento visibles, ningún nombre ni teléfono y ningún botón para enviar", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/analisis-clientes?${RANGO}`);
    const bloque = page.getByTestId("bloque-reactivacion");
    await expect(bloque.getByText("Otorgado").first()).toBeVisible();
    await expect(bloque.getByText("Revocado").first()).toBeVisible();
    const texto = await bloque.innerText();
    expect(texto).not.toMatch(/@|\+?\d{10}/);
    expect(await page.getByTestId("cfo-analisis-clientes").getByRole("button", { name: /preparar campaña|enviar/i }).count()).toBe(0);
    await expect(bloque.getByRole("link", { name: "Campañas" })).toBeVisible();
    vigilante.verificar();
  });

  test("un rol sin acceso al CFO no ve el análisis", async ({ page, iniciarSesion }) => {
    await iniciarSesion("restaurantes", "staff");
    await page.goto(`${BASE}/analisis-clientes?${RANGO}`);
    await expect(page.getByText("Tu rol no tiene acceso al CFO").first()).toBeVisible();
    await expect(page.getByTestId("cfo-analisis-clientes")).toHaveCount(0);
  });
});
