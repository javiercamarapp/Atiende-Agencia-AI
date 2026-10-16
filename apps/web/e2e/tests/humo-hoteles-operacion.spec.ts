import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { hoteles } from "../mock-api/fixtures/hoteles.ts";

// UNI-C-hoteles (operacion): recorrido de las paginas de operacion con la estructura del DS (un solo h1, PageHeader, FormField,
// useConfirm). Corre en los proyectos claro/oscuro, de escritorio y movil. El barrido de accesibilidad con axe NO esta: la
// dependencia @axe-core/playwright no existe en el repo y agregarla requiere visto bueno del orquestador.
const base = `/hoteles/${hoteles.orgSlug}`;

test.describe("hoteles operacion @humo @oscuro", () => {
  test("Reservas -> Folio (cargo y reverso con confirmacion) -> Recepcion (check-in) -> Housekeeping (generar dia) -> Tickets", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("hoteles", "owner");

    // Reservas: un solo h1 y la reserva de la API simulada.
    await page.goto(`${base}/reservas`);
    await expect(page.getByRole("heading", { level: 1, name: "Reservas" })).toHaveCount(1);
    await expect(page.getByText("2026-10-02 → 2026-10-04")).toBeVisible();
    await afirmarPantallaSana(page, "reservas");

    // Folio: se abre desde la reserva ("Ver folio"), agrega un cargo y lo reversa tras confirmar.
    await page.getByRole("button", { name: "Ver folio" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/folios/fol-1$`));
    await expect(page.getByRole("heading", { level: 1, name: /^Folio: / })).toHaveCount(1);
    const formCargo = page.locator("form", { hasText: "Agregar cargo" });
    await formCargo.getByPlaceholder("Descripción").fill("Minibar");
    await formCargo.getByPlaceholder("Monto").fill("150");
    await formCargo.getByRole("button", { name: "Agregar" }).click();
    await expect(page.getByText("Extras · Minibar", { exact: true })).toBeVisible();

    const reversar = page.getByRole("button", { name: "Reversar", exact: true }).first();
    await afirmarCancelarNoEscribe(page, mock, reversar, { nombre: "Reversar cargo", botonCancelar: "Cancelar", verificarFoco: false });
    await reversar.click();
    const dialogo = page.getByRole("alertdialog", { name: "Reversar cargo" });
    await dialogo.getByRole("textbox").fill("Cobro duplicado");
    await dialogo.getByRole("button", { name: "Reversar cargo" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/cargos/chg-1/reverso" })).length).toBe(1);
    await expect(page.getByText("Cargo reversado.")).toBeVisible();
    await afirmarPantallaSana(page, "folio");

    // Recepcion: check-in de la llegada.
    await page.goto(`${base}/recepcion`);
    await expect(page.getByRole("heading", { level: 1, name: "Recepción" })).toHaveCount(1);
    await page.getByRole("button", { name: "Check-in" }).click();
    await expect(page.getByText("Check-in de Ana Torres en la habitacion 101.")).toBeVisible();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/recepcion/reservas/res-1/check-in" })).length).toBe(1);
    await afirmarPantallaSana(page, "recepcion");

    // Housekeeping: genera las tareas del dia.
    await page.goto(`${base}/housekeeping`);
    await expect(page.getByRole("heading", { level: 1, name: "Housekeeping" })).toHaveCount(1);
    await page.getByRole("button", { name: "Generar tareas del día" }).click();
    await expect(page.getByText("1 tarea(s) creada(s).")).toBeVisible();
    await afirmarPantallaSana(page, "housekeeping");

    // Tickets.
    await page.goto(`${base}/tickets`);
    await expect(page.getByRole("heading", { level: 1, name: "Tickets de huésped" })).toHaveCount(1);
    await expect(page.getByText("Faltan toallas en la habitacion 204")).toBeVisible();
    await afirmarPantallaSana(page, "tickets");

    vigilante.verificar();
  });
});
