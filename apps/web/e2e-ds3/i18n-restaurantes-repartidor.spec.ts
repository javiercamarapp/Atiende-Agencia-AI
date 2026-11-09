// i18n ES/EN — restaurantes, pantalla del repartidor (fuera del shell: no hay sidebar ni selector, el idioma sale de `atiende-idioma`).
// 1) Panel del chofer: entra con el rol repartidor (la fixture espera el encabezado «Mis entregas»), captura en espanol, elige ingles, recarga y
//    captura; con el panel nuevo abierto en la API simulada (`op.chofer.habilitado`) recorre tambien la tarjeta de entrega.
// 2) Acceso por celular (pantalla publica): el servicio de codigos se simula con page.route, como en e2e/tests/acceso-repartidor.spec.ts.
// En ingles exige que las frases propias de la pantalla ya no salgan en espanol y que nunca se pinte una clave cruda del catalogo. Los datos
// del cliente (nombre, direccion, indicaciones) vienen de la API simulada y siguen en espanol a proposito. Capturas como adjuntos del reporte
// y, con DS3_CAPTURAS=1, en la carpeta de evidencia (i18n-restaurantes-repartidor/<pantalla>/).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { restaurantes } from "../e2e/mock-api/fixtures/restaurantes.ts";
import { esperarSinCarga, prepararBandera } from "./comun.ts";

const SALIDA = process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia";
const CLAVE_CRUDA = /\brestaurantes\.[a-z]+[A-Za-z]*\.[A-Za-z0-9.]+/;

test.beforeEach(async ({ page }) => {
  await prepararBandera(page);
  // El idioma solo cambia con el diseno ds3 (el unico con selector ES/EN): este spec lo enciende siempre.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("atiende-diseno", "ds3");
    } catch {
      // Sin almacenamiento: el spec fallara al no ver ingles, que es lo correcto.
    }
  });
});

function capturador(page: Page, info: TestInfo, id: string) {
  const carpeta = join(SALIDA, "i18n-restaurantes-repartidor", id);
  mkdirSync(carpeta, { recursive: true });
  return async (idioma: string) => {
    const ruta = join(carpeta, `${info.project.name}-${idioma}.png`);
    await page.screenshot({ path: ruta, fullPage: false });
    await info.attach(`${id}-${idioma}`, { path: ruta, contentType: "image/png" });
  };
}

async function elegirIngles(page: Page) {
  await page.evaluate(() => window.localStorage.setItem("atiende-idioma", "en"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
}

test("i18n restaurantes repartidor: Mis entregas ES y EN", async ({ page, iniciarSesion, mock }, info) => {
  const capturar = capturador(page, info, "mis-entregas");
  await iniciarSesion("restaurantes", "repartidor");
  await page.goto(`/restaurantes/${restaurantes.orgSlug}/repartidor`);
  const main = page.locator("main#contenido-principal");
  await expect(page.getByRole("heading", { name: "Mis entregas" })).toBeVisible();
  await esperarSinCarga(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
  await expect(main).toContainText(/Historial del día/);
  await capturar("es");

  // Panel nuevo del chofer (tarjeta de entrega con Navegar / Llamar / Entregado / No pude entregar).
  await mock.agregarAEstado("op.chofer.habilitado", true);
  await page.reload();
  const tarjetaEs = page.getByRole("article", { name: "Pedido 145" });
  await expect(tarjetaEs).toBeVisible();
  await expect(tarjetaEs).toContainText("No pude entregar");
  await capturar("es-panel");

  await elegirIngles(page);
  await expect(page.getByRole("heading", { name: "My deliveries" })).toBeVisible();
  const tarjeta = page.getByRole("article", { name: "Order 145" });
  await expect(tarjeta).toBeVisible();
  await expect(tarjeta).toContainText("Couldn't deliver");
  await expect(tarjeta.getByRole("button", { name: /Delivered, order 145/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Today's history" })).toBeVisible();
  await page.waitForFunction(() => document.querySelectorAll('[role="status"][aria-busy="true"]').length === 0, undefined, { timeout: 20_000 });
  const texto = await page.locator("main#contenido-principal").innerText();
  expect(texto, "frases de la pantalla que siguen en espanol con EN elegido").not.toMatch(/Mis entregas|Historial del día|Mi perfil|No pude entregar|Navegar|Llamar|Actualizar|en camino/);
  expect(texto).not.toMatch(CLAVE_CRUDA);
  await capturar("en-panel");
});

test("i18n restaurantes repartidor: acceso por celular ES y EN", async ({ page }, info) => {
  const capturar = capturador(page, info, "acceso");
  await page.route("**/auth/login-telefono/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ disponible: true }) }));
  await page.goto("/restaurantes/acceso-repartidor");
  const main = page.locator("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Entrar con tu celular");
  await expect(main).toContainText(/Enviarme el código/);
  await capturar("es");

  await elegirIngles(page);
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Sign in with your phone");
  await expect(main).toContainText(/Send me the code/);
  const texto = await main.innerText();
  expect(texto, "frases de la pantalla que siguen en espanol con EN elegido").not.toMatch(/Entrar con|Tu celular|Enviarme|encargado/);
  expect(texto).not.toMatch(CLAVE_CRUDA);
  await capturar("en");
});
