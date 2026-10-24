// Acceso del repartidor por celular + codigo (bandera LOGIN_CHOFER_WHATSAPP apagada por omision). La API simulada no distingue sesiones anonimas por
// escenario, asi que el servicio de codigos se simula dentro del navegador con page.route; sin ruta, el mock-api responde 404 y la pantalla dice la verdad.
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures.ts";

const json = (status: number, body: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

async function simular(page: Page, disponible: boolean) {
  await page.route("**/auth/login-telefono/**", async (route) => {
    const ruta = new URL(route.request().url()).pathname;
    const cuerpo = (route.request().postDataJSON() ?? {}) as { telefono?: string; codigo?: string };
    if (ruta.endsWith("/estado")) return route.fulfill(json(200, { disponible }));
    if (ruta.endsWith("/solicitar")) return route.fulfill(/^\d{10}$/.test(cuerpo.telefono ?? "") ? json(200, { ok: true, expiraEnSegundos: 300 }) : json(400, { message: "Escribe tu celular de 10 dígitos." }));
    return route.fulfill(json(401, { message: "Código incorrecto o vencido." }));
  });
}

test.describe("acceso del repartidor por celular", () => {
  test("bandera apagada: estado honesto y salida por correo", async ({ page, vigilante }) => {
    await page.goto("/restaurantes/acceso-repartidor");
    await expect(page.getByText("Todavía no está disponible")).toBeVisible();
    await page.getByRole("link", { name: /entrar con correo/i }).click();
    await expect(page).toHaveURL(/\/restaurantes\/login/);
    vigilante.verificar();
  });

  test("celular invalido, codigo y codigo erroneo, con botones de al menos 56 dp @oscuro", async ({ page }) => {
    await simular(page, true);
    await page.goto("/restaurantes/acceso-repartidor");
    const enviar = page.getByRole("button", { name: "Enviarme el código" });
    await expect(enviar).toBeVisible();
    expect((await enviar.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(56);
    await page.getByLabel(/Tu celular/).fill("123");
    await enviar.click();
    await expect(page.getByText("Escribe tu celular de 10 dígitos, por ejemplo 999 123 4567.")).toBeVisible();

    await page.getByLabel(/Tu celular/).fill("999 555 0100");
    await enviar.click();
    await expect(page.getByRole("heading", { name: "Escribe tu código" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Pedir otro código en/ })).toBeDisabled();
    await page.getByLabel(/Código de 6/).fill("000000");
    const entrar = page.getByRole("button", { name: "Entrar" });
    expect((await entrar.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(56);
    await entrar.click();
    await expect(page.getByText("Código incorrecto o vencido")).toBeVisible();
    await page.getByRole("button", { name: "Cambiar mi número" }).click();
    await expect(page.getByLabel(/Tu celular/)).toBeVisible();
  });
});
