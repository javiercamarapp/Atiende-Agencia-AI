// Conocimiento del negocio e interruptor del agente de WhatsApp por sucursal (migracion 053), de punta a punta en el navegador contra la API simulada:
// crear una FAQ, verla en la pestana Conocimiento del agente de voz Y en el editor del agente de WhatsApp (misma fuente), ver rechazado un precio,
// apagar el agente de WhatsApp de la sucursal con su confirmacion (Volver no escribe) y la casilla del saludo no interrumpible.
import type { Page } from "@playwright/test";
import { afirmarCancelarNoEscribe, dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { cuerpoDe, esperarEscrituras, ir } from "../../helpers/recorrido.ts";

const main = (page: Page) => page.locator("main#contenido-principal");
const SIN_FOCO = { verificarFoco: false } as const;

test.describe("restaurantes: conocimiento del negocio y agente de WhatsApp @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("crear una FAQ en Configuracion, verla en la pestana Conocimiento de voz y en el agente de WhatsApp", async ({ page, mock, vigilante }) => {
    await ir(page, "/configuracion");
    const seccion = page.getByTestId("conocimiento-negocio");
    await expect(seccion.getByText("Sin conocimiento cargado")).toBeVisible();

    await seccion.getByRole("button", { name: "Agregar entrada" }).click();
    const form = seccion.getByRole("region", { name: "Nueva entrada" });
    await form.getByPlaceholder("Estacionamiento", { exact: true }).fill("Estacionamiento");
    await form.getByPlaceholder(/^Hay estacionamiento gratuito/).fill("Hay estacionamiento gratuito para clientes en todas las sucursales.");
    await form.getByRole("button", { name: "Guardar entrada" }).click();
    const [post] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/conocimiento" });
    expect(cuerpoDe(post)).toMatchObject({ titulo: "Estacionamiento", tipo: "faq", sucursalId: null, prioridad: 50 });
    await expect(seccion.getByText("Hay estacionamiento gratuito para clientes en todas las sucursales.")).toBeVisible();
    await expect(seccion.getByText("Entrada guardada: el agente ya la usa.")).toBeVisible();

    // La misma entrada aparece en la pestana Conocimiento del agente de voz (una sola fuente para voz y WhatsApp).
    await ir(page, "/agente-voz");
    await page.getByRole("tab", { name: "Conocimiento" }).click();
    await expect(page.getByTestId("conocimiento-negocio").getByText("Estacionamiento").first()).toBeVisible();
    await expect(page.getByTestId("conocimiento-negocio").getByText("Hay estacionamiento gratuito")).toBeVisible();
    await expect(page.getByText("Las notas de conocimiento libres todavía no se guardan")).toHaveCount(0);
    vigilante.verificar();
  });

  test("un precio en el texto se rechaza con el mensaje del servidor y no se guarda nada", async ({ page, vigilante }) => {
    await ir(page, "/configuracion");
    const seccion = page.getByTestId("conocimiento-negocio");
    await seccion.getByRole("button", { name: "Agregar entrada" }).click();
    const form = seccion.getByRole("region", { name: "Nueva entrada" });
    await form.getByPlaceholder("Estacionamiento", { exact: true }).fill("Pastor");
    await form.getByPlaceholder(/^Hay estacionamiento gratuito/).fill("El pastor cuesta $10.");
    await form.getByRole("button", { name: "Guardar entrada" }).click();
    await expect(seccion.getByRole("alert")).toContainText("No incluya precios");
    await expect(seccion.getByText("El pastor cuesta $10.")).toHaveCount(1); // solo en el campo del formulario, no en la lista
    await expect(seccion.locator("[data-entrada]")).toHaveCount(0);
    vigilante.verificar();
  });

  test("Sucursales > Reglas de pedido > apagar el agente de WhatsApp: Volver y Escape no escriben; confirmar hace un PUT {activo:false}", async ({ page, mock, vigilante }) => {
    await ir(page, "/sucursales");
    await main(page).getByRole("button", { name: /Reglas de pedido/ }).click();
    const casilla = main(page).getByLabel("El agente contesta los mensajes de WhatsApp de esta sucursal");
    await expect(casilla).toBeChecked();

    await afirmarCancelarNoEscribe(page, mock, casilla, { nombre: /Apagar el agente de WhatsApp de esta sucursal/, botonCancelar: "Volver", ...SIN_FOCO });
    await expect(casilla).toBeChecked();

    await casilla.click();
    await dialogo(page, /Apagar el agente de WhatsApp de esta sucursal/).getByRole("button", { name: "Apagar agente" }).click();
    const [put] = await esperarEscrituras(mock, { metodo: "PUT", ruta: /\/agente-whatsapp$/ });
    expect(cuerpoDe(put)).toEqual({ activo: false });
    await expect(main(page).getByText(/Agente de WhatsApp apagado: los mensajes de esta sucursal llegan a la bandeja de Conversaciones/)).toBeVisible();
    await expect(casilla).not.toBeChecked();
    vigilante.verificar();
  });

  test("Agente de voz > Mensaje inicial: la casilla del saludo no interrumpible se guarda en el PUT de la config", async ({ page, mock, vigilante }) => {
    await ir(page, "/agente-voz");
    await page.getByRole("tab", { name: "Mensaje inicial" }).click();
    const casilla = page.getByLabel("Quien llama puede interrumpir el primer mensaje");
    await expect(casilla).toBeChecked();
    await casilla.uncheck();
    await expect(page.getByText(/se escucha completo aunque quien llama hable encima/)).toBeVisible();
    await page.getByRole("button", { name: "Guardar cambios" }).click();
    const [put] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/voz/config" });
    expect(cuerpoDe(put)).toMatchObject({ mensajeInicialInterrumpible: false });
    vigilante.verificar();
  });

  test("staff (no owner/admin) no ve el editor de conocimiento en el agente de voz", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await ir(page, "/agente-voz");
    await page.getByRole("tab", { name: "Conocimiento" }).click();
    await expect(page.getByTestId("conocimiento-negocio")).toHaveCount(0);
    await expect(page.getByText("lo administran el dueño o un administrador")).toBeVisible();
    vigilante.verificar();
  });
});
