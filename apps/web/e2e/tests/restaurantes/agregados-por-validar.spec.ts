// «Agregados por validar» (panel movil del operador) contra la API simulada: la cola con pedido original + lo agregado + cronometro, aceptar (con confirmacion si ya esta en
// cocina), rechazar con motivo de lista cerrada, doble toque seguro, banner persistente en otra pantalla, repartidor sin acceso y botones >= 56 dp. Escritorio y movil.
import { expect, test } from "../../helpers/fixtures.ts";
import { restaurantes } from "../../mock-api/fixtures/restaurantes.ts";

const RUTA = `/restaurantes/${restaurantes.orgSlug}/operacion/agregados`;

for (const vista of [
  { nombre: "escritorio", ancho: 1280, alto: 800 },
  { nombre: "movil", ancho: 390, alto: 800 },
]) {
  test.describe(`agregados por validar (${vista.nombre})`, () => {
    test.use({ viewport: { width: vista.ancho, height: vista.alto } });

    test("lista pendientes con pedido original, lo agregado, nuevo total, cronometro y avisos en texto", async ({ page, iniciarSesion, vigilante }) => {
      await iniciarSesion("restaurantes", "staff");
      await page.goto(RUTA);
      await expect(page.getByRole("heading", { name: "Agregados por validar" })).toBeAttached();
      const t1 = page.getByTestId("tarjeta-agregado-00000000-0000-4000-8000-000000000901");
      await expect(t1).toContainText("Pedido #201");
      await expect(t1).toContainText("4× Taco de pastor");
      await expect(t1).toContainText("2× Coca-Cola");
      await expect(t1).toContainText("Nuevo total: $190");
      await expect(t1).toContainText("Este pedido ya está en cocina");
      await expect(t1.getByTestId("cronometro")).toContainText("Hace");
      const t2 = page.getByTestId("tarjeta-agregado-00000000-0000-4000-8000-000000000902");
      await expect(t2.getByTestId("cronometro")).toHaveAttribute("data-nivel", "sin_respuesta"); // 12 min: pasó el plazo de 10
      await expect(t2).toContainText("el dueño y el cliente ya fueron avisados");
      await expect(page.getByTestId("banner-agregados")).toContainText("2 agregados por validar");
      const caja = await page.getByRole("button", { name: "Aceptar agregado al pedido #201" }).boundingBox();
      expect(caja?.height ?? 0).toBeGreaterThanOrEqual(56);
      vigilante.verificar();
    });

    test("aceptar un pedido ya en cocina pide confirmar; una sola escritura aunque se toque dos veces", async ({ page, iniciarSesion, mock, vigilante }) => {
      await iniciarSesion("restaurantes", "staff");
      await page.goto(RUTA);
      await mock.limpiarRegistro();
      await page.getByRole("button", { name: "Aceptar agregado al pedido #201" }).click();
      await expect(page.getByText("El pedido ya está en preparación")).toBeVisible();
      await page.getByRole("button", { name: "Sí, aceptar agregado" }).dblclick();
      await expect(page.getByTestId("tarjeta-agregado-00000000-0000-4000-8000-000000000901")).toBeHidden();
      const posts = await mock.buscar({ metodo: "POST", ruta: "/aceptar" });
      expect(posts).toHaveLength(1);
      await page.getByTestId("pestana-recientes").click();
      await expect(page.getByTestId("tarjeta-agregado-00000000-0000-4000-8000-000000000901").getByTestId("resolucion")).toContainText("Aceptado");
      vigilante.verificar();
    });

    test("rechazar exige motivo de la lista; «Otro» pide nota; queda rechazado con su motivo", async ({ page, iniciarSesion, mock, vigilante }) => {
      await iniciarSesion("restaurantes", "staff");
      await page.goto(RUTA);
      await mock.limpiarRegistro();
      await page.getByRole("button", { name: "Rechazar agregado al pedido #202" }).click();
      const confirmar = page.getByRole("button", { name: "Rechazar agregado", exact: true });
      await expect(confirmar).toBeDisabled();
      await page.getByRole("combobox").selectOption("otro").catch(async () => {
        await page.getByRole("combobox").click();
        await page.getByRole("option", { name: "Otro motivo" }).click();
      });
      await expect(confirmar).toBeDisabled(); // falta la nota
      await page.getByLabel("Nota").fill("Cocina saturada");
      await confirmar.click();
      await expect(page.getByTestId("tarjeta-agregado-00000000-0000-4000-8000-000000000902")).toBeHidden();
      const posts = await mock.buscar({ metodo: "POST", ruta: "/rechazar" });
      expect(posts[0]?.cuerpo).toEqual({ motivo: "otro", nota: "Cocina saturada" });
      vigilante.verificar();
    });

    test("el banner persistente aparece en otra pantalla y lleva a Agregados", async ({ page, iniciarSesion }) => {
      await iniciarSesion("restaurantes", "staff");
      await page.goto(`/restaurantes/${restaurantes.orgSlug}/historial`);
      const banner = page.getByTestId("banner-agregados-global");
      await expect(banner).toContainText("agregados por validar");
      await banner.getByRole("link", { name: "Validar ahora" }).click();
      await expect(page).toHaveURL(new RegExp(`${RUTA}$`));
      await expect(page.getByTestId("banner-agregados-global")).toHaveCount(0);
    });
  });
}

test("el repartidor no tiene la pantalla: lo redirige a su panel", async ({ page, iniciarSesion }) => {
  await iniciarSesion("restaurantes", "repartidor");
  await page.goto(RUTA);
  await expect(page).toHaveURL(/repartidor/);
});
