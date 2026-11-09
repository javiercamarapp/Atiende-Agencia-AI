// ds3 «componentes de contenido», parte 3 (PARIDAD-ATIENDE-ROVAQ §R1 #7 y #10), en el navegador real con la bandera:
// (1) los 4 KPI principales y la grafica de ventas del Resumen de restaurantes llevan el (i) de 32 px que abre el Drawer «Cómo se calculó»
// (de donde sale, periodo, alcance, qué no sabemos) y al cerrarlo con Esc el foco vuelve al (i); (2) una falla de la API se ve como
// «no disponible» con «Reintentar» en primario suave, y el texto tecnico (si lo hay) plegado. Sin la bandera no hay (i).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { orgDe } from "../e2e/mock-api/personas.ts";
import { ETAPA, esperarSinCarga, prepararBandera } from "./comun.ts";

const SALIDA = process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia";
const DS3 = process.env["E2E_DISENO"] === "ds3";
const rest = () => `/restaurantes/${orgDe("restaurantes").slug}`;

async function capturar(page: Page, info: TestInfo, pantalla: string): Promise<void> {
  const carpeta = join(SALIDA, "contenido-error-info", pantalla);
  mkdirSync(carpeta, { recursive: true });
  const png = join(carpeta, `${info.project.name}-${ETAPA}${DS3 ? "-ds3" : ""}.png`);
  await page.screenshot({ path: png, fullPage: false });
  await info.attach(`${pantalla}-${info.project.name}`, { path: png, contentType: "image/png" });
}

test.beforeEach(async ({ page }) => {
  await prepararBandera(page);
});

test("(i) «Cómo se calculó» en los KPI y la grafica de ventas", async ({ page, iniciarSesion, vigilante }, info) => {
  await iniciarSesion("restaurantes", "owner");
  await page.goto(rest());
  await expect(page.locator("main#contenido-principal")).toBeVisible();
  await esperarSinCarga(page);
  const botones = page.getByTestId("info-calculo");
  if (!DS3) {
    await expect(botones.first()).toBeHidden();
    vigilante.verificar();
    return;
  }
  await expect(botones).toHaveCount(5);
  const ordenes = page.getByRole("button", { name: "Cómo se calculó: Número de órdenes" });
  await expect(ordenes).toBeVisible();
  const caja = await ordenes.boundingBox();
  expect([Math.round(caja!.width), Math.round(caja!.height)]).toEqual([32, 32]);
  await capturar(page, info, "restaurantes-resumen-kpi");

  await ordenes.click();
  const drawer = page.getByRole("dialog", { name: "Cómo se calculó: Número de órdenes" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("De dónde sale")).toBeVisible();
  await expect(drawer.getByText("Pedidos registrados en Atiende")).toBeVisible();
  await expect(drawer.getByText("Qué no sabemos")).toBeVisible();
  await expect(drawer.getByText("Clase de dato")).toBeVisible();
  await capturar(page, info, "restaurantes-drawer-calculo");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(ordenes, "el foco vuelve al (i) al cerrar con Esc").toBeFocused();
  vigilante.verificar();
});

test("falla de la API: «no disponible» con «Reintentar» en primario suave", async ({ page, iniciarSesion, mock, vigilante }, info) => {
  vigilante.permitirRespuesta5xx(/\/admin\/kpis\//);
  await iniciarSesion("restaurantes", "owner");
  await mock.inyectarFalla({ metodo: "GET", ruta: "/admin/kpis/sales", status: 503 });
  await page.goto(rest());
  const alerta = page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Reintentar" }) });
  await expect(alerta).toBeVisible();
  const reintentar = alerta.getByRole("button", { name: "Reintentar" });
  if (DS3) {
    const lectura = await reintentar.evaluate((b) => ({ alto: Math.round(b.getBoundingClientRect().height), radio: getComputedStyle(b).borderTopLeftRadius, icono: getComputedStyle(b, "::before").content.includes("↻") }));
    expect(lectura).toEqual({ alto: 30, radio: "8px", icono: true });
    const ver = alerta.getByRole("button", { name: "Ver detalle técnico" });
    if (await ver.count()) {
      await expect(alerta.getByText("No está disponible ahora. Vuelve a intentarlo en un momento.")).toBeVisible();
      await ver.click();
      await expect(alerta.getByRole("button", { name: "Ocultar detalle técnico" })).toHaveAttribute("aria-expanded", "true");
    }
  }
  await capturar(page, info, "restaurantes-resumen-error");
  await mock.limpiarFallas();
  await reintentar.click();
  await expect(page.locator(".ds3-resumen")).toBeVisible();
  vigilante.verificar();
});
