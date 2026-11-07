// Login de las 6 verticales = el de Rovaq AI (decision del dueno, 6-nov), por omision y sin bandera. Corre en los 4 proyectos
// (escritorio/movil, claro/oscuro: @oscuro) contra la API simulada. Comprueba lo que jsdom no ve: en escritorio, dos columnas
// iguales con el panel oscuro a la IZQUIERDA (radio 24, a 12 px del borde) y la esfera de particulas en un canvas real; en
// movil, una columna sin canvas; Fraunces/Instrument Sans/IBM Plex Mono; campo de 44 con radio 12; pildoras de 48 con el
// boton de correo en tinta; columna de 470; ES/EN; SOLO enlace por correo y Google (sin contrasena); tema SIEMPRE claro.
// El medidor ds3 y axe viven en e2e-ds3/login.spec.ts (verificacion visual, con capturas).
import type { Page } from "@playwright/test";
import { VERTICALES } from "../mock-api/personas.ts";
import { expect, test } from "../helpers/fixtures.ts";

async function abrir(page: Page, ruta: string): Promise<void> {
  await page.goto(ruta);
  await expect(page.locator("main.login-ds3")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

const estilo = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const c = getComputedStyle(el);
    return { familia: c.fontFamily, tamano: c.fontSize, fondo: c.backgroundColor, radio: c.borderTopLeftRadius, colorScheme: c.colorScheme };
  });

for (const v of VERTICALES) {
  test(`@oscuro login de ${v} identico a Rovaq (solo cambia la paleta)`, async ({ page, vigilante }) => {
    await abrir(page, `/${v}/login`);
    const escritorio = (page.viewportSize()?.width ?? 0) >= 1024;

    // Siempre claro, aunque el proyecto emule el sistema en oscuro.
    await expect(page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/);
    expect((await estilo(page, "main.login-ds3")).colorScheme).toBe("light");

    // Orden y piezas de Rovaq; solo enlace por correo y Google.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`atiende ${v}`);
    await expect(page.getByRole("navigation", { name: "Idioma" }).getByRole("button")).toHaveText(["ES", "EN"]);
    await expect(page.getByRole("button", { name: "Continuar con Google" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Correo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continuar con correo" })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "¿Olvidaste tu contraseña?" })).toHaveCount(0);
    await expect(page.locator("details.ld3-ayuda summary")).toHaveText("¿Necesitas ayuda para entrar?");

    // Tipografias y medidas.
    expect((await estilo(page, "h1")).familia).toContain("Fraunces");
    expect((await estilo(page, ".ld3-copia .ld3-kicker")).familia).toContain("IBM Plex Mono");
    expect((await estilo(page, ".ld3-copia .ld3-kicker")).tamano).toBe("11px");
    expect((await estilo(page, "main.login-ds3")).familia).toContain("Instrument Sans");
    const campo = page.getByRole("textbox", { name: "Correo" });
    expect(Math.round((await campo.boundingBox())!.height)).toBe(44);
    expect((await estilo(page, ".login-campo")).radio).toBe("12px");
    for (const nombre of ["Continuar con correo", "Continuar con Google"]) {
      expect(Math.round((await page.getByRole("button", { name: nombre }).boundingBox())!.height), nombre).toBe(48);
    }
    const cta = await estilo(page, "form button[type=submit]");
    expect(parseFloat(cta.radio)).toBeGreaterThan(100);
    expect(Math.max(...cta.fondo.match(/\d+/g)!.slice(0, 3).map(Number)), "boton de correo en tinta (casi negro)").toBeLessThan(40);
    expect((await page.locator(".ld3-copia").boundingBox())!.width).toBeLessThanOrEqual(470.5);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth)).toBe(true);

    if (escritorio) {
      const panel = (await page.locator(".ld3-visual").boundingBox())!;
      const columna = (await page.locator(".ld3-columna").boundingBox())!;
      expect(panel.x).toBe(0);
      expect(panel.x).toBeLessThan(columna.x);
      expect(Math.abs(panel.width - columna.width)).toBeLessThanOrEqual(2);
      const superficie = (await page.locator(".ld3-superficie").boundingBox())!;
      expect(Math.round(superficie.x)).toBe(12);
      expect(Math.round(superficie.y)).toBe(12);
      expect((await estilo(page, ".ld3-superficie")).radio).toBe("24px");
      expect((await estilo(page, "h1")).tamano).toMatch(/^3[2-6]px$/);
      await expect(page.locator(".ld3-visual h2")).toBeVisible();
      await expect(page.locator(".ld3-visual canvas")).toHaveAttribute("data-motion", /^(interactive|reduced)$/);
    } else {
      await expect(page.locator(".ld3-visual")).toBeHidden();
      await expect(page.locator("canvas")).toHaveCount(0);
    }
    vigilante.verificar();
  });
}

test("login en ingles: copy del formulario y del panel", async ({ page }) => {
  await abrir(page, "/hoteles/login?lang=en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome to atiende hotels");
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("lang", "en");
});
