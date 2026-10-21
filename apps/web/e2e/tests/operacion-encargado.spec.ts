// Panel movil del encargado (Los Taquitos de PM): la Cola contra la API simulada. Flujo: ver la cola -> aceptar (una sola escritura con
// Idempotency-Key) -> el pedido pasa a «En preparación» -> Listo; botones >= 56 dp y estados honestos.
import { expect, test } from "../helpers/fixtures.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const COLA = `/restaurantes/${restaurantes.orgSlug}/operacion`;

test.describe("operacion encargado: cola", () => {
  test("lista los pedidos con semaforo en texto, boton grande y alerta de pedido nuevo", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await page.goto(COLA);
    await expect(page.getByRole("heading", { name: "Cola de pedidos" })).toBeVisible();
    const t150 = page.getByTestId("tarjeta-pedido-150");
    await expect(t150).toContainText("Ana R.");
    await expect(t150).toContainText("WhatsApp");
    await expect(t150).toContainText("Atrasado"); // 6 min sin aceptar: rojo con texto, no solo color
    await expect(t150).toHaveAttribute("data-semaforo", "rojo");
    await expect(page.getByTestId("tarjeta-pedido-151")).toContainText("Sin aviso al cliente: llamar");
    await expect(page.getByRole("alert")).toContainText("pedidos nuevos sin atender");
    await expect(page.getByText("puede no sonar")).toBeVisible();

    const aceptar = page.getByRole("button", { name: "Aceptar pedido #150" });
    const caja = await aceptar.boundingBox();
    expect(caja?.height ?? 0).toBeGreaterThanOrEqual(56);
    vigilante.verificar();
  });

  test("aceptar manda una sola escritura con Idempotency-Key, el pedido pasa a preparacion y despues a Listo", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await page.goto(COLA);
    await mock.limpiarRegistro();
    const aceptar = page.getByRole("button", { name: "Aceptar pedido #150" });
    await aceptar.dblclick(); // doble toque: el segundo no debe duplicar la escritura
    await expect(page.getByTestId("tarjeta-pedido-150")).toBeHidden();

    const patches = await mock.buscar({ metodo: "PATCH", ruta: "/admin/orders/" });
    expect(patches).toHaveLength(1);
    expect(patches[0]?.cuerpo).toEqual({ status: "preparando" });

    await page.getByTestId("pestana-preparacion").click();
    const t150 = page.getByTestId("tarjeta-pedido-150");
    await expect(t150).toBeVisible();
    await page.getByRole("button", { name: "Listo pedido #150" }).click();
    await expect(page.getByTestId("tarjeta-pedido-150")).toBeHidden();
    await page.getByTestId("pestana-listos").click();
    await expect(page.getByTestId("tarjeta-pedido-150")).toBeVisible();
    // Un domicilio listo se despacha en Viajes (con chofer), no desde la cola.
    await expect(page.getByRole("link", { name: "Despachar pedido #150 en Viajes" })).toBeVisible();
    vigilante.verificar();
  });

  test("el pedido en camino de mas de 90 min se ve en rojo", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await page.goto(COLA);
    await page.getByTestId("pestana-camino").click();
    const t141 = page.getByTestId("tarjeta-pedido-141");
    await expect(t141).toHaveAttribute("data-semaforo", "rojo");
    await expect(t141).toContainText("Atrasado");
    vigilante.verificar();
  });
});
