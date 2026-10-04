// QA restaurantes, ronda 1 (lote storefront / dinero / idempotencia): el storefront publico (/pedir/...) bajo red caida, servidor
// colgado, respuestas que no son JSON, doble clic y estados de pedido que la pagina de rastreo no conocia.
// La API del storefront se dobla con `page.route` dentro del navegador (nunca la base real). Regresiones de
// QA-restaurantes-R1-caos-07 a 12 (las pruebas "PASA" documentan lo que ya resistia).
import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? "8788"}`;
const RAIZ = `${API}/v1/restaurantes/demo-pm/storefront`;
const PAGINA = "/pedir/demo-pm/t7";

const COCA = {
  id: "prod-coca",
  name: "Coca-Cola 600 ml",
  description: null,
  price: 35,
  imageUrl: null,
  isPopular: false,
  available: true,
  packSize: null,
  requiresAdultConfirmation: false,
  requiresTortilla: false,
  noDomicilio: false,
};
const MENU = {
  sucursal: {
    slug: "t7",
    name: "T7 García Lavín",
    address: "Calle de prueba 1, Mérida",
    phone: null,
    abiertoAhora: true,
    cierraA: "01:00",
    proximaApertura: null,
    pedidoMinimoDomicilio: 200,
    pedidoMinimoRecoger: null,
    propinaPolitica: "solo_tarjeta",
    zonasReparto: [],
  },
  categorias: [{ id: "cat-bebidas", name: "Bebidas", items: [COCA] }],
};
const COTIZACION = {
  quote: { lines: [{ product_id: COCA.id, name: COCA.name, price: 35, quantity: 2, tortilla: null, line_total: 70 }], total: 70, contains_alcohol: false },
  quote_hash: "a".repeat(32),
  promo: null,
};

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });

interface Doble {
  quote?: (route: Route) => Promise<void> | void;
  confirm?: (route: Route) => Promise<void> | void;
  orders?: (route: Route) => Promise<void> | void;
  track?: (route: Route) => Promise<void> | void;
}

/** Dobla el storefront de PM y cuenta las peticiones por endpoint. */
async function doblar(page: Page, d: Doble = {}) {
  const cuenta = { quote: 0, confirm: 0, orders: 0, menu: 0, track: 0 };
  await page.route(`${RAIZ}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" } });
    const url = req.url();
    if (url.endsWith("/t7/menu")) {
      cuenta.menu++;
      return json(route, MENU);
    }
    if (url.endsWith("/t7/quote")) {
      cuenta.quote++;
      return d.quote ? d.quote(route) : json(route, COTIZACION);
    }
    if (url.endsWith("/t7/confirm")) {
      cuenta.confirm++;
      return d.confirm ? d.confirm(route) : json(route, { confirmado: true, quote_hash: COTIZACION.quote_hash });
    }
    if (url.endsWith("/t7/orders")) {
      cuenta.orders++;
      return d.orders ? d.orders(route) : json(route, { rastreo_token: "t1.tok.sig", estado: "pending", total: 70, canal: "recoger", sucursal: "T7 García Lavín", comanda: null });
    }
    if (url.includes("/track/")) {
      cuenta.track++;
      return d.track ? d.track(route) : json(route, { disponible: true, pedido: { status: "pending", branch: "T7 García Lavín", total: 70, paymentMethod: "efectivo", canal: "recoger", createdAt: "2026-10-03T19:00:00.000Z", items: [{ name: COCA.name, quantity: 2, tortilla: null }] } });
    }
    if (/\/storefront$/.test(url)) return json(route, { restaurante: { slug: "demo-pm", nombre: "Los Taquitos de PM" }, sucursales: [MENU.sucursal] });
    return json(route, { message: "sin doble" }, 404);
  });
  return cuenta;
}

async function llenarYRevisar(page: Page) {
  await page.goto(PAGINA);
  await page.getByRole("button", { name: `Agregar ${COCA.name} al carrito` }).click();
  await page.getByRole("button", { name: `Agregar ${COCA.name} al carrito` }).click();
  await page.getByLabel("Nombre").fill("Cliente de Prueba");
  await page.getByLabel("Teléfono").fill("9991112233");
  await page.getByRole("radio", { name: "Efectivo" }).check();
  await page.getByRole("checkbox").last().check();
  await page.getByRole("button", { name: "Revisar pedido" }).click();
}

test.describe("storefront bajo fallas @caos", () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright exige la forma desestructurada
  test.beforeEach(({}, info) => test.skip(info.project.name !== "escritorio-claro", "solo escritorio claro"));

  test("PASA: camino feliz doblado (cotizar -> confirmar -> crear -> rastreo)", async ({ page }) => {
    const cuenta = await doblar(page);
    await llenarYRevisar(page);
    await page.getByRole("button", { name: "Confirmar pedido" }).click();
    await expect(page).toHaveURL(/\/pedir\/demo-pm\/pedido\//);
    await expect(page.getByText("Recibido", { exact: true }).first()).toBeVisible();
    expect(cuenta.orders).toBe(1);
  });

  test("QA-caos-07: red caida al cotizar -> mensaje en espanol, no 'Failed to fetch'", async ({ page }) => {
    await doblar(page, { quote: (r) => r.abort("internetdisconnected") });
    await llenarYRevisar(page);
    const alerta = page.locator("form [role=alert]").last();
    await expect(alerta).toBeVisible();
    await expect(alerta).toContainText("No pudimos conectar con el restaurante");
    await expect(alerta).not.toHaveText(/failed to fetch|networkerror|load failed/i);
  });

  test("QA-caos-08: 200 con HTML (proxy/CDN) al cotizar -> mensaje generico en espanol, no el SyntaxError", async ({ page }) => {
    await doblar(page, { quote: (r) => r.fulfill({ status: 200, contentType: "text/html", headers: { "access-control-allow-origin": "*" }, body: "<html><body>Bad gateway</body></html>" }) });
    await llenarYRevisar(page);
    const alerta = page.locator("form [role=alert]").last();
    await expect(alerta).toBeVisible();
    await expect(alerta).toContainText("respuesta inesperada");
    await expect(alerta).not.toHaveText(/unexpected token|json|syntax/i);
  });

  test("QA-caos-09: POST /orders colgado -> a los ~20 s el dialogo se cierra con un error que invita a reintentar y no queda bloqueado", async ({ page }) => {
    test.setTimeout(75_000);
    await doblar(page, { orders: () => new Promise<void>(() => undefined) });
    await llenarYRevisar(page);
    await page.getByRole("button", { name: "Confirmar pedido" }).click();
    const alerta = page.locator("form [role=alert]").last();
    await expect(alerta).toContainText("tardó demasiado", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Confirmar pedido" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Revisar pedido" })).toBeEnabled();
  });

  test("PASA: doble clic en 'Confirmar pedido' manda un solo POST /orders", async ({ page }) => {
    const cuenta = await doblar(page, {
      orders: async (r) => {
        await new Promise((ok) => setTimeout(ok, 800));
        await json(r, { rastreo_token: "t1.tok.sig", estado: "pending", total: 70, canal: "recoger", sucursal: "T7", comanda: null });
      },
    });
    await llenarYRevisar(page);
    await page.getByRole("button", { name: "Confirmar pedido" }).dblclick();
    await expect(page).toHaveURL(/\/pedido\//);
    expect(cuenta.orders).toBe(1);
  });

  test("QA-caos-01/02: el servidor dice 409 ya_registrado al revisar -> se abre el rastreo del pedido existente", async ({ page }) => {
    await doblar(page, { quote: (r) => json(r, { code: "conflict", message: "Esta sesión ya tiene un pedido registrado.", motivo: "pedido_ya_creado", ya_registrado: true, rastreo_token: "t1.tok.sig" }, 409) });
    await llenarYRevisar(page);
    await expect(page).toHaveURL(/\/pedir\/demo-pm\/pedido\/t1\.tok\.sig/);
  });

  test("PASA: 500 al crear -> error visible y el carrito y la sesion se conservan para reintentar sin duplicar", async ({ page }) => {
    let primera = true;
    const sesiones: string[] = [];
    const cuenta = await doblar(page, {
      orders: async (r) => {
        sesiones.push((r.request().postDataJSON() as { session_id: string }).session_id);
        if (primera) {
          primera = false;
          return json(r, { message: "Error interno" }, 500);
        }
        return json(r, { ya_registrado: true, rastreo_token: "t1.tok.sig" });
      },
    });
    await llenarYRevisar(page);
    await page.getByRole("button", { name: "Confirmar pedido" }).click();
    await expect(page.locator("form [role=alert]").last()).toBeVisible();
    await page.getByRole("button", { name: "Revisar pedido" }).click();
    await page.getByRole("button", { name: "Confirmar pedido" }).click();
    await expect(page).toHaveURL(/\/pedido\//);
    expect(cuenta.orders).toBe(2);
    expect(sesiones[0]).toBe(sesiones[1]);
  });

  test("PASA: recargar a media captura conserva el carrito (no los datos personales)", async ({ page }) => {
    await doblar(page);
    await page.goto(PAGINA);
    await page.getByRole("button", { name: `Agregar ${COCA.name} al carrito` }).click();
    await page.getByLabel("Nombre").fill("Cliente de Prueba");
    await page.reload();
    await expect(page.getByRole("button", { name: "Revisar pedido" })).toBeEnabled();
    await expect(page.getByLabel("Nombre")).toHaveValue("");
  });

  test("QA-caos-10: rastreo de un pedido 'listo_para_recoger' muestra una etiqueta en espanol, no la clave interna", async ({ page }) => {
    await doblar(page, {
      track: (r) => json(r, { disponible: true, pedido: { status: "listo_para_recoger", branch: "T7 García Lavín", total: 70, paymentMethod: "efectivo", canal: "recoger", createdAt: "2026-10-03T19:00:00.000Z", items: [{ name: COCA.name, quantity: 2, tortilla: null }] } }),
    });
    await page.goto("/pedir/demo-pm/pedido/t1.tok.sig");
    await expect(page.getByText("Lo recoges en la sucursal.")).toBeVisible();
    await expect(page.getByText("Listo para recoger", { exact: true })).toBeVisible();
    await expect(page.getByText("listo_para_recoger")).toHaveCount(0);
  });

  test("QA-caos-11: un fallo transitorio del sondeo de rastreo conserva el ultimo estado conocido", async ({ page }) => {
    test.setTimeout(60_000);
    let n = 0;
    await doblar(page, {
      track: (r) => {
        n++;
        if (n === 2) return json(r, { message: "Servicio no disponible" }, 503);
        return json(r, { disponible: true, pedido: { status: "preparando", branch: "T7", total: 70, paymentMethod: "efectivo", canal: "recoger", createdAt: "2026-10-03T19:00:00.000Z", items: [{ name: COCA.name, quantity: 2, tortilla: null }] } });
      },
    });
    await page.goto("/pedir/demo-pm/pedido/t1.tok.sig");
    await expect(page.getByText("Preparando tu pedido")).toBeVisible();
    await expect.poll(() => n, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.getByText("Preparando tu pedido")).toBeVisible({ timeout: 1_000 });
    await expect(page.getByText("No pudimos actualizar el estado ahora")).toBeVisible();
  });

  test("QA-caos-12: rastreo a domicilio dice que se paga al repartidor, no 'en la sucursal'", async ({ page }) => {
    await doblar(page, {
      track: (r) => json(r, { disponible: true, pedido: { status: "en_camino", branch: "T7", total: 250, paymentMethod: "efectivo", canal: "domicilio", createdAt: "2026-10-03T19:00:00.000Z", items: [{ name: COCA.name, quantity: 2, tortilla: null }] } }),
    });
    await page.goto("/pedir/demo-pm/pedido/t1.tok.sig");
    await expect(page.getByText("Va a domicilio.", { exact: false })).toBeVisible();
    await expect(page.getByText(/Va a domicilio\. Pagas en efectivo al repartidor\./)).toBeVisible();
    await expect(page.getByText(/Va a domicilio\..*en la sucursal/)).toHaveCount(0);
  });
});
