// ds3 «Guía» de restaurantes por rol contra el build y la API simulada: staff (recorrido de su menú, sin pantallas de gestión), repartidor
// (su panel sin sidebar) y owner en «Primeros pasos» (patrón /setup de Rovaq: avance honesto, recomendado, «Hacer el recorrido»).
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

async function conDs3(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("atiende-diseno", "ds3");
    } catch {
      // sin almacenamiento
    }
  });
}

test.describe("guia restaurantes @ds3", () => {
  test("staff: recorrido corto de 7 pasos con el contenido de restaurantes; no visita gestión", async ({ page, iniciarSesion }, info) => {
    await conDs3(page);
    await iniciarSesion("restaurantes", "staff");
    await page.locator('.guia-invitacion [data-guia-modo="corto"]').click();
    const tarjeta = page.locator(".guia-tarjeta");
    await expect(tarjeta.locator(".guia-contador").first()).toHaveText("Paso 1 de 7");
    await expect(tarjeta.locator("h2")).toHaveText("Resumen: tu día en cifras");
    await info.attach("staff-paso-1", { body: await page.screenshot(), contentType: "image/png" });
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("atiende:guia:abrir")));
    const pantallas = await page.locator(".guia-menu-pantallas button").allInnerTexts();
    expect(pantallas).toContain("Pedidos");
    for (const gestion of ["Staff", "Auditoría", "Configuración", "Agente de voz"]) expect(pantallas).not.toContain(gestion);
  });

  test("owner: Primeros pasos con el patrón /setup y «Hacer el recorrido»", async ({ page, iniciarSesion }, info) => {
    await conDs3(page);
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`/restaurantes/${restaurantes.orgSlug}/primeros-pasos`);
    const pp = page.locator(".guia-pp");
    await expect(pp).toContainText("Estás viendo la configuración como");
    await expect(pp).toContainText(/\d+ de \d+ que puedes hacer ahora/);
    await info.attach("primeros-pasos", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await pp.getByRole("button", { name: "Hacer el recorrido" }).click();
    await expect(page.locator(".guia-tarjeta")).toBeVisible();
  });
});
