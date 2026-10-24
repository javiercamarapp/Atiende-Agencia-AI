// Sucursales: interruptores de voz y WhatsApp por sucursal y «Copiar ID» contra la API simulada (PUT reales, con confirmacion al apagar).
import { expect, test } from "../../helpers/fixtures.ts";
import { BASE } from "../../helpers/recorrido.ts";

test.describe("restaurantes sucursales: controles por sucursal @recorrido", () => {
  test("owner apaga y enciende WhatsApp: confirma al apagar y manda PUT; voz sale de su configuracion", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`${BASE}/sucursales`);
    const wa = page.getByRole("switch", { name: /Agente de WhatsApp activo/ });
    const voz = page.getByRole("switch", { name: /Agente de voz activo/ });
    await expect(wa).toBeVisible();
    await expect(voz).toBeVisible();
    await expect(wa).toBeChecked();
    await mock.limpiarRegistro();
    await wa.click();
    await page.getByRole("button", { name: "Volver" }).click();
    expect(await mock.buscar({ metodo: "PUT", ruta: "agente-whatsapp" })).toHaveLength(0);
    await wa.click();
    await page.getByRole("button", { name: "Apagar agente" }).click();
    await expect(wa).not.toBeChecked();
    const [put] = await mock.buscar({ metodo: "PUT", ruta: "agente-whatsapp" });
    expect(put?.cuerpo).toEqual({ activo: false });
    await wa.click(); // encender: sin confirmacion
    await expect(wa).toBeChecked();
    await page.getByRole("button", { name: /Copiar ID de/ }).click();
    vigilante.verificar();
  });

  test("staff (gestion) no ve interruptores ni pide el estado a la API, pero conserva «Copiar ID»", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("restaurantes", "staff");
    await page.goto(`${BASE}/sucursales`);
    await expect(page.getByRole("button", { name: /Copiar ID de/ }).first()).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    expect(await mock.buscar({ metodo: "GET", ruta: "agente-whatsapp" })).toHaveLength(0);
  });
});
