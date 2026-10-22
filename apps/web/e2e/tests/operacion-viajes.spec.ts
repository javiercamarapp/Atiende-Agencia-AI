// Panel movil del encargado: Viajes contra la API simulada. «Salió» es UN solo POST de despacho (nunca PATCH) con confirmacion;
// el pedido pasa a «En camino» con el chofer; el pedido de mas de 90 min se ve en rojo con alerta.
import { dialogo } from "../helpers/dialogos.ts";
import { elegirEtiqueta } from "../helpers/listas.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const VIAJES = `/restaurantes/${restaurantes.orgSlug}/operacion/viajes`;

test.describe("operacion encargado: viajes", () => {
  test("muestra por salir y en camino; el de mas de 90 min va en rojo con alerta", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await page.goto(VIAJES);
    await expect(page.getByRole("heading", { name: "Viajes" })).toBeVisible();
    await expect(page.getByTestId("viaje-pedido-146")).toContainText("Raúl C.");
    const camino = page.getByTestId("en-camino-141");
    await expect(camino).toHaveAttribute("data-semaforo", "rojo");
    await expect(camino).toContainText("Atrasado");
    await expect(page.getByRole("alert")).toContainText("más de 90 minutos");
    await expect(page.getByRole("button", { name: /^Salió/ })).toBeDisabled();
    vigilante.verificar();
  });

  test("Salió pide confirmacion, manda un solo POST de despacho y el pedido pasa a en camino", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await page.goto(VIAJES);
    await page.getByTestId("viaje-pedido-146").click();
    const salio = page.getByRole("button", { name: "Salió (1 pedido)" });
    expect((await salio.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(56);
    await mock.limpiarRegistro();
    await salio.click();
    const d = dialogo(page, /Salieron|Salió/);
    await d.getByRole("button", { name: "Volver" }).click();
    await expect(d).toBeHidden();
    expect(await mock.buscar({ metodo: "POST", ruta: "/admin/orders/dispatch" })).toHaveLength(0);

    await salio.click();
    await dialogo(page, /Salió|Salieron/).getByRole("button", { name: "Sí, salió" }).click();
    await expect(page.getByTestId("en-camino-146")).toContainText("Chofer: Luis (prueba)");
    await expect(page.getByTestId("viaje-pedido-146")).toBeHidden();
    const dispatch = await mock.buscar({ metodo: "POST", ruta: "/admin/orders/dispatch" });
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]?.cuerpo).toMatchObject({ desdeEstado: "preparando", etaMin: 35 });
    expect(await mock.buscar({ metodo: "PATCH", ruta: "/admin/orders/" })).toHaveLength(0);
    vigilante.verificar();
  });

  test("chofer fuera de turno: pregunta y despacha solo con confirmacion", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await page.goto(VIAJES);
    await page.getByTestId("viaje-pedido-146").click();
    await elegirEtiqueta(page.getByRole("combobox", { name: /Chofer/ }), "Pedro (prueba) (0 activos) · fuera de turno");
    await page.getByRole("button", { name: "Salió (1 pedido)" }).click();
    await dialogo(page, /Salió|Salieron/).getByRole("button", { name: "Sí, salió" }).click();
    await dialogo(page, "Chofer fuera de turno").getByRole("button", { name: "Sí, despachar" }).click();
    await expect(page.getByTestId("en-camino-146")).toContainText("Chofer: Pedro (prueba)");
    const intentos = await mock.buscar({ metodo: "POST", ruta: "/admin/orders/dispatch" });
    expect(intentos.map((i) => (i.cuerpo as { forzar?: boolean }).forzar ?? false)).toEqual([false, true]);
    vigilante.verificar();
  });
});
