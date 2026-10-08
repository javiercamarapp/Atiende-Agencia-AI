// Autopiloto 2 (restaurantes): aprobar o rechazar una campana de reactivacion con la API simulada, y la tarjeta «Asignar a X» del repartidor sugerido.
// Cada prueba afirma la peticion REAL al mock (metodo, ruta y cuerpo) y el estado en pantalla. El despachador de WhatsApp real no existe en e2e: los
// «envios simulados» son los mensajes encolados que devuelve el mock al aprobar (en Postgres real lo prueba scripts/verify-restaurantes-marketing-campanas).
import type { Page } from "@playwright/test";
import type { ClienteMock } from "../../mock-api/cliente.ts";
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { cuerpoDe, esperarEscrituras, ir } from "../../helpers/recorrido.ts";

const main = (page: Page) => page.locator("main#contenido-principal");

test.describe("restaurantes: autopiloto 2 @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("Campañas: muestra el borrador con costo estimado ANTES de aprobar y aprobar (tras confirmar) hace un POST decidir con 23 mensajes en cola", async ({ page, mock, vigilante }) => {
    await ir(page, "/campanas");
    await expect(main(page).getByText("Por aprobar", { exact: true })).toBeVisible();
    await expect(main(page).getByText("$18.40 MXN")).toBeVisible();
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: /Aprobar la campaña/ }).click();
    await expect(dialogo(page)).toContainText("$18.40 MXN");
    // Nada se envia hasta confirmar.
    await afirmarSinDecision(mock);
    await dialogo(page).getByRole("button", { name: "Aprobar y enviar" }).click();
    const [post] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/marketing/campanas/camp-e2e-1/decidir" });
    expect(cuerpoDe(post)).toEqual({ accion: "aprobar" });
    await expect(main(page).getByText("Aprobada", { exact: true })).toBeVisible();
    await expect(main(page).getByRole("button", { name: /Aprobar la campaña/ })).toHaveCount(0);
    vigilante.verificar();
  });

  test("Campañas: rechazar hace un POST decidir {rechazar}, no pide confirmar y no deja nada en cola", async ({ page, mock, vigilante }) => {
    await ir(page, "/campanas");
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: /Rechazar la campaña/ }).click();
    const [post] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/marketing/campanas/camp-e2e-1/decidir" });
    expect(cuerpoDe(post)).toEqual({ accion: "rechazar" });
    await expect(main(page).getByText("Rechazada", { exact: true })).toBeVisible();
    await expect(dialogo(page)).toBeHidden();
    vigilante.verificar();
  });

  test("Pedidos: al pasar a Preparando, «Asignar repartidor» trae preseleccionado y con «Sugerido: Ramon Uc» al repartidor del autopiloto (solo sugiere) y «Confirmar envío» hace el PATCH assign-repartidor", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    const fila = main(page).locator('[data-testid^="pedido-"]').filter({ hasText: "Marisol Pech" }).first();
    await fila.getByRole("button", { name: "Marcar Preparando" }).click();
    await fila.getByRole("button", { name: "Asignar repartidor" }).click();
    await expect(fila.getByText("Sugerido: Ramon Uc")).toBeVisible();
    await expect(fila.getByLabel("Elegir repartidor")).toHaveValue("usr-2");
    // La sugerencia es de solo lectura: ningun assign-repartidor hasta confirmar.
    expect((await mock.buscar({ metodo: "PATCH", ruta: "/assign-repartidor" })).length).toBe(0);
    await fila.getByRole("button", { name: "Confirmar envío" }).click();
    const [patch] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/orders/ord-1001/assign-repartidor" });
    expect(cuerpoDe(patch)).toMatchObject({ repartidorId: "usr-2" });
    vigilante.verificar();
  });
});

async function afirmarSinDecision(mock: ClienteMock): Promise<void> {
  expect((await mock.buscar({ metodo: "POST", ruta: "/decidir" })).length, "aprobar no debe llamar al servidor antes de confirmar").toBe(0);
}
