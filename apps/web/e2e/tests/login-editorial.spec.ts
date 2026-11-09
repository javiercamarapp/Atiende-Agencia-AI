import { expect, test } from "../helpers/fixtures.ts";

// These tests inspect the decorative canvas and auth geometry only. The API is
// the local fixture server; no production account or provider is contacted.
test("la animación responde al cursor y respeta movimiento reducido sin controles", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/hoteles/login");
  await page.waitForLoadState("networkidle");
  const canvas = page.locator("canvas");
  const pixels = () => canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL());
  await expect(canvas).toHaveAttribute("data-motion", "reduced");
  const still = await pixels();
  await page.waitForTimeout(160);
  expect(await pixels()).toBe(still);
  await expect(page.getByRole("button", { name: /Pausar animación|Reanudar animación/ })).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(canvas).toHaveAttribute("data-motion", "interactive");
  const form = await page.locator("form").boundingBox();
  await canvas.hover({ position: { x: 100, y: 100 } });
  await expect.poll(pixels).not.toBe(still);
  expect(await page.locator("form").boundingBox()).toEqual(form);
  const button = page.getByRole("button", { name: "Continuar con correo" });
  const before = await button.boundingBox();
  await button.hover();
  await page.waitForTimeout(250);
  expect(await button.boundingBox()).toEqual(before);
});

// Desde el 6-nov el login de las 6 verticales es el de Rovaq (VerticalLoginDs3): panel oscuro con la esfera de particulas
// a la izquierda en escritorio, tambien en restaurantes (ya sin la lamina con foto, que queda solo en la pantalla anterior,
// interruptor de emergencia VITE_DISENO_LEGADO=1). Las pruebas de abajo cubren lo mismo que cubrian para el panel editorial.
test("el panel no descarga fotografías ni ocupa espacio en móvil", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const images: string[] = [];
  page.on("request", (request) => { if (request.url().includes("login-hero-")) images.push(request.url()); });
  for (const vertical of ["hoteles", "restaurantes"]) {
    await page.goto(`/${vertical}/login`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".ld3-visual")).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Correo", exact: true })).toBeVisible();
    const bounds = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, vw: innerWidth, vh: innerHeight }));
    expect(bounds.width).toBeLessThanOrEqual(bounds.vw);
    expect(bounds.height).toBeLessThanOrEqual(bounds.vh);
  }
  expect(images).toEqual([]);
});

test("las 6 verticales separan el texto del panel de la esfera en escritorio compacto, sin scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const vertical of ["restaurantes", "hoteles", "rentas", "despachos", "licitaciones", "citas"]) {
    await page.goto(`/${vertical}/login`);
    await page.waitForLoadState("networkidle");
    const copy = await page.locator(".ld3-panel-copia").boundingBox();
    const art = await page.locator("canvas").boundingBox();
    expect(copy).not.toBeNull();
    expect(art).not.toBeNull();
    expect(art!.y, vertical).toBeGreaterThanOrEqual(copy!.y + copy!.height);
    expect(art!.height, vertical).toBeGreaterThan(100);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(720);
  }
});

test("idiomas cambian el acceso sin perder el correo", async ({ page }) => {
  await page.goto("/restaurantes/login");
  await page.getByRole("textbox", { name: "Correo", exact: true }).fill("persona@example.test");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Welcome to atiende restaurants");
  await expect(page.getByRole("textbox", { name: "Email", exact: true })).toHaveValue("persona@example.test");
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  await page.getByRole("button", { name: "Español", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Bienvenido a atiende restaurantes");
  await expect(page.getByRole("textbox", { name: "Correo", exact: true })).toHaveValue("persona@example.test");
});

test("restaurantes usa el panel de Rovaq como las demás verticales y conserva su placeholder y su pie", async ({ page }) => {
  const fotos: string[] = [];
  page.on("request", (r) => { if (r.url().includes("login-hero-")) fotos.push(r.url()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/restaurantes/login");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bienvenido a atiende restaurantes");
  await expect(page.locator(".login-lamina")).toHaveCount(0);
  await expect(page.locator(".ld3-visual canvas")).toHaveCount(1);
  await expect(page.locator(".ld3-visual h2")).toHaveText("Cada pedido. Toda tu operación.");
  await expect(page.getByRole("textbox", { name: "Correo", exact: true })).toHaveAttribute("placeholder", "tu@correo.com");
  await expect(page.getByText("Pídele a tu restaurante que te dé de alta.")).toBeVisible();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator(".ld3-visual h2")).toHaveText("Every order. Your whole operation.");
  expect(fotos).toEqual([]);
});
