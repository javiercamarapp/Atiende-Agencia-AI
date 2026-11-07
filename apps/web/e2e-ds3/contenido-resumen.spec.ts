// ds3 «componentes de contenido», parte 1 (PARIDAD-ATIENDE-ROVAQ §R1 #4, #5 y P2): en el navegador real y con la bandera, (1) el Resumen de
// restaurantes tiene como nivel 1 «Resumen» 20/600/-0.5 (el saludo no se ve), la franja de estado de los datos y «Requiere tu atención»;
// (2) toda pantalla del menu lleva su antetitulo = grupo del menu, con texto real y uno solo; (3) en /copiloto hay UN item activo.
// Sin la bandera valida que el diseno actual no cambia (saludo como h1, sin piezas ds3 visibles). Guarda captura por pantalla y proyecto
// en `<DS3_SALIDA>/contenido-resumen/<pantalla>/<proyecto>-<etapa>[-ds3].png` y la adjunta al reporte.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { orgDe } from "../e2e/mock-api/personas.ts";
import { ETAPA, esperarSinCarga, prepararBandera } from "./comun.ts";

const SALIDA = process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia";
const DS3 = process.env["E2E_DISENO"] === "ds3";
const base = () => `/restaurantes/${orgDe("restaurantes").slug}`;

async function capturar(page: Page, info: TestInfo, pantalla: string): Promise<void> {
  const carpeta = join(SALIDA, "contenido-resumen", pantalla);
  mkdirSync(carpeta, { recursive: true });
  const png = join(carpeta, `${info.project.name}-${ETAPA}${DS3 ? "-ds3" : ""}.png`);
  await page.screenshot({ path: png, fullPage: false });
  await info.attach(`${pantalla}-${info.project.name}`, { path: png, contentType: "image/png" });
}

test.beforeEach(async ({ page }) => {
  await prepararBandera(page);
});

test("Resumen: H1 «Resumen», estado de los datos y «Requiere tu atención»", async ({ page, iniciarSesion, vigilante }, info) => {
  await iniciarSesion("restaurantes", "owner");
  await page.goto(base());
  await expect(page.locator("main#contenido-principal")).toBeVisible();
  await esperarSinCarga(page);
  const saludo = page.locator('.ds3-resumen h1[data-parte="titulo"]');
  if (!DS3) {
    await expect(saludo).toBeVisible();
    await expect(page.getByTestId("resumen-titulo-ds3")).toBeHidden();
    await expect(page.getByTestId("resumen-estado-datos")).toBeHidden();
    await capturar(page, info, "restaurantes-resumen");
    vigilante.verificar();
    return;
  }
  await expect(page.locator("html")).toHaveAttribute("data-diseno", "ds3");
  await expect(saludo).toBeHidden();
  const h1 = page.getByRole("heading", { level: 1, name: "Resumen", exact: true });
  await expect(h1).toBeVisible();
  expect(await page.getByRole("heading", { level: 1 }).count(), "un solo nivel 1 en el arbol accesible").toBe(1);
  const tipo = await h1.evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.fontSize, s.fontWeight, s.letterSpacing];
  });
  expect(tipo).toEqual(["20px", "600", "-0.5px"]);
  await expect(page.locator('.ds3-resumen [data-parte="eyebrow"]')).toHaveText("Resumen");
  await expect(page.getByTestId("resumen-frase").locator("strong").first()).toBeVisible();

  const franja = page.getByTestId("resumen-estado-datos");
  await expect(franja).toBeVisible();
  await expect(franja.locator("dt").first()).toHaveText("Periodo:");
  const atencion = page.getByTestId("resumen-atencion");
  await expect(atencion).toBeVisible();
  await expect(atencion.getByRole("heading", { level: 2 })).toContainText("Requiere tu atención");
  // El antetitulo del shell no se duplica sobre el del Resumen.
  await expect(page.getByTestId("eyebrow-pagina")).toBeHidden();
  await capturar(page, info, "restaurantes-resumen");
  vigilante.verificar();
});

test("antetitulo = grupo del menu, con texto real y uno solo por pantalla", async ({ page, iniciarSesion, vigilante }, info) => {
  await iniciarSesion("restaurantes", "owner");
  for (const [ruta, grupo, nombre] of [
    ["/pedidos", "Operación", "restaurantes-pedidos"],
    ["/clientes", "Clientes", "restaurantes-clientes"],
    ["/privacidad-organizacion", "Configuración", "restaurantes-privacidad-organizacion"],
  ] as const) {
    await page.goto(base() + ruta);
    await expect(page.locator("main#contenido-principal")).toBeVisible();
    await esperarSinCarga(page);
    const visibles = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("main .ds3-eyebrow-pagina, main .ds3-encabezado-eyebrow")]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => ({ texto: (el.textContent ?? "").trim(), tt: getComputedStyle(el).textTransform })),
    );
    if (DS3) {
      expect(visibles, `${ruta}: un antetitulo`).toHaveLength(1);
      expect(visibles[0]!.texto.toLowerCase(), `${ruta}: texto real del grupo`).toBe(grupo.toLowerCase());
      expect(visibles[0]!.tt).toBe("uppercase");
    } else {
      expect(visibles, `${ruta}: sin bandera no hay antetitulo derivado`).toEqual([]);
    }
    await capturar(page, info, nombre);
  }
  vigilante.verificar();
});

test("en /copiloto hay un solo item activo en el sidebar", async ({ page, iniciarSesion, vigilante }, info) => {
  test.skip(info.project.name.startsWith("m"), "el sidebar es de escritorio");
  await iniciarSesion("restaurantes", "owner");
  await page.goto(`${base()}/copiloto`);
  await expect(page.locator("main#contenido-principal")).toBeVisible();
  const activos = page.locator('aside [aria-current="page"]');
  await expect(activos).toHaveCount(1);
  await expect(activos).toHaveAttribute("aria-label", "Copiloto");
  await capturar(page, info, "restaurantes-copiloto");
  vigilante.verificar();
});
