import { expect, test } from "../helpers/fixtures.ts";
import { hoteles } from "../mock-api/fixtures/hoteles.ts";

// H-P3-01 (P0, dinero): un folio cerrado ya no admite cargos. Dos pantallas abiertas sobre el mismo folio (recepcion y gerencia): una lo
// cierra, la otra todavia lo ve abierto y manda un cargo. La API (trigger de la migracion 045 + 409 en apps/api/.../folios.ts) lo rechaza y
// la pantalla muestra el motivo legible en vez de un error generico; despues de recargar el folio aparece cerrado y sin formularios.
test.describe("hoteles folio cerrado @humo", () => {
  test("cerrar un folio y luego intentar un cargo desde otra pantalla muestra el 409 legible, sin crear el cargo", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("hoteles", "owner");
    const ruta = `/hoteles/${hoteles.orgSlug}/folios/fol-1`;
    await page.goto(ruta);
    await expect(page.getByRole("heading", { name: "Folio: Principal" })).toBeVisible();

    // Segunda pantalla de la misma sesion: cierra el folio con saldo en cero.
    const otra = await page.context().newPage();
    await otra.goto(ruta);
    await otra.getByRole("button", { name: "Cerrar folio (saldo en cero)" }).click();
    await otra.getByRole("alertdialog").getByRole("button", { name: "Sí, cerrar folio" }).click();
    await expect(otra.getByText(/Estado: cerrado \(saldo_cero\)/)).toBeVisible();
    await otra.close();

    // La primera pantalla sigue mostrando el folio abierto: el cargo que manda es el que pierde la carrera.
    await expect(page.getByText(/Estado: abierto/)).toBeVisible();
    await page.getByPlaceholder("Descripción").first().fill("Minibar tardío");
    await page.getByPlaceholder("Monto").first().fill("100");
    await page.getByRole("button", { name: "Agregar", exact: true }).click();
    await expect(page.getByText("El folio ya está cerrado: no admite más movimientos.")).toBeVisible();

    // Ningun cargo se creo y al recargar el folio aparece cerrado, sin formularios de cargo ni pago.
    expect(await mock.buscar({ metodo: "POST", ruta: "/folios/fol-1/cargos" })).toHaveLength(1);
    await page.reload();
    await expect(page.getByText(/Estado: cerrado \(saldo_cero\)/)).toBeVisible();
    await expect(page.getByText("Sin cargos.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Agregar", exact: true })).toHaveCount(0);
    vigilante.verificar();
  });
});
