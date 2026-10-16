// Restaurantes (Los Taquitos de PM): comandas al POS (captura asistida) y clientes por nivel con importacion de cartera.
// API simulada (apps/web/e2e/mock-api): nunca la base real.
import { dialogo } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";
import { elegirValor, esperarValor } from "../helpers/listas.ts";

const BASE = `/restaurantes/${restaurantes.orgSlug}`;

test.describe("restaurantes comandas al POS", () => {
  test("pedido con comanda en 'Capturar a mano': la insignia lleva a la cola; se copia, se marca capturada y la insignia pasa a 'En POS'", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");

    // 1) Pedidos: la insignia de la comanda.
    await page.goto(`${BASE}/pedidos`);
    const insignia = page.getByTestId("comanda-pos-ord-1001");
    await expect(insignia).toHaveText("Capturar a mano");

    // 2) La insignia lleva a la cola; sin POS conectado el estado es honesto y el selector de modo esta deshabilitado.
    await insignia.click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/comandas-pos$`));
    await expect(page.getByTestId("pos-no-conectado")).toContainText("SoftRestaurant no conectado: requiere la API del distribuidor");
    await expect(page.locator("#pos-modo")).toBeDisabled();
    const tarjeta = page.getByTestId("comanda-cmd-3001");
    await expect(tarjeta).toContainText("Marisol Pech");
    await expect(tarjeta).toContainText("TAQ-PASTOR");
    await expect(tarjeta).not.toContainText("9995550101");
    await expect(page.getByTestId("estado-cmd-3001")).toHaveText("Capturar a mano");

    // 3) Copiar para POS.
    await tarjeta.getByRole("button", { name: "Copiar para POS" }).click();
    await expect(page.getByText(/Comanda copiada|no permitió copiar/).first()).toBeVisible();

    // 4) Marcar capturada: Volver no escribe; confirmar manda el folio del POS.
    await mock.limpiarRegistro();
    await tarjeta.getByRole("button", { name: "Marcar capturada" }).click();
    const d = dialogo(page, /Marcar capturada la comanda/);
    await d.getByRole("button", { name: "Volver" }).click();
    await expect(d).toBeHidden();
    expect(await mock.escrituras()).toEqual([]);
    await tarjeta.getByRole("button", { name: "Marcar capturada" }).click();
    await d.getByLabel("Folio del POS (opcional)").fill("T1-004512");
    await d.getByRole("button", { name: "Marcar capturada" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/comandas/cmd-3001/capturada" })).length).toBe(1);
    const [post] = await mock.buscar({ metodo: "POST", ruta: "/comandas/cmd-3001/capturada" });
    expect(post?.cuerpo).toMatchObject({ nota: "T1-004512" });
    await expect(page.getByText("No hay comandas en este filtro.")).toBeVisible();

    // 5) "Resueltas" muestra la comanda capturada; en Pedidos la insignia cambia a "En POS".
    await page.getByRole("tab", { name: "Resueltas" }).click();
    await expect(page.getByTestId("estado-cmd-3001")).toHaveText("Capturada a mano");
    await expect(page.getByTestId("comanda-cmd-3001")).toContainText("T1-004512");
    await page.goto(`${BASE}/pedidos`);
    await expect(page.getByTestId("comanda-pos-ord-1001")).toHaveText("En POS");
    vigilante.verificar();
  });
});

test.describe("restaurantes clientes por nivel", () => {
  test("importar un CSV de 3 clientes (uno con telefono invalido) y filtrar por 'sin pedir en 30 dias'", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/clientes`);
    await expect(page.getByTestId("cartera-kpis")).toContainText("Cliente más frecuente");
    await expect(page.getByTestId("cartera-kpis")).toContainText("********0101");
    await expect(page.getByRole("link", { name: /Marisol Pech/ })).toBeVisible();

    await page.getByRole("button", { name: "Importar clientes" }).click();
    const d = dialogo(page, "Importar clientes");
    await expect(d).toContainText("no crea pedidos ni manda mensajes");
    const csv = "Nombre,Teléfono\nAna Nueva,9991230001\nBruno Nuevo,+52 999 123 0002\nTelefono Malo,12345\n";
    await d.locator("#clientes-import-archivo").setInputFiles({ name: "cartera.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
    await expect(d).toContainText("3 renglones de datos");
    await esperarValor(d.locator("#clientes-import-telefono"), "1");

    await d.getByRole("button", { name: "Revisar vista previa" }).click();
    await expect(d.getByTestId("importar-vista-previa")).toContainText("Renglón 3: Telefono invalido");
    await d.getByRole("button", { name: "Importar 2 clientes" }).click();
    await expect(d.getByTestId("importar-resultado")).toContainText("Clientes nuevos");
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/customers/import" })).length).toBeGreaterThanOrEqual(2);
    await d.getByRole("button", { name: "Cerrar", exact: true }).last().click();
    await expect(d).toBeHidden();

    // Los importados aparecen y "Sin pedir en 30 dias" deja solo a quien no ha pedido (Marisol pidio hace 2 dias).
    await expect(page.getByRole("link", { name: /Ana Nueva/ })).toBeVisible();
    await elegirValor(page.locator("#restaurantes-clientes-inactivo"), "30");
    await expect(page.getByRole("link", { name: /Ana Nueva/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Bruno Nuevo/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Marisol Pech/ })).toHaveCount(0);
    vigilante.verificar();
  });
});
