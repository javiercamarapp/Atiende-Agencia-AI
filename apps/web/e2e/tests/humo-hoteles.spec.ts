import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";
import { hoteles } from "../mock-api/fixtures/hoteles.ts";

test.describe("hoteles @humo", () => {
  test("owner: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("hoteles", "owner");
    expect(aterrizaje.startsWith(`/hoteles/${hoteles.orgSlug}`)).toBe(true);
    await afirmarPantallaSana(page, "panel");
    await recorrerSecciones(page, { minimo: 12 });
    vigilante.verificar();
  });

  test("owner: el Resumen pinta KPIs reales de la API simulada, un solo h1 y la ultima corrida, sin 4xx por rol", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("hoteles", "owner");
    await page.goto(`/hoteles/${hoteles.orgSlug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/^(Buenos días|Buenas tardes|Buenas noches), /);
    // Cada cifra sale de su endpoint: P&L, recepcion, tickets, aprobaciones y holds.
    const tarjeta = (rotulo: string) => page.locator("div.bg-card", { has: page.getByText(rotulo, { exact: true }) }).first();
    await expect(tarjeta("Ocupación")).toContainText("70.0%");
    await expect(tarjeta("Llegadas")).toContainText("4");
    await expect(tarjeta("En casa")).toContainText("17");
    await expect(tarjeta("Aprobaciones pendientes")).toContainText("1");
    await expect(tarjeta("Holds del agente")).toContainText("2");
    await expect(page.getByRole("heading", { name: "Orquestación de agentes" })).toBeVisible();
    await expect(page.getByText("Agente de reservas por WhatsApp y voz")).toBeVisible();
    const corrida = page.getByRole("region", { name: "Última corrida" });
    await expect(corrida).toContainText("Night audit");
    await expect(corrida).toContainText("OK");
    // Ninguna llamada del Resumen quedo sin fixture ni dio 4xx para el owner.
    expect(vigilante.sinFixture, "el Resumen pidio una ruta que la API simulada no conoce").toEqual([]);
    vigilante.verificar();
  });

  test("cancelar ticket: Volver y Escape no escriben; confirmar hace un POST /cancelar", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("hoteles", "owner");
    await page.goto(`/hoteles/${hoteles.orgSlug}/tickets`);
    await expect(page.getByText("Faltan toallas en la habitacion 204")).toBeVisible();
    const cancelar = page.getByRole("button", { name: "Cancelar", exact: true }).first();

    await afirmarCancelarNoEscribe(page, mock, cancelar, { nombre: "Cancelar este ticket", botonCancelar: "Volver", verificarFoco: false });

    await cancelar.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancelar ticket" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/tickets/tkt-1/cancelar" })).length).toBe(1);
    vigilante.verificar();
  });
});
