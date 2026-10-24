// Acceso del repartidor por celular + codigo (bandera LOGIN_CHOFER_WHATSAPP apagada por omision). La API simulada no distingue sesiones anonimas por
// escenario, asi que el servicio de codigos se simula dentro del navegador con page.route; sin ruta, el mock-api responde 404 y la pantalla dice la verdad.
import type { Locator, Page } from "@playwright/test";
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

/** Alto de un control en px CSS (independiente del viewport: se trae a la vista antes de medir). */
async function alto(l: Locator): Promise<number> {
  await l.scrollIntoViewIfNeeded();
  return (await l.boundingBox())?.height ?? 0;
}

test.describe("acceso del repartidor por celular", () => {
  test("bandera apagada: estado honesto y salida por correo", async ({ page, vigilante }) => {
    await page.goto("/restaurantes/acceso-repartidor");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    // EstadoVacio se anuncia como role=status y trae la salida por correo como enlace.
    const estado = page.getByRole("status");
    await expect(estado).toBeVisible();
    await expect(estado.getByRole("link", { name: /correo/i })).toBeVisible();
    await expect(page.getByLabel(/Tu celular/)).toHaveCount(0);
    await estado.getByRole("link", { name: /correo/i }).click();
    await expect(page).toHaveURL(/\/restaurantes\/login/);
    vigilante.verificar();
  });

  // @oscuro: la pantalla publica no monta el selector de tema, asi que en los proyectos oscuros solo se comprueba que sigue usable (controles >= 56 px y mensajes visibles).
  test("celular invalido, codigo y codigo erroneo, con botones de al menos 56 px @oscuro", async ({ page, vigilante }) => {
    await simular(page, true);
    await page.goto("/restaurantes/acceso-repartidor");
    const celular = page.getByLabel(/Tu celular/);
    const enviar = page.locator("form").getByRole("button").first();
    await expect(celular).toBeVisible();
    expect(await alto(enviar)).toBeGreaterThanOrEqual(56);
    await celular.fill("123");
    await enviar.click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(celular).toHaveAttribute("aria-invalid", "true");

    await celular.fill("999 555 0100");
    await enviar.click();
    const codigo = page.getByLabel(/Código de 6/);
    await expect(codigo).toBeVisible();
    // Reenvio en cuenta regresiva: el boton de reenvio es el unico deshabilitado fuera del formulario.
    await expect(page.getByRole("button").and(page.locator("button:disabled"))).toHaveCount(1);
    await codigo.fill("000000");
    const entrar = page.locator("form").getByRole("button").first();
    expect(await alto(entrar)).toBeGreaterThanOrEqual(56);
    await entrar.click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(codigo).toHaveAttribute("aria-invalid", "true");
    // Volver al paso del celular: el campo de celular reaparece y el de codigo desaparece.
    await page.locator("button:not(:disabled):not([type=submit])").last().click();
    await expect(celular).toBeVisible();
    await expect(codigo).toHaveCount(0);
    vigilante.verificar();
  });
});
