// Panel movil del encargado: Nuevo pedido (captura por llamada) contra la API simulada. Consentimiento de WhatsApp explicito, total del
// servidor, privacidad del cliente existente (solo colonias) y el pedido capturado aparece en la Cola.
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures.ts";
import type { ClienteMock } from "../mock-api/cliente.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const BASE = `/restaurantes/${restaurantes.orgSlug}/operacion`;
const PRODUCTO_ID = "00000000-0000-4000-8000-000000000700";

/** El menu simulado usa ids cortos; el contrato exige UUID, asi que se siembra un producto con UUID y se recarga. */
async function abrirConMenu(page: Page, mock: ClienteMock) {
  await page.goto(`${BASE}/nuevo`);
  await expect(page.getByRole("heading", { name: "Nuevo pedido" })).toBeVisible();
  await mock.agregarAEstado("rest.productos", { id: PRODUCTO_ID, categoryId: "cat-1", categoryName: "Tacos", name: "Orden de pastor de prueba", description: null, price: 95, imageUrl: null, isPopular: true, isAvailable: true, displayOrder: 0, searchKeywords: [], branch: null });
  await page.reload();
  await expect(page.getByRole("button", { name: "Agregar Orden de pastor de prueba" })).toBeVisible();
}

async function llenarBasico(page: Page, colonia = "Centro") {
  await page.getByLabel("Teléfono del cliente").fill("999 123 4567");
  await page.getByLabel(/^Nombre/).fill("Ana R.");
  await page.getByLabel(/Dirección completa/).fill("Calle 60 número 320");
  await page.getByLabel("Colonia", { exact: true }).fill(colonia);
  await page.getByRole("button", { name: "Agregar Orden de pastor de prueba" }).click();
}

test.describe("operacion encargado: nuevo pedido", () => {
  test("no se puede guardar sin la respuesta del cliente; con Si guarda y el pedido llega a la cola", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await abrirConMenu(page, mock);
    await llenarBasico(page);
    await expect(page.getByTestId("resumen-total")).toContainText(/125\.00/); // 95 + 30 de envio, calculado por el servidor
    const guardar = page.getByRole("button", { name: /^Guardar/ });
    await expect(guardar).toBeDisabled();
    await expect(page.getByTestId("faltantes")).toContainText("aviso por WhatsApp");
    await expect(page.getByTestId("consentimiento-whatsapp")).toContainText("Le mandamos el aviso de su pedido por WhatsApp a este número, ¿está bien?");
    await expect(page.getByRole("button", { name: "No", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Sí, avisar" }).click();
    await expect(guardar).toBeEnabled();
    expect((await guardar.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(56);
    await mock.limpiarRegistro();
    await guardar.click();
    await expect(page.getByTestId("pedido-guardado")).toContainText(/Pedido #\d+ guardado/);
    const [post] = await mock.buscar({ metodo: "POST", ruta: "/admin/orders" });
    expect(post?.cuerpo).toMatchObject({ canalCaptura: "llamada", canal: "domicilio", confirmarYa: true, consentimientoWhatsapp: { otorgado: true, via: "verbal_llamada" } });
    expect(await mock.buscar({ metodo: "POST", ruta: "/admin/orders" })).toHaveLength(1);

    await page.getByRole("link", { name: "Ir a la cola" }).click();
    await page.getByTestId("pestana-preparacion").click();
    await expect(page.getByText("Ana R.")).toBeVisible();
    vigilante.verificar();
  });

  test("«No» al aviso guarda sin WhatsApp y lo dice", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await abrirConMenu(page, mock);
    await llenarBasico(page);
    await page.getByRole("button", { name: "No", exact: true }).click();
    await page.getByRole("button", { name: "Guardar sin aviso" }).click();
    await expect(page.getByTestId("pedido-guardado")).toContainText("avísale al cliente por llamada");
    vigilante.verificar();
  });

  test("fuera de cobertura: alerta roja y no deja guardar", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await abrirConMenu(page, mock);
    await llenarBasico(page, "Zona sin reparto");
    await page.getByRole("button", { name: "Sí, avisar" }).click();
    await expect(page.getByRole("alert")).toContainText("Fuera de cobertura");
    await expect(page.getByRole("button", { name: /^Guardar/ })).toBeDisabled();
    vigilante.verificar();
  });

  test("cliente existente: solo se muestran colonias; la direccion guardada no aparece ni se precarga", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await abrirConMenu(page, mock);
    await page.getByLabel("Teléfono del cliente").fill("999 555 0100");
    const caja = page.getByTestId("cliente-existente");
    await expect(caja).toContainText("Cliente Ejemplo");
    await expect(caja).toContainText("Centro");
    await expect(page.locator("body")).not.toContainText("Calle Ficticia");
    await expect(page.getByLabel(/Dirección completa/)).toHaveValue("");
    vigilante.verificar();
  });
});
