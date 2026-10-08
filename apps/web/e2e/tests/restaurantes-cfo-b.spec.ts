// CFO de restaurantes B (CFO-08), contra la API SIMULADA con datos SINTÉTICOS (21–27 sep 2026; ver mock-api/fixtures/restaurantes-cfo-b.ts):
// las cinco pestañas (Clientes, Platillos, Patrones, Operación y agente, SoftRestaurant) y el recorrido de SoftRestaurant: sin datos -> importar el CSV
// SINTÉTICO -> mapeo -> vista previa -> confirmar -> cuadre con semáforo -> repetir el archivo («ya estaba cargado») -> un archivo con columna «Teléfono»
// (se excluye y se avisa; nunca viaja). Sin datos reales. Las capturas solo se escriben si CAPTURAS_CFO_DIR apunta a una carpeta.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const BASE = `/restaurantes/${restaurantes.orgSlug}/cfo`;
const RANGO = "desde=2026-09-21&hasta=2026-09-27&comparar=periodo_anterior";
const A = "00000000-0000-4000-8000-0000000000";
const T2 = `${A}a2`;
const ARCHIVOS = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const archivo = (nombre: string): string => join(ARCHIVOS, nombre);

test.describe("restaurantes CFO B @humo", () => {
  test("las cinco pestañas pintan su sección con datos SINTÉTICOS, sin scroll horizontal y sin errores de consola", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    const secciones: ReadonlyArray<readonly [string, string, string]> = [
      ["clientes", "cfo-clientes", "Clientes nuevos por semana"],
      ["platillos", "cfo-platillos", "Popularidad × ingreso"],
      ["patrones", "cfo-patrones", "Colonias"],
      ["operacion", "cfo-operacion", "Costo del agente"],
      ["softrestaurant", "cfo-softrestaurant", "Importar reporte de SoftRestaurant"],
    ];
    await page.goto(`${BASE}/resumen?${RANGO}`);
    await expect(page.getByTestId("hallazgo").first()).toBeVisible();
    for (const [slug, testid, texto] of secciones) {
      await page.getByTestId(`pestana-${slug}`).click();
      await expect(page).toHaveURL(new RegExp(`/cfo/${slug}\\?`));
      await expect(page.getByTestId(testid)).toBeVisible();
      await expect(page.getByTestId(testid).getByText(texto, { exact: false }).first()).toBeVisible();
      await expect(page.getByTestId("pestana-" + slug)).toHaveAttribute("aria-current", "page");
      await afirmarPantallaSana(page, `CFO · ${slug}`);
      await afirmarSinScrollHorizontal(page);
    }
    vigilante.verificar();
  });

  test("Clientes: aviso permanente de mostrador, «el total no es la suma» y ningún nombre ni teléfono", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/clientes?${RANGO}`);
    await expect(page.getByTestId("clientes-aviso-mostrador")).toContainText("los clientes de mostrador no se identifican");
    await expect(page.getByTestId("clientes-multisucursal")).toContainText("el total no es la suma");
    await expect(page.getByTestId("clientes-leyenda-frecuente")).toContainText("Frecuente");
    const texto = await page.getByTestId("cfo-clientes").innerText();
    expect(texto).not.toMatch(/@|\+?\d{10}/);
    await page.getByRole("button", { name: "Ver pedidos del periodo (con alias de cliente)" }).click();
    const dialogo = page.getByRole("dialog", { name: "Pedidos que respaldan esta cifra" });
    await expect(dialogo).toBeVisible();
    expect(await dialogo.innerText()).not.toMatch(/@|\+?\d{10}/);
    vigilante.verificar();
  });

  test("Patrones: las colonias chicas se agrupan en «(otras)» con la nota de privacidad; Operación: Meta no medido y p90 del conjunto", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/patrones?${RANGO}`);
    await expect(page.getByTestId("colonias-privacidad")).toContainText("(otras)");
    await expect(page.getByTestId("ranking-fila").filter({ hasText: "(otras)" }).first()).toBeVisible();
    await page.goto(`${BASE}/operacion?${RANGO}`);
    await expect(page.getByTestId("meta-no-medido")).toContainText("no es $0");
    await expect(page.locator("tr[data-tipo=conjunto]")).toContainText("p90 del conjunto, no suma");
    vigilante.verificar();
  });

  test("SoftRestaurant: sin datos, importa el CSV SINTÉTICO (mapeo, vista previa, confirmar), ve el cuadre con semáforo y el mismo archivo ya estaba cargado", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/softrestaurant?${RANGO}`);
    // Sin reporte: estado vacío grande y lotes vacíos.
    await expect(page.getByText("Sin datos de mostrador de SoftRestaurant", { exact: true })).toBeVisible();
    await expect(page.getByText("Sube el reporte de ventas por tipo de servicio o el listado de cuentas")).toBeVisible();
    await expect(page.getByTestId("sr-lotes")).toContainText("Todavía no cargas ningún reporte");
    // (a) comandas
    await expect(page.getByTestId("sr-comandas")).toContainText("Tasa de captura");

    await page.getByTestId("sr-importar-abrir").click();
    const dialogo = page.getByRole("dialog", { name: "Importar reporte de SoftRestaurant" });
    await expect(dialogo).toBeVisible();
    await dialogo.getByTestId("sr-sucursal").selectOption(T2);
    await dialogo.locator("#sr-archivo").setInputFiles(archivo("sr-cuentas-SINTETICO.csv"));
    // El título SINTÉTICO de arriba no es el encabezado: se detecta el renglón 2 y el listado de cuentas.
    await expect(dialogo.locator("#sr-fila-encabezado")).toHaveValue("1");
    await expect(dialogo.getByTestId("sr-tipo")).toHaveValue("cuentas");
    await expect(dialogo.getByTestId("sr-mapeo-folio")).toHaveValue("0");
    await dialogo.getByRole("button", { name: "Revisar vista previa" }).click();
    const previa = dialogo.getByTestId("sr-vista-previa");
    await expect(previa).toContainText("renglones aceptados y 0 rechazados");
    await expect(previa).toContainText("Alias de columnas inferidos");
    // La vista previa no escribe: solo existe la petición de vista previa, ninguna de importación.
    const peticiones = await mock.buscar({ metodo: "POST", ruta: "/softrestaurant/importar" });
    expect(peticiones.filter((r) => !r.ruta.includes("vista-previa"))).toHaveLength(0);
    await dialogo.getByRole("button", { name: /^Importar \d/ }).click();
    await expect(dialogo.getByTestId("sr-resultado")).toContainText("Reporte importado");
    await dialogo.locator("button:text-is('Cerrar')").click();
    await expect(dialogo).toHaveCount(0);

    // (b) el lote aparece con su cobertura; (c) el cuadre muestra el semáforo con TEXTO.
    await expect(page.getByTestId("sr-lotes")).toContainText("sr-cuentas-SINTETICO.csv");
    await expect(page.getByTestId("sr-cobertura").first()).toContainText("7 días");
    await expect(page.getByTestId("sr-cuadre")).toBeVisible();
    await expect(page.locator("tr[data-semaforo=verde]").first().getByTestId("semaforo")).toHaveText("Cuadra");
    await expect(page.locator("tr[data-semaforo=ambar]").first().getByTestId("semaforo")).toHaveText("Revisar");
    await expect(page.locator("tr[data-semaforo=rojo]").first().getByTestId("semaforo")).toHaveText("No cuadra");
    await expect(page.getByTestId("cfo-softrestaurant")).toContainText("el cuadre por pedido llega con el folio estructurado (fase 2)");

    // El mismo archivo con el mismo mapeo: «Este archivo ya estaba cargado».
    await page.getByTestId("sr-importar-abrir").click();
    await expect(dialogo).toBeVisible();
    await dialogo.getByTestId("sr-sucursal").selectOption(T2);
    await dialogo.locator("#sr-archivo").setInputFiles(archivo("sr-cuentas-SINTETICO.csv"));
    await dialogo.getByRole("button", { name: "Revisar vista previa" }).click();
    await expect(dialogo.getByTestId("sr-vista-previa")).toBeVisible();
    await dialogo.getByRole("button", { name: /^Importar \d/ }).click();
    await expect(dialogo.getByTestId("sr-ya-cargado")).toContainText("Este archivo ya estaba cargado");
    await dialogo.locator("button:text-is('Cerrar')").click();
    await expect(page.getByTestId("sr-lotes").locator("tbody tr")).toHaveCount(1);
    vigilante.verificar();
  });

  test("SoftRestaurant: el .xlsx SINTÉTICO de ventas por tipo de servicio se importa como resumen", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/softrestaurant?${RANGO}`);
    await page.getByTestId("sr-importar-abrir").click();
    const dialogo = page.getByRole("dialog", { name: "Importar reporte de SoftRestaurant" });
    await dialogo.getByTestId("sr-sucursal").selectOption(T2);
    await dialogo.locator("#sr-archivo").setInputFiles(archivo("sr-resumen-servicio-SINTETICO.xlsx"));
    await expect(dialogo.getByTestId("sr-tipo")).toHaveValue("resumen_servicio");
    await dialogo.getByRole("button", { name: "Revisar vista previa" }).click();
    await expect(dialogo.getByTestId("sr-vista-previa")).toContainText("renglones aceptados y 0 rechazados");
    await dialogo.getByRole("button", { name: /^Importar \d/ }).click();
    await expect(dialogo.getByTestId("sr-resultado")).toContainText("Reporte importado");
    await dialogo.locator("button:text-is('Cerrar')").click();
    await expect(page.getByTestId("sr-lotes")).toContainText("Ventas por tipo de servicio");
    vigilante.verificar();
  });

  test("SoftRestaurant: una columna «Teléfono» se excluye, se avisa «No subimos datos de tus clientes» y no viaja al API", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/softrestaurant?${RANGO}`);
    await page.getByTestId("sr-importar-abrir").click();
    const dialogo = page.getByRole("dialog", { name: "Importar reporte de SoftRestaurant" });
    await dialogo.getByTestId("sr-sucursal").selectOption(T2);
    await dialogo.locator("#sr-archivo").setInputFiles(archivo("sr-con-columna-personal-SINTETICO.csv"));
    const aviso = dialogo.getByTestId("sr-columnas-excluidas");
    await expect(aviso).toContainText("No subimos datos de tus clientes");
    await expect(aviso).toContainText("Teléfono");
    // La columna personal no se ofrece en ningún selector.
    await expect(dialogo.locator("#sr-mapeo-total option", { hasText: "Teléfono" })).toHaveCount(0);
    await dialogo.getByRole("button", { name: "Revisar vista previa" }).click();
    await expect(dialogo.getByTestId("sr-vista-previa")).toContainText("2 renglones aceptados");
    const enviadas = await mock.buscar({ metodo: "POST", ruta: "/softrestaurant/importar/vista-previa" });
    expect(enviadas).toHaveLength(1);
    const cuerpo = JSON.stringify(enviadas[0]!.cuerpo);
    expect(cuerpo).not.toMatch(/TEL-SINT|Tel[eé]fono/i);
    vigilante.verificar();
  });

  test("capturas: las cinco pestañas B (claro, oscuro y móvil) @oscuro", async ({ page, iniciarSesion, vigilante }, info) => {
    await iniciarSesion("restaurantes", "owner");
    const destino = process.env["CAPTURAS_CFO_DIR"];
    if (destino) mkdirSync(destino, { recursive: true });
    const vistas: ReadonlyArray<readonly [string, string, string]> = [
      ["1-clientes", `${BASE}/clientes?${RANGO}`, "cohortes-tabla"],
      ["2-platillos", `${BASE}/platillos?${RANGO}`, "matriz-dispersion"],
      ["3-patrones", `${BASE}/patrones?${RANGO}`, "colonias-privacidad"],
      ["4-operacion", `${BASE}/operacion?${RANGO}`, "costo-agente"],
      ["5-softrestaurant", `${BASE}/softrestaurant?${RANGO}`, "sr-comandas"],
    ];
    for (const [nombre, url, listo] of vistas) {
      await page.goto(url);
      await expect(page.getByTestId(listo).first()).toBeVisible();
      await afirmarPantallaSana(page, nombre);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await afirmarSinScrollHorizontal(page);
      await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
      if (destino) await page.screenshot({ path: join(destino, `${info.project.name}-${nombre}.png`), fullPage: true });
    }
    vigilante.verificar();
  });
});
