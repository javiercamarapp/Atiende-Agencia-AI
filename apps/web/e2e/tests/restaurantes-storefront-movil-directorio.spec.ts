// Storefront de restaurantes en el telefono (375 px): menu -> carrito (barra inferior + hoja) -> checkout, y el directorio
// publico de sucursales con insignias. La API del storefront se dobla con `page.route` dentro del navegador (nunca la base real).
import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? "8788"}`;
const RAIZ = `${API}/v1/restaurantes/demo-pm/storefront`;

const item = (id: string, name: string, price: number) => ({ id, name, description: null, price, imageUrl: null, isPopular: false, available: true, packSize: null, requiresAdultConfirmation: false, requiresTortilla: false, noDomicilio: false });
const MENU = {
  sucursal: { slug: "t7", name: "T7 García Lavín", address: "Calle de prueba 1, Mérida", phone: null, abiertoAhora: true, cierraA: "01:00", proximaApertura: null, pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null, zonasReparto: [] as string[], aceptaDomicilio: true, domicilioTexto: null },
  categorias: [
    { id: "c-tacos", name: "Tacos", items: [item("p-taco", "Tacos de cochinita", 120)] },
    { id: "c-bebidas", name: "Bebidas", items: [item("p-coca", "Coca-Cola 600 ml", 35), item("p-horchata", "Horchata", 40)] },
  ],
};
const DIRECTORIO = {
  restaurante: { slug: "demo-pm", nombre: "Los Taquitos de PM" },
  sucursales: [
    { slug: "t3", name: "Pensiones", address: "Calle 11 No. 371", phone: "+52 999 987 5410", horario: [{ dias: [1, 2, 3, 4, 5, 6, 0], abre: "12:00", cierra: "01:00" }], abiertoAhora: null, pideEnLinea: true, soloRecoger: false, insigniaDomicilio: "Domicilio vie-dom", deTemporada: false, soloInformativa: false, comoLlegarUrl: "https://www.google.com/maps/search/?api=1&query=Pensiones" },
    { slug: "playa", name: "Playa (Chicxulub)", address: "C. 19 x 22 y 24, Chicxulub", phone: null, horario: null, abiertoAhora: null, pideEnLinea: true, soloRecoger: true, insigniaDomicilio: null, deTemporada: true, soloInformativa: false, comoLlegarUrl: null },
    { slug: "galerias", name: "Galerías", address: "Plaza Galerías", phone: null, horario: null, abiertoAhora: null, pideEnLinea: false, soloRecoger: false, insigniaDomicilio: null, deTemporada: false, soloInformativa: true, comoLlegarUrl: null },
  ],
};
const COTIZACION = { quote: { lines: [{ product_id: "p-coca", name: "Coca-Cola 600 ml", price: 35, quantity: 2, tortilla: null, line_total: 70 }], total: 70, contains_alcohol: false }, quote_hash: "a".repeat(32), promo: null };

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });

async function doblar(page: Page) {
  const cuenta = { orders: 0 };
  await page.route(`${RAIZ}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" } });
    const url = req.url();
    if (url.endsWith("/directorio")) return json(route, DIRECTORIO);
    if (url.endsWith("/t7/menu")) return json(route, MENU);
    if (url.endsWith("/t7/quote")) return json(route, COTIZACION);
    if (url.endsWith("/t7/confirm")) return json(route, { confirmado: true, quote_hash: COTIZACION.quote_hash });
    if (url.endsWith("/t7/orders")) {
      cuenta.orders++;
      return json(route, { rastreo_token: "t1.tok.sig", estado: "pending", total: 70, canal: "recoger", sucursal: "T7 García Lavín", comanda: null });
    }
    if (url.includes("/track/")) return json(route, { disponible: true, pedido: { status: "pending", branch: "T7 García Lavín", total: 70, paymentMethod: "efectivo", canal: "recoger", createdAt: "2026-10-03T19:00:00.000Z", items: [{ name: "Coca-Cola 600 ml", quantity: 2, tortilla: null }] } });
    return json(route, { message: "sin doble" }, 404);
  });
  return cuenta;
}

test.describe("storefront en el telefono", () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright exige la forma desestructurada
  test.beforeEach(({}, info) => test.skip(info.project.name !== "movil-claro", "solo movil claro (375 px)"));

  test("menu -> carrito -> checkout: la barra inferior cuenta, la hoja abre y cierra, y el pedido se crea", async ({ page }) => {
    const cuenta = await doblar(page);
    await page.goto("/pedir/demo-pm/t7");
    // Sin productos no hay barra de pedido y el carrito no esta al final de la pagina.
    await expect(page.getByRole("button", { name: "Ver pedido" })).toHaveCount(0);
    await page.getByRole("button", { name: "Agregar Coca-Cola 600 ml al carrito" }).click();
    await page.getByRole("button", { name: "Agregar Coca-Cola 600 ml al carrito" }).click();
    const barra = page.getByRole("button", { name: "Ver pedido" });
    await expect(barra).toBeVisible();
    await expect(page.getByText("2 productos")).toBeVisible();
    await expect(page.getByText("$70").first()).toBeVisible();

    // Hoja inferior: se abre, Esc la cierra y el carrito sigue.
    await barra.click();
    const hoja = page.getByRole("dialog");
    await expect(hoja).toBeVisible();
    await expect(hoja.getByText("Tu pedido").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(hoja).toHaveCount(0);
    await expect(page.getByText("2 productos")).toBeVisible();

    // Checkout dentro de la hoja.
    await barra.click();
    await hoja.getByLabel("Nombre").fill("Cliente de Prueba");
    await hoja.getByLabel("Teléfono").fill("9991112233");
    await hoja.getByRole("radio", { name: "Efectivo" }).check();
    await hoja.getByRole("checkbox").last().check();
    await hoja.getByRole("button", { name: "Revisar pedido" }).click();
    await page.getByRole("button", { name: "Confirmar pedido" }).click();
    await expect(page).toHaveURL(/\/pedir\/demo-pm\/pedido\//);
    expect(cuenta.orders).toBe(1);
  });

  test("barra de categorias y buscador local", async ({ page }) => {
    await doblar(page);
    await page.goto("/pedir/demo-pm/t7");
    const nav = page.getByRole("navigation", { name: "Categorías del menú" });
    await expect(nav.getByRole("button", { name: "Tacos" })).toBeVisible();
    await nav.getByRole("button", { name: "Bebidas" }).click();
    await expect(page.getByRole("heading", { name: "Bebidas" })).toBeInViewport();
    await page.getByPlaceholder("Buscar en el menú").fill("horchata");
    await expect(page.getByText("Horchata")).toBeVisible();
    await expect(page.getByText("Tacos de cochinita")).toHaveCount(0);
    await page.getByPlaceholder("Buscar en el menú").fill("pizza");
    await expect(page.getByText("Sin resultados")).toBeVisible();
  });
});

test.describe("directorio publico de sucursales", () => {
  test("lista las sucursales con insignias; solo las activas llevan a pedir", async ({ page }) => {
    await doblar(page);
    await page.goto("/pedir/demo-pm/sucursales");
    await expect(page.getByRole("heading", { name: "Sucursales de Los Taquitos de PM" })).toBeVisible();
    await expect(page.getByText("Domicilio vie-dom")).toBeVisible();
    await expect(page.getByText("Solo recoger")).toBeVisible();
    await expect(page.getByText("Temporada")).toBeVisible();
    await expect(page.getByText("Solo informativa")).toBeVisible();
    await expect(page.getByRole("link", { name: "Cómo llegar" })).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=Pensiones");
    await expect(page.getByRole("link", { name: /Llamar/ })).toHaveAttribute("href", "tel:+529999875410");
    await expect(page.getByRole("link", { name: /^Pedir en/ })).toHaveCount(2);
    await page.getByRole("link", { name: "Pedir en Pensiones" }).click();
    await expect(page).toHaveURL(/\/pedir\/demo-pm\/t3$/);
  });
});
