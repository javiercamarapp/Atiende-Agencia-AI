// «Resumen general» de restaurantes contra la API SIMULADA (datos SINTÉTICOS del CFO, 21–27 sep 2026, 7 sucursales de PM con Galerías):
// el dueño ve frase, KPI, estado de los datos, «Requiere tu atención» y el comparativo por sucursal; «Pregúntale a tus datos» abre el
// Copiloto con la pregunta; el staff no tiene la entrada ni las cifras. Con y sin la bandera ds3.
// Capturas opcionales (claro, oscuro y móvil): RESUMEN_GENERAL_CAPTURAS=<carpeta>; en CI no se escribe nada.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil, sidebar } from "../helpers/navegacion.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const BASE = `/restaurantes/${restaurantes.orgSlug}`;
const URL_GENERAL = `${BASE}/general?desde=2026-09-21&hasta=2026-09-27&comparar=periodo_anterior`;
const SUCURSALES = ["Prolongación Montejo", "Francisco de Montejo", "Pensiones", "Victory Platz", "Altabrisa", "Galerías", "Chicxulub"];

test.describe("restaurantes resumen general @humo", () => {
  test("el dueño ve las 7 sucursales (Galerías incluida), la franja de datos y lo que requiere su atención", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(URL_GENERAL);
    await afirmarPantallaSana(page, "Resumen general");
    await expect(page.getByRole("heading", { level: 1, name: "Resumen general" })).toBeVisible();
    if (!esMovil(page)) await expect(sidebar(page).getByRole("link", { name: "Resumen general", exact: true })).toBeVisible();
    await expect(page.getByTestId("resumen-general-datos")).toContainText("3 de 4");
    await expect(page.getByTestId("resumen-general-datos")).toContainText("SoftRestaurant");
    await expect(page.getByTestId("resumen-general-aviso")).toHaveCount(3);
    for (const nombre of SUCURSALES) await expect(page.locator(`[data-sucursal="${nombre}"]`).first()).toBeAttached();
    await expect(page.getByTestId("resumen-general-total")).toContainText("$238,186");
    await afirmarSinScrollHorizontal(page);
    vigilante.verificar();
  });

  test("con ds3: eyebrow y frase con las cifras en negritas", async ({ page, iniciarSesion, vigilante }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("atiende-diseno", "ds3");
      } catch {
        // sin almacenamiento: falla la afirmacion de la bandera
      }
    });
    await iniciarSesion("restaurantes", "owner");
    await page.goto(URL_GENERAL);
    await expect(page.locator("html")).toHaveAttribute("data-diseno", "ds3");
    const frase = page.getByTestId("resumen-general-frase");
    await expect(frase).toBeVisible();
    await expect(frase).toContainText("Tus 7 sucursales vendieron");
    await expect(frase.locator("strong").first()).toHaveText("$238,186");
    vigilante.verificar();
  });

  test("«Pregúntale a tus datos» abre el Copiloto con la pregunta de todas las sucursales", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(URL_GENERAL);
    const caja = page.getByTestId("resumen-general-preguntar");
    await caja.getByRole("button", { name: "Compara las ventas de mis sucursales esta semana" }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/copiloto`));
    // La pregunta se envía una sola vez y sale de la URL (recargar no la repite).
    await expect(page.getByText("Compara las ventas de mis sucursales esta semana").first()).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]q=/);
    vigilante.verificar();
  });

  test("el staff no ve la entrada y la ruta directa dice que no tiene acceso", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await page.goto(URL_GENERAL);
    await expect(page.getByText("Solo para dueño o administrador")).toBeVisible();
    if (!esMovil(page)) await expect(sidebar(page).getByRole("link", { name: "Resumen general", exact: true })).toHaveCount(0);
    vigilante.verificar();
  });

  test("capturas del Resumen general (claro, oscuro y móvil; con ds3) @oscuro", async ({ page, iniciarSesion, vigilante }, info) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("atiende-diseno", "ds3");
      } catch {
        // sin almacenamiento: la captura sale sin ds3
      }
    });
    await iniciarSesion("restaurantes", "owner");
    const destino = process.env["RESUMEN_GENERAL_CAPTURAS"];
    if (destino) mkdirSync(destino, { recursive: true });
    await page.goto(URL_GENERAL);
    await expect(page.getByTestId("resumen-general-aviso").first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await afirmarSinScrollHorizontal(page);
    await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
    if (destino) await page.screenshot({ path: join(destino, `${info.project.name}-resumen-general.png`), fullPage: true });
    vigilante.verificar();
  });
});
