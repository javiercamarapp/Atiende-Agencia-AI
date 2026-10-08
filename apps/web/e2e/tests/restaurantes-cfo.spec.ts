// CFO de restaurantes (CFO-07), contra la API SIMULADA con datos SINTÉTICOS (21–27 sep 2026; ver mock-api/fixtures/restaurantes-cfo.ts):
// abrir el CFO -> «Lo más importante» -> una sucursal y varias -> la tabla de sucursales suma el total -> estado de resultados: capturar la nómina que
// falta y ver que la línea deja de estar pendiente -> drill-down de una tarjeta a la lista de pedidos -> el staff no ve el CFO.
// La lógica real (alcance, permisos, SQL) la prueban apps/api/tests y scripts/verify-restaurantes-cfo-*. Las capturas solo se escriben si
// CAPTURAS_CFO_DIR apunta a una carpeta (docs/diseno-ux-capturas-cfo-restaurantes): así CI no genera nada.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil, sidebar } from "../helpers/navegacion.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const BASE = `/restaurantes/${restaurantes.orgSlug}/cfo`;
const RANGO = "desde=2026-09-21&hasta=2026-09-27&comparar=periodo_anterior";
const A = "00000000-0000-4000-8000-0000000000";
const T1 = `${A}a1`;
const T2 = `${A}a2`;
const T3 = `${A}a3`;
const T4 = `${A}a4`;

/** «$12,345» o «1,234» -> 12345 / 1234. */
const COLUMNA: Readonly<Record<string, number>> = { Pedidos: 1, "Ventas netas": 2 };
const numero = (texto: string | null): number => Number((texto ?? "").replace(/[^\d]/g, ""));

test.describe("restaurantes CFO @humo", () => {
  test("owner abre el CFO: ve «Lo más importante», el resumen narrado y los 12 indicadores, todo rotulado SINTÉTICO", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/resumen?${RANGO}`);
    await afirmarPantallaSana(page, "CFO · Resumen");
    await expect(page.getByRole("heading", { level: 1, name: "CFO" })).toBeVisible();
    if (!esMovil(page)) await expect(sidebar(page).getByRole("link", { name: "CFO", exact: true })).toBeVisible();

    await expect(page.getByRole("heading", { name: "Lo más importante" })).toBeAttached();
    const tarjetas = page.getByTestId("hallazgo");
    await expect(tarjetas.first()).toBeVisible();
    expect(await tarjetas.count()).toBeGreaterThanOrEqual(2);
    // La de mayor impacto va primero y destacada, con semáforo CON texto.
    await expect(tarjetas.first()).toHaveAttribute("data-destacada", "1");
    await expect(tarjetas.first().getByTestId("semaforo")).toContainText("Urgencia");
    await expect(page.getByTestId("hallazgo-impacto").first()).toContainText("en juego");

    await expect(page.getByTestId("cfo-avisos")).toContainText("SINTÉTICO");
    // Resumen narrado: la cifra se resalta y la marca interna [ref] no se ve.
    const narrativa = page.getByTestId("cfo-narrativa");
    await expect(narrativa.locator("strong").first()).toBeVisible();
    await expect(narrativa).not.toContainText("[ventas_netas]");
    await expect(page.getByTestId("kpi-cfo")).toHaveCount(12);
    // Una cifra sin dato dice «—», nunca 0: el costo del agente por pedido de Meta se avisa aparte.
    await expect(page.getByTestId("cfo-aviso-legal")).toContainText("No sustituye a tu contabilidad");
    await afirmarSinScrollHorizontal(page);
    vigilante.verificar();
  });

  test("cambia a una sucursal y a varias: la URL conserva el filtro y la API recibe las sucursales", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/resumen?${RANGO}`);
    await expect(page.getByTestId("hallazgo").first()).toBeVisible();

    const filtro = page.getByTestId("filtro-sucursales");
    await expect(filtro).toContainText("Todas las sucursales");
    await filtro.click();
    await page.getByRole("checkbox", { name: "Prolongación Montejo" }).click();
    await expect(page).toHaveURL(new RegExp(`sucursales=${T1}(&|$)`));
    await expect(filtro).toContainText("Prolongación Montejo");
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: `/admin/cfo/resumen?` })).some((r) => r.ruta.includes(`sucursales=${T1}`) && !r.ruta.includes(","))).toBe(true);

    await page.getByRole("checkbox", { name: "Francisco de Montejo" }).click();
    await expect(page).toHaveURL(new RegExp(`sucursales=${T1}(%2C|,)${T2}`));
    await expect(filtro).toContainText("2 sucursales");
    await expect(page.getByTestId("kpi-cfo")).toHaveCount(12);
    // Con una selección parcial el filtro aclara que «No asignado» (costos de la organización) no entra.
    await expect(page.getByText(/no se muestra «No asignado»/)).toBeVisible();

    // «Todas» devuelve la vista completa y quita el parámetro de la URL.
    await page.getByRole("checkbox", { name: "Todas", exact: true }).click();
    await expect(page).not.toHaveURL(/sucursales=/);
    await expect(filtro).toContainText("Todas las sucursales");
    vigilante.verificar();
  });

  test("Sucursales: la fila Total es la suma de las sucursales (pedidos y ventas netas) y «No asignado» solo aparece con todas las sucursales", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/sucursales?${RANGO}&sucursales=${T1},${T2}`);
    await expect(page.getByTestId("cfo-tabla-sucursales")).toBeVisible();
    const fila = (id: string) => page.locator(`[data-fila="${id}"]`).first();
    await expect(fila(T1)).toBeVisible();
    await expect(fila(T2)).toBeVisible();
    await expect(fila("total")).toBeVisible();
    const celda = async (id: string, columna: string): Promise<number> => {
      // La tabla conserva su forma de tabla (con desplazamiento horizontal propio) también en móvil: lado a lado se compara mejor.
      const f = fila(id);
      return numero(await f.getByRole("cell").nth(COLUMNA[columna] ?? 0).innerText());
    };
    const pedidos = (await celda(T1, "Pedidos")) + (await celda(T2, "Pedidos"));
    const neta = (await celda(T1, "Ventas netas")) + (await celda(T2, "Ventas netas"));
    expect(pedidos).toBeGreaterThan(0);
    expect(await celda("total", "Pedidos")).toBe(pedidos);
    // Las ventas se muestran en pesos enteros: la suma de los redondeos puede diferir en 1 peso del redondeo del total.
    expect(Math.abs((await celda("total", "Ventas netas")) - neta)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("leyenda-total")).toContainText("Total = suma de las sucursales");
    await expect(page.locator('[data-fila="no-asignado"]')).toHaveCount(0);

    // Con «Todas» (organización completa) aparece la fila «No asignado» (costo del agente de la organización) y la leyenda lo dice.
    await page.goto(`${BASE}/sucursales?${RANGO}`);
    await expect(fila("no-asignado")).toBeVisible();
    await expect(page.getByTestId("leyenda-total")).toContainText("Total = suma de sucursales + no asignado");
    vigilante.verificar();
  });

  test("Estado de resultados: la nómina de Pensiones está pendiente; al capturarla la línea deja de estarlo y el PUT lleva monto en centavos", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/estado-resultados?${RANGO}&sucursales=${T3}`);
    const nomina = page.locator('[data-linea="nomina"]').first();
    await expect(nomina).toContainText("Captura pendiente");
    // EBITDA solo con todas las líneas: lo dice y no inventa un monto.
    await expect(page.locator('[data-linea="ebitda"]').first()).toContainText("Incompleto: faltan nómina");
    await expect(page.getByTestId("pyl-incompleto")).toBeVisible();
    await expect(page.getByTestId("cfo-aviso-legal")).toBeVisible();

    await nomina.getByRole("button", { name: "Capturar costos: nómina" }).click();
    const dialogo = page.getByRole("dialog", { name: "Capturar costos" });
    await expect(dialogo).toBeVisible();
    await expect(page.getByTestId("captura-concepto")).toHaveValue("nomina");
    await expect(page.getByTestId("captura-ambito")).toHaveValue(T3);
    await expect(page.getByTestId("captura-historial")).toContainText("Todavía no hay una captura");
    // Sin monto no se puede guardar.
    await expect(dialogo.getByRole("button", { name: "Guardar costo" })).toBeDisabled();
    await page.getByTestId("captura-valor").fill("250000");
    await dialogo.getByRole("button", { name: "Guardar costo" }).click();

    await expect.poll(async () => (await mock.buscar({ metodo: "PUT", ruta: "/admin/cfo/costos" })).length).toBe(1);
    expect((await mock.buscar({ metodo: "PUT", ruta: "/admin/cfo/costos" }))[0]!.cuerpo).toEqual({
      costos: [{ propertyId: T3, mes: "2026-09-01", concepto: "nomina", montoCentavos: 25_000_000, pct: null, nota: null }],
    });
    await expect(dialogo).toHaveCount(0);
    await expect(page.locator('[data-linea="nomina"]').first()).not.toContainText("Captura pendiente");
    // El periodo (7 días) no cubre el mes: el costo mensual se prorratea por días y se rotula así (25,000,000 × 7/30 = $58,333).
    await expect(page.locator('[data-linea="nomina"]').first()).toContainText("$58,333");
    await expect(page.locator('[data-linea="nomina"]').first()).toContainText("Prorrateo");
    await expect(page.locator('[data-linea="nomina"]').first().getByTestId("chip-confianza").first()).toContainText(/Capturado|Estimado/);
    vigilante.verificar();
  });

  test("drill-down: la acción de una tarjeta abre la lista de pedidos que la respalda, sin datos personales", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/resumen?${RANGO}`);
    // Con las pestañas de CFO-08 registradas ninguna acción queda como texto: todas son enlaces reales.
    await expect(page.getByTestId("hallazgo-accion-sin-enlace")).toHaveCount(0);
    const primera = page.getByTestId("hallazgo").first();
    await expect(primera).toContainText("compensaciones de Galerías");
    await primera.getByTestId("hallazgo-accion").click();

    await expect(page).toHaveURL(new RegExp(`/cfo/ventas\\?.*sucursales=${T4}`));
    await expect(page).toHaveURL(/pedidos=1/);
    await expect(page).toHaveURL(/es_compensacion=1/);
    const dialogo = page.getByRole("dialog", { name: "Pedidos que respaldan esta cifra" });
    await expect(dialogo).toBeVisible();
    await expect(dialogo).toContainText("Compensaciones");
    await expect(dialogo.locator("[data-pedido]").first()).toBeVisible();
    // Sin PII: ni correos ni teléfonos ni direcciones; el cliente es un código corto.
    const texto = await dialogo.innerText();
    expect(texto).not.toMatch(/@|\+?\d{10}/);
    await dialogo.getByRole("button", { name: "Cerrar" }).click();
    await expect(dialogo).toHaveCount(0);
    await expect(page).not.toHaveURL(/pedidos=1/);
    vigilante.verificar();
  });

  test("staff de piso: no ve la entrada CFO, la URL directa dice «Tu rol no tiene acceso al CFO» y no se pide ninguna cifra", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("restaurantes", "staff");
    if (!esMovil(page)) await expect(sidebar(page).getByRole("link", { name: "CFO", exact: true })).toHaveCount(0);
    await page.goto(`${BASE}/resumen?${RANGO}`);
    await expect(page.getByText("Tu rol no tiene acceso al CFO")).toBeVisible();
    await expect(page.getByTestId("kpi-cfo")).toHaveCount(0);
    expect(await mock.buscar({ metodo: "GET", ruta: "/admin/cfo" })).toHaveLength(0);
  });

  test("la exportación (CFO-06) aún no existe en la API simulada: el botón responde con aviso y se oculta, sin romper la pantalla", async ({ page, iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/ventas?${RANGO}`);
    const excel = page.getByRole("button", { name: "Exportar Excel" });
    await expect(excel).toBeVisible();
    await excel.click();
    await expect(page.getByText("La exportación todavía no está disponible")).toBeVisible();
    await expect(page.getByRole("button", { name: "Exportar Excel" })).toHaveCount(0);
    await expect(page.getByTestId("cfo-ventas")).toBeVisible();
  });

  test("capturas: Resumen, Ventas, Sucursales y Estado de resultados (claro, oscuro y móvil) @oscuro", async ({ page, iniciarSesion, vigilante }, info) => {
    await iniciarSesion("restaurantes", "owner");
    const destino = process.env["CAPTURAS_CFO_DIR"];
    if (destino) mkdirSync(destino, { recursive: true });
    const vistas: ReadonlyArray<readonly [string, string, string]> = [
      ["1-resumen", `${BASE}/resumen?${RANGO}`, "hallazgo"],
      ["2-ventas", `${BASE}/ventas?${RANGO}`, "heatmap"],
      ["3-sucursales", `${BASE}/sucursales?${RANGO}`, "cfo-tabla-sucursales"],
      ["4-estado-resultados", `${BASE}/estado-resultados?${RANGO}&sucursales=${T3}`, "pyl-incompleto"],
    ];
    for (const [nombre, url, listo] of vistas) {
      await page.goto(url);
      await expect(page.getByTestId(listo).first()).toBeVisible();
      await afirmarPantallaSana(page, nombre);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await afirmarSinScrollHorizontal(page);
      await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
      if (destino) await page.screenshot({ path: join(destino, `${info.project.name}-${nombre}.png`) });
    }
    vigilante.verificar();
  });
});
