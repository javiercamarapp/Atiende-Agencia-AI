// Avisos del staff (R-16) y Cierre del dia (R-42): cada control hace su peticion exacta al mock y la pantalla refleja el estado nuevo;
// el rol sin permiso recibe la restriccion sin pedir datos. Ver docs/QA-E2E.md (cobertura por pantalla).
import type { Page } from "@playwright/test";
import { expect, test } from "../../helpers/fixtures.ts";
import { cuerpoDe, esperarEscrituras, ir } from "../../helpers/recorrido.ts";
import { elegirValor } from "../../helpers/listas.ts";

const main = (page: Page) => page.locator("main#contenido-principal");

test.describe("restaurantes: avisos y cierres @recorrido", () => {
  test("Avisos (owner): apagar un aviso propio, apagar el de otra persona y guardar el tiempo de gracia", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "/avisos");
    const apagar = main(page).getByRole("switch", { name: "Avisarme: Entrega tardía" });
    await expect(apagar).toBeChecked();
    await mock.limpiarRegistro();
    await apagar.click();
    const [propia] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/admin/avisos/preferencias" });
    expect(cuerpoDe(propia)).toMatchObject({ tipo: "restaurantes.pedido.entrega_tardia", enabled: false });
    expect(cuerpoDe(propia)).not.toHaveProperty("userId");
    await expect(apagar).not.toBeChecked();

    await mock.limpiarRegistro();
    const casilla = main(page).getByLabel("Pedido nuevo para Staff restaurantes");
    await casilla.click();
    const [ajena] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/admin/avisos/preferencias" });
    expect(cuerpoDe(ajena)).toMatchObject({ tipo: "restaurantes.pedido.nuevo", enabled: false, userId: "restaurantes-staff" });
    await expect(casilla).not.toBeChecked();

    await mock.limpiarRegistro();
    await main(page).getByLabel(/Minutos de gracia en/).fill("60");
    await main(page).getByRole("button", { name: "Guardar" }).click();
    const [umbral] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/admin/avisos/umbral" });
    expect(cuerpoDe(umbral)).toMatchObject({ minutos: 60 });
    await expect(main(page).getByText("60 min", { exact: true })).toBeVisible();
    vigilante.verificar();
  });

  test("Avisos: un tiempo de gracia vacio se rechaza en la pantalla, sin escribir", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "/avisos");
    await expect(main(page).getByLabel(/Minutos de gracia en/)).toBeVisible();
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Guardar" }).click();
    await expect(main(page).getByText("Escribe los minutos como un número entero.")).toBeVisible();
    expect(await mock.escrituras(), "un valor invalido no llega al servidor").toEqual([]);
    vigilante.verificar();
  });

  test("Avisos (staff): solo ve Mis avisos, sin matriz del equipo ni umbrales", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await ir(page, "/avisos");
    await expect(main(page).getByRole("switch", { name: "Avisarme: Pedido nuevo" })).toBeVisible();
    await expect(main(page).getByText("Avisos del equipo")).toHaveCount(0);
    await expect(main(page).getByText("Entrega tardía por sucursal")).toHaveCount(0);
    await mock.limpiarRegistro();
    await main(page).getByRole("switch", { name: "Avisarme: Pedido nuevo" }).click();
    const [propia] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/admin/avisos/preferencias" });
    expect(cuerpoDe(propia)).toMatchObject({ tipo: "restaurantes.pedido.nuevo", enabled: false });
    vigilante.verificar();
  });

  test("Cierre del dia (owner): Generar crea el cierre, lo muestra y deja de ofrecerlo; el resumen semanal tiene el suyo", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "/cierres");
    await expect(main(page).getByTestId("cierre-detalle")).toBeVisible();
    const pendientes = main(page).getByTestId("cierres-pendientes").getByRole("button");
    const antes = await pendientes.count();
    expect(antes).toBeGreaterThan(0);
    const fecha = await pendientes.first().getAttribute("data-fecha");
    await mock.limpiarRegistro();
    await pendientes.first().click();
    const [generar] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/admin/cierres/generar" });
    expect(cuerpoDe(generar)).toMatchObject({ tipo: "dia", fecha });
    await expect(main(page).locator(`[data-cierre="${fecha}"]`)).toBeVisible();
    await expect(main(page).locator(`button[data-fecha="${fecha}"]`)).toHaveCount(0);

    await mock.limpiarRegistro();
    await elegirValor(main(page).getByLabel("Tipo de cierre"), "semana");
    await expect(main(page).getByTestId("cierres-pendientes").getByRole("button", { name: /Generar semana del/ })).toBeVisible();
    expect(await mock.escrituras(), "cambiar de tipo solo lee").toEqual([]);
    vigilante.verificar();
  });

  test("Cierre del dia: el staff que fuerza la URL ve la restriccion y no se piden cierres", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await mock.limpiarRegistro();
    await ir(page, "/cierres");
    await expect(main(page).getByText(/Solo los roles/)).toBeVisible();
    expect(await mock.buscar({ metodo: "GET", ruta: "/admin/cierres" }), "no debe pedir datos de gestion").toEqual([]);
    vigilante.verificar();
  });
});
