// Segunda tanda de controles del panel de restaurantes (Conversaciones, Turnos, Productos "no a domicilio", Pedidos hasta Entregado):
// cada uno hace la peticion exacta al mock y la pantalla refleja el estado nuevo. Ver docs/QA-E2E.md (cobertura por pantalla).
import type { Page } from "@playwright/test";
import { expect, test } from "../../helpers/fixtures.ts";
import { cuerpoDe, esperarEscrituras, ir } from "../../helpers/recorrido.ts";

const main = (page: Page) => page.locator("main#contenido-principal");

test.describe("restaurantes: controles, segunda tanda @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("Conversaciones: Tomar, nota interna y Marcar como resuelta hacen su POST", async ({ page, mock, vigilante }) => {
    await ir(page, "/conversaciones");
    await main(page).getByRole("button", { name: /WhatsApp · \+529995550101/ }).click();
    await main(page).getByRole("button", { name: "Tomar conversación" }).click();
    await esperarEscrituras(mock, { metodo: "POST", ruta: "/conversaciones/whatsapp/conv-1/tomar" });
    await main(page).getByLabel("Nueva nota").fill("El cliente pide sin cebolla");
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Agregar" }).click();
    const [nota] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/handoffs/ho-1/notas" });
    expect(cuerpoDe(nota)).toMatchObject({ texto: "El cliente pide sin cebolla" });
    await expect(main(page).getByText("El cliente pide sin cebolla")).toBeVisible();
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Marcar como resuelta" }).click();
    await esperarEscrituras(mock, { metodo: "POST", ruta: "/handoffs/ho-1/cerrar" });
    vigilante.verificar();
  });

  test("Conversaciones: Devolver al agente hace su POST", async ({ page, mock, vigilante }) => {
    await ir(page, "/conversaciones");
    await main(page).getByRole("button", { name: /WhatsApp · \+529995550101/ }).click();
    await main(page).getByRole("button", { name: "Tomar conversación" }).click();
    await esperarEscrituras(mock, { metodo: "POST", ruta: "/tomar" });
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Devolver al agente" }).click();
    await esperarEscrituras(mock, { metodo: "POST", ruta: "/handoffs/ho-1/devolver" });
    vigilante.verificar();
  });

  test("Turnos: Agregar turno y Quitar turno cambian la lista antes de guardar", async ({ page, mock, vigilante }) => {
    await ir(page, "/turnos");
    await expect(page.getByLabel("Nombre del turno 1")).toBeVisible();
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Agregar turno" }).click();
    await expect(page.getByLabel("Nombre del turno 2")).toBeVisible();
    await page.getByLabel("Nombre del turno 2").fill("Cena");
    expect(await mock.escrituras(), "agregar un turno no escribe hasta Guardar").toEqual([]);
    await main(page).getByRole("button", { name: "Quitar turno" }).first().click();
    await expect(page.getByLabel("Nombre del turno 2")).toHaveCount(0);
    await expect(page.getByLabel("Nombre del turno 1")).toHaveValue("Cena");
    await main(page).getByRole("button", { name: "Guardar turnos" }).click();
    const [put] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/turnos" });
    expect(cuerpoDe(put)).toMatchObject({ turnos: [{ nombre: "Cena" }] });
    vigilante.verificar();
  });

  test("Productos: marcar una categoria como 'no se vende a domicilio' hace un PUT", async ({ page, mock, vigilante }) => {
    await ir(page, "/productos");
    await mock.limpiarRegistro();
    await page.getByLabel("Bebidas: no se vende a domicilio").click();
    const [put] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/config/no-domicilio/categorias/cat-2" });
    expect(cuerpoDe(put)).toEqual({ noDomicilio: true });
    await expect(page.getByLabel("Bebidas: no se vende a domicilio")).toBeChecked();
    vigilante.verificar();
  });

  test("Pedidos: un pedido para recoger pasa de Preparando a Listo para recoger y a Entregado con un PATCH cada vez", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    await main(page).getByRole("button", { name: "Preparando", exact: true }).click();
    const tarjeta = main(page).locator('[data-testid^="pedido-"]').filter({ hasText: "Jorge Canul" }).first();
    await expect(tarjeta).toBeVisible();
    await mock.limpiarRegistro();
    await tarjeta.getByRole("button", { name: "Marcar Listo para recoger" }).click();
    const [uno] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/orders/ord-1002/status" });
    expect(cuerpoDe(uno)).toEqual({ status: "listo_para_recoger" });
    await main(page).getByRole("button", { name: "Listo para recoger", exact: true }).click();
    await main(page).getByRole("button", { name: "Marcar Entregado" }).first().click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PATCH", ruta: "/orders/ord-1002/status" })).length).toBe(2);
    expect(cuerpoDe((await mock.buscar({ metodo: "PATCH", ruta: "/orders/ord-1002/status" }))[1])).toEqual({ status: "entregado" });
    vigilante.verificar();
  });
});
