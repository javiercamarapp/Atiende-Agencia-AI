// QA adversarial ronda 2 (lente botones) -- pantallas nuevas desde la ronda 1 (Comandas al POS #435, Cliente 360 #417) y el shell: cambio de
// sucursal sin estado viejo, 404 dentro del shell (R1-11), selector de sucursal sin id duplicado (R1-03) y Agente de voz (R1-09/10).
// Contra la API simulada; ningun dato toca la base real.
import type { Page } from "@playwright/test";
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { BASE, afirmarSinEscrituras, cuerpoDe, esperarEscrituras, ir } from "../../helpers/recorrido.ts";
import { esMovil } from "../../helpers/navegacion.ts";
import { propiedadDe } from "../../mock-api/personas.ts";

const main = (page: Page) => page.locator("main#contenido-principal");
const PROP = propiedadDe("restaurantes");
const SEGUNDA = { propertyId: "00000000-0000-4000-8000-00000000a2b2", name: "Sucursal Norte", slug: "norte" };

test.describe("restaurantes R2 botones: Comandas al POS @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("Umbral de captura manual: un valor fuera de rango no se manda; uno valido hace UN PUT", async ({ page, mock, vigilante }) => {
    await ir(page, "/comandas-pos");
    const campo = main(page).getByLabel(`Minutos de espera en ${PROP.nombre}`);
    await expect(campo).toBeVisible();
    await mock.limpiarRegistro();
    await campo.fill("0");
    await campo.locator("xpath=../..").getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText(/entre 1 y 240/)).toBeVisible();
    await afirmarSinEscrituras(mock, "umbral fuera de rango");
    // El aviso (toast) se apila justo encima del boton en movil mientras dura: se espera a que se vaya.
    await page.mouse.move(0, 0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 15_000 });
    await campo.fill("15");
    await campo.locator("xpath=../..").getByRole("button", { name: "Guardar" }).click();
    const [put] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/umbral-captura-manual" }, 1);
    expect(cuerpoDe(put)).toMatchObject({ branchId: PROP.id, minutos: 15 });
    vigilante.verificar();
  });

  test("Marcar capturada: doble clic en confirmar manda UN solo POST", async ({ page, mock, vigilante }) => {
    await ir(page, "/comandas-pos");
    const tarjeta = page.getByTestId("comanda-cmd-3001");
    await tarjeta.getByRole("button", { name: "Marcar capturada" }).click();
    const d = dialogo(page, /Marcar capturada la comanda/);
    await mock.configurar({ latenciaMs: 500 });
    await d.getByRole("button", { name: "Marcar capturada" }).dblclick();
    await expect(d).toBeHidden();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/comandas/cmd-3001/capturada" })).length).toBeGreaterThan(0);
    // Un segundo POST lo rechazaria el servidor (409), pero la UI no debe mandarlo.
    expect((await mock.buscar({ metodo: "POST", ruta: "/comandas/cmd-3001/capturada" })).length).toBe(1);
    vigilante.verificar();
  });

  test("QA-R2-botones-03: al cambiar de filtro y fallar la carga, la cola NO conserva las comandas del filtro anterior", async ({ page, mock, vigilante }) => {
    vigilante.permitirRespuesta5xx(/softrestaurant\/comandas/);
    await ir(page, "/comandas-pos");
    await expect(page.getByTestId("comanda-cmd-3001")).toBeVisible();
    await mock.inyectarFalla({ metodo: "GET", ruta: "estado=enviada", status: 503 });
    await main(page).getByRole("tab", { name: /^Enviando al POS/ }).click();
    await expect(main(page).getByRole("alert").filter({ has: page.getByRole("button", { name: "Reintentar" }) })).toBeVisible();
    await expect(page.getByTestId("comanda-cmd-3001"), "la comanda Capturar a mano no pertenece al filtro Enviando al POS").toHaveCount(0);
  });
});

test.describe("restaurantes R2 botones: Cliente 360 @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("la ficha tiene un solo h1, Eliminar domicilio y Borrar memoria piden confirmacion y Cancelar/Escape no escriben", async ({ page, mock, vigilante }) => {
    await ir(page, "/clientes/cli-1");
    await expect(main(page).getByRole("heading", { level: 1, name: "Marisol Pech" })).toBeVisible();
    expect(await page.locator("h1").count(), "un solo h1 en la ficha").toBe(1);
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Eliminar", exact: true }).click();
    let d = dialogo(page, "Eliminar este domicilio");
    await d.getByRole("button", { name: /Cancelar|Volver/ }).click();
    await expect(d).toBeHidden();
    await main(page).getByRole("button", { name: "Borrar memoria del cliente" }).click();
    d = dialogo(page, "Borrar la memoria de este cliente");
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    await afirmarSinEscrituras(mock, "confirmaciones de la ficha canceladas");
    await main(page).getByRole("button", { name: "Borrar memoria del cliente" }).click();
    await dialogo(page, "Borrar la memoria de este cliente").getByRole("button", { name: "Borrar memoria" }).click();
    await esperarEscrituras(mock, { metodo: "POST", ruta: "/borrar-memoria" }, 1);
    await expect(main(page).getByRole("status").filter({ hasText: "Memoria del cliente borrada." })).toBeVisible();
    vigilante.verificar();
  });

  test("Agregar domicilio: Guardar hace UN POST con la direccion; Cancelar cierra sin escribir", async ({ page, mock, vigilante }) => {
    await ir(page, "/clientes/cli-1");
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Agregar domicilio" }).click();
    await main(page).getByLabel("Dirección completa").fill("Calle 21 #100, Itzimna");
    await main(page).getByRole("button", { name: "Cancelar" }).click();
    await expect(main(page).getByLabel("Dirección completa")).toHaveCount(0);
    await afirmarSinEscrituras(mock, "Agregar domicilio cancelado");
    await main(page).getByRole("button", { name: "Agregar domicilio" }).click();
    await main(page).getByLabel("Dirección completa").fill("Calle 21 #100, Itzimna");
    await main(page).getByRole("button", { name: "Guardar domicilio" }).click();
    const [post] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/customers/cli-1/addresses" }, 1);
    expect(cuerpoDe(post)).toMatchObject({ address: "Calle 21 #100, Itzimna" });
    vigilante.verificar();
  });

  test("QA-R2-botones-08: doble clic en 'Guardar domicilio' crea UN solo domicilio", async ({ page, mock }) => {
    await ir(page, "/clientes/cli-1");
    await main(page).getByRole("button", { name: "Agregar domicilio" }).click();
    await main(page).getByLabel("Dirección completa").fill("Calle 21 #100, Itzimna");
    await mock.configurar({ latenciaMs: 500 });
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Guardar domicilio" }).dblclick();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/customers/cli-1/addresses" })).length).toBeGreaterThan(0);
    await expect(main(page).getByRole("status").filter({ hasText: "Domicilio guardado." })).toBeVisible();
    expect((await mock.buscar({ metodo: "POST", ruta: "/customers/cli-1/addresses" })).length, "un doble clic no debe crear dos domicilios").toBe(1);
  });

  test("QA-R2-botones-04: si guardar un domicilio falla, el formulario NO se cierra ni se pierde lo escrito", async ({ page, mock, vigilante }) => {
    vigilante.permitirRespuesta5xx(/addresses/);
    await ir(page, "/clientes/cli-1");
    await mock.inyectarFalla({ metodo: "POST", ruta: "/addresses", status: 503, veces: 1 });
    await main(page).getByRole("button", { name: "Agregar domicilio" }).click();
    await main(page).getByLabel("Dirección completa").fill("Calle 21 #100, Itzimna");
    await main(page).getByRole("button", { name: "Guardar domicilio" }).click();
    await expect(main(page).getByRole("alert")).toBeVisible();
    await expect(main(page).getByLabel("Dirección completa"), "el formulario debe seguir abierto con lo tecleado para reintentar").toHaveValue("Calle 21 #100, Itzimna");
  });

  test("QA-R2-botones-05: la falla de carga de la ficha ofrece Reintentar y se recupera", async ({ page, mock, vigilante }) => {
    vigilante.permitirRespuesta5xx(/\/ficha/);
    await mock.inyectarFalla({ metodo: "GET", ruta: "/customers/cli-1/ficha", status: 500 });
    await page.goto(`${BASE}/clientes/cli-1`);
    const alerta = main(page).getByRole("alert");
    await expect(alerta).toBeVisible();
    await mock.limpiarFallas();
    await alerta.getByRole("button", { name: "Reintentar" }).click({ timeout: 3000 });
    await expect(main(page).getByRole("heading", { level: 1, name: "Marisol Pech" })).toBeVisible();
  });
});

test.describe("restaurantes R2 botones: shell y sucursal activa @recorrido", () => {
  test("cambiar de sucursal: Pedidos muestra SOLO los de la sucursal nueva (sin estado viejo) y el selector no repite id", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await mock.agregarAEstado("rest.branches", SEGUNDA);
    await ir(page, "/pedidos");
    await expect(main(page).getByText("Marisol Pech", { exact: false }).first()).toBeVisible();
    // R1-botones-03: un solo elemento con el id del selector de sucursal.
    expect(await page.locator("#restaurantes-sucursal-activa").count(), "id del selector de sucursal duplicado").toBeLessThanOrEqual(1);
    const selector = esMovil(page) ? page.getByRole("combobox", { name: /Sucursal activa/i }).filter({ visible: true }).first() : page.locator("#restaurantes-sucursal-activa");
    await expect(selector).toBeVisible();
    await mock.agregarAEstado("rest.ordenes", { id: "ord-norte-1", propertyId: SEGUNDA.propertyId, branch: SEGUNDA.name, customerId: "c-n", customerName: "Cliente del Norte", customerPhone: "+529995550177", customerAddress: "Calle 31", total: 120, status: "pending", items: [], source: "web", notes: null, paymentMethod: "efectivo", createdAt: new Date().toISOString(), assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null, canal: "domicilio", propina: null, horaRecogida: null });
    await selector.selectOption(SEGUNDA.propertyId);
    await expect(main(page).getByText("Cliente del Norte", { exact: false }).first()).toBeVisible();
    await expect(main(page).getByText("Marisol Pech")).toHaveCount(0);
    await expect(main(page).getByText("Jorge Canul")).toHaveCount(0);
    vigilante.verificar();
  });

  test("R1-botones-11 (verifica cierre): una ruta desconocida dentro del panel muestra el 404 CON el shell", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/pedidoss`);
    await expect(page.locator("main#contenido-principal")).toBeVisible();
    await expect(page.getByRole("link", { name: "Volver al resumen" }).or(page.getByRole("button", { name: "Volver al resumen" }))).toBeVisible();
    if (!esMovil(page)) await expect(page.getByRole("complementary", { name: "Navegación principal" })).toBeVisible();
    else await expect(page.getByRole("navigation", { name: "Navegación móvil" })).toBeVisible();
    vigilante.verificar();
  });

  test("R1-botones-09/10 (verifica cierre): Agente de voz -- flechas mueven la pestana y la Vista previa se cierra con Escape", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "/agente-voz");
    const lista = main(page).getByRole("tablist", { name: "Secciones del agente de voz" });
    const primera = lista.getByRole("tab").first();
    await primera.focus();
    await page.keyboard.press("ArrowRight");
    await expect(lista.getByRole("tab").nth(1)).toBeFocused();
    await expect(lista.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
    await page.getByRole("banner").getByRole("button", { name: "Vista previa" }).or(main(page).getByRole("button", { name: "Vista previa" })).first().click();
    const vista = page.getByRole("dialog").first();
    await expect(vista).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(vista).toBeHidden();
    vigilante.verificar();
  });
});
