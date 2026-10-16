// Autopiloto de restaurantes: pedido grande por aprobar -> pestana "Por aprobar" con insignia -> Aprobar -> la insignia se apaga y se registra UNA
// sola resolucion en la API simulada. La logica real (idempotencia, comanda al POS, avisos) la prueban apps/api/tests y scripts/verify-restaurantes-autopiloto.
import { expect, test } from "../helpers/fixtures.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";
import { SOLICITUD_GRANDE_ID } from "../mock-api/fixtures/restaurantes-autopiloto.ts";
import { elegirValor } from "../helpers/listas.ts";

test.describe("restaurantes autopiloto @humo", () => {
  test("owner: Por aprobar muestra el pedido grande y Aprobar lo resuelve una sola vez", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`/restaurantes/${restaurantes.orgSlug}/pedidos`);
    const insignia = page.getByTestId("insignia-por-aprobar");
    await expect(insignia).toHaveText("1");

    await page.getByRole("button", { name: /Por aprobar/ }).click();
    const tarjeta = page.getByTestId(`solicitud-${SOLICITUD_GRANDE_ID}`);
    await expect(tarjeta).toContainText("Evento Peniche");
    await expect(tarjeta).toContainText("60× Tacos al pastor");

    await tarjeta.getByRole("button", { name: "Aprobar", exact: true }).click();
    await expect(page.getByText("No hay nada por aprobar")).toBeVisible();
    await expect(insignia).toHaveCount(0);

    const resoluciones = await mock.buscar({ metodo: "POST", ruta: "/autopiloto/solicitudes/" });
    expect(resoluciones).toHaveLength(1);
    expect(resoluciones[0]!.cuerpo).toEqual({ decision: "aprobar" });
    vigilante.verificar();
  });

  test("owner: Rechazar pide un motivo de la lista y manda el motivo elegido", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`/restaurantes/${restaurantes.orgSlug}/pedidos`);
    await page.getByRole("button", { name: /Por aprobar/ }).click();
    await page.getByRole("button", { name: "Rechazar", exact: true }).click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo.getByRole("button", { name: "Rechazar pedido" })).toBeDisabled();
    await elegirValor(dialogo.getByRole("combobox"), "fuera_de_zona");
    await dialogo.getByRole("button", { name: "Rechazar pedido" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/autopiloto/solicitudes/" })).length).toBe(1);
    expect((await mock.buscar({ metodo: "POST", ruta: "/autopiloto/solicitudes/" }))[0]!.cuerpo).toEqual({ decision: "rechazar", motivo: "fuera_de_zona" });
  });

  test("cancelar un pedido desde Pedidos exige un motivo: sin motivo no hay PATCH", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`/restaurantes/${restaurantes.orgSlug}/pedidos`);
    await page.getByRole("button", { name: "Cancelar pedido" }).first().click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo.getByRole("button", { name: "Sí, cancelar pedido" })).toBeDisabled();
    expect(await mock.buscar({ metodo: "PATCH", ruta: "/status" })).toHaveLength(0);
    await elegirValor(dialogo.getByRole("combobox"), "duplicado");
    await dialogo.getByRole("button", { name: "Sí, cancelar pedido" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PATCH", ruta: "/status" })).length).toBe(1);
    expect((await mock.buscar({ metodo: "PATCH", ruta: "/status" }))[0]!.cuerpo).toEqual({ status: "cancelado", motivo: "duplicado" });
  });

  test("staff de piso: ve Por aprobar pero no las Reglas del autopiloto (solo owner/admin)", async ({ page, iniciarSesion }) => {
    await iniciarSesion("restaurantes", "staff");
    await page.goto(`/restaurantes/${restaurantes.orgSlug}/pedidos`);
    await expect(page.getByRole("button", { name: /Por aprobar/ })).toBeVisible();
    // Las herramientas viven en el menu «Herramientas»: ahi el staff de piso no tiene las reglas.
    await page.getByRole("button", { name: "Herramientas de pedidos" }).click();
    await expect(page.getByRole("button", { name: "Actualizar ahora" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reglas del autopiloto" })).toHaveCount(0);
  });
});
