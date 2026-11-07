// ds3 «Guía»: recorrido guiado de punta a punta contra el build y la API simulada. Con la bandera ds3: invitacion al primer ingreso,
// recorrido corto de 7 pasos, la tarjeta NUNCA tapa el elemento resaltado (defecto de Rovaq a 1440), viaje automatico entre pantallas,
// Esc cierra y conserva el paso, el progreso llega al servidor (PUT /v1/onboarding/progreso) y «Retomar donde lo dejé» lo recupera.
// Sin la bandera, la guia no se pinta. El boton «Guía» de la cabecera (carril del shell) emite `atiende:guia:abrir`; aqui se emite igual.
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

async function conDs3(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("atiende-diseno", "ds3");
    } catch {
      // sin almacenamiento: la prueba lo reportara al no ver la guia
    }
  });
}

const abrirGuia = (page: Page) => page.evaluate(() => window.dispatchEvent(new CustomEvent("atiende:guia:abrir")));

async function seTocan(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const foco = document.querySelector(".guia-capa:not([data-sin-foco]) .guia-foco")?.getBoundingClientRect();
    const tarjeta = document.querySelector(".guia-tarjeta")?.getBoundingClientRect();
    if (!foco || !tarjeta) return false;
    return tarjeta.left < foco.right && foco.left < tarjeta.right && tarjeta.top < foco.bottom && foco.top < tarjeta.bottom;
  });
}

test.describe("guia @ds3", () => {
  test("owner de restaurantes: invitacion, recorrido corto sin tapar el foco, viaje, Esc y retomar", async ({ page, iniciarSesion, mock }, info) => {
    test.skip(info.project.name.startsWith("movil"), "el caso movil va en su propia prueba");
    await conDs3(page);
    await iniciarSesion("restaurantes", "owner");
    const inv = page.locator(".guia-invitacion");
    await expect(inv).toContainText("Conoce Atiende");
    await expect(inv.locator('[data-guia-modo="corto"]')).toHaveText(/Recorrido corto \(\d+ pasos\)/);
    await info.attach("01-invitacion", { body: await page.screenshot(), contentType: "image/png" });

    await inv.locator('[data-guia-modo="corto"]').click();
    const tarjeta = page.locator(".guia-tarjeta");
    await expect(tarjeta).toBeVisible();
    await expect(tarjeta.locator(".guia-contador").first()).toHaveText(/Paso 1 de \d+/);
    await expect(page.locator(".guia-capa .guia-foco")).toBeVisible();
    await page.waitForTimeout(500);
    expect(await seTocan(page), "la tarjeta tapa el elemento resaltado").toBe(false);
    await info.attach("02-paso-1", { body: await page.screenshot(), contentType: "image/png" });

    // Avanza hasta el primer salto de pantalla: cuenta de 3 s y viaje real por el menu.
    for (let i = 0; i < 4 && !(await tarjeta.locator("h2").innerText()).startsWith("Vamos a"); i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(450);
      expect(await seTocan(page), "la tarjeta tapa el elemento resaltado").toBe(false);
    }
    await expect(tarjeta.locator("h2")).toHaveText(/^Vamos a /);
    await expect(page.locator(".guia-etiqueta")).toContainText("Haz clic aquí:");
    await info.attach("03-te-llevo", { body: await page.screenshot(), contentType: "image/png" });
    const antes = page.url();
    await expect.poll(() => page.url(), { timeout: 8_000 }).not.toBe(antes);
    await expect(tarjeta.locator("h2")).not.toHaveText(/^Vamos a /);

    // Esc cierra y conserva el paso; el progreso viaja al servidor.
    await page.keyboard.press("Escape");
    await expect(tarjeta).toHaveCount(0);
    // El PUT de Esc sale tras el debounce (400 ms): se espera a que el ULTIMO PUT ya sea el de cierre (los de pasos previos traen activo:true).
    const ultimoPut = async () => (await mock.buscar({ metodo: "PUT", ruta: "/v1/onboarding/progreso" })).at(-1)?.cuerpo as Record<string, unknown> | undefined;
    await expect.poll(async () => (await ultimoPut())?.activo).toBe(false);
    const ultimo = (await ultimoPut())!;
    expect(ultimo).toMatchObject({ pista: "restaurantes.owner", org: restaurantes.orgSlug, modo: "corto", activo: false });

    // Menu de la guia: rol, recorridos, retomar y saltar a una pantalla.
    await abrirGuia(page);
    const menu = page.locator("#guia-menu");
    await expect(menu).toContainText("Recorrido corto");
    await expect(menu).toContainText("Recorrido completo");
    await expect(menu).toContainText("Saltar a una pantalla");
    await info.attach("04-menu", { body: await page.screenshot(), contentType: "image/png" });
    await menu.locator("[data-guia-retomar]").click();
    await expect(tarjeta).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("movil: la tarjeta es una hoja inferior que no tapa la barra de navegacion ni el elemento", async ({ page, iniciarSesion }, info) => {
    test.skip(!info.project.name.startsWith("movil"), "solo movil");
    await conDs3(page);
    await iniciarSesion("restaurantes", "owner");
    await page.locator('.guia-invitacion [data-guia-modo="corto"]').click();
    const tarjeta = page.locator(".guia-tarjeta");
    await expect(tarjeta).toBeVisible();
    await page.waitForTimeout(500);
    const caja = (await tarjeta.boundingBox())!;
    const vista = page.viewportSize()!;
    expect(caja.x).toBeGreaterThanOrEqual(11);
    expect(caja.x + caja.width).toBeLessThanOrEqual(vista.width - 11);
    expect(caja.y + caja.height).toBeLessThanOrEqual(vista.height - 63);
    expect(await seTocan(page)).toBe(false);
    await info.attach("movil-paso-1", { body: await page.screenshot(), contentType: "image/png" });
  });

  test("movimiento reducido: sin viaje automatico, queda «Ir a …»", async ({ page, iniciarSesion }, info) => {
    test.skip(info.project.name.startsWith("movil"), "escritorio basta");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await conDs3(page);
    await iniciarSesion("restaurantes", "owner");
    await page.locator('.guia-invitacion [data-guia-modo="corto"]').click();
    const tarjeta = page.locator(".guia-tarjeta");
    for (let i = 0; i < 4 && !(await tarjeta.locator("h2").innerText()).startsWith("Vamos a"); i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(150);
    }
    await expect(page.locator("[data-guia-cuenta]")).toHaveCount(0);
    await expect(page.locator("[data-guia-manual]")).toHaveText(/^Ir a /);
  });

  test("sin la bandera ds3 la guia no se pinta ni escucha el boton", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.waitForTimeout(800);
    await abrirGuia(page);
    await expect(page.locator(".guia-invitacion, #guia-menu, .guia-tarjeta")).toHaveCount(0);
    expect(await mock.buscar({ ruta: "/v1/onboarding/progreso" })).toHaveLength(0);
  });
});
