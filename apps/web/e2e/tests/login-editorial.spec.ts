import { expect, test } from "../helpers/fixtures.ts";

// These tests inspect the decorative canvas and auth geometry only. The API is
// the local fixture server; no production account or provider is contacted.
test("la animación responde al cursor y respeta movimiento reducido sin controles", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/restaurantes/login");
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

test("el panel editorial no descarga fotografías ni ocupa espacio en móvil", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const images: string[] = [];
  page.on("request", (request) => { if (request.url().includes("login-hero-")) images.push(request.url()); });
  await page.goto("/hoteles/login");
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".login-story-panel")).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Tu correo" })).toBeVisible();
  expect(images).toEqual([]);
  const bounds = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, vw: innerWidth, vh: innerHeight }));
  expect(bounds.width).toBeLessThanOrEqual(bounds.vw);
  expect(bounds.height).toBeLessThanOrEqual(bounds.vh);
});

test("las seis verticales separan el texto de la geometría en escritorio compacto", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const vertical of ["restaurantes", "hoteles", "rentas", "despachos", "licitaciones", "citas"]) {
    await page.goto(`/${vertical}/login`);
    await page.waitForLoadState("networkidle");
    const copy = await page.locator(".login-story-copy").boundingBox();
    const art = await page.locator("canvas").boundingBox();
    expect(copy).not.toBeNull();
    expect(art).not.toBeNull();
    expect(art!.y, vertical).toBeGreaterThanOrEqual(copy!.y + copy!.height);
    expect(art!.height, vertical).toBeGreaterThan(100);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(720);
  }
});


test("idiomas cambian el acceso y la recuperación sin perder el correo", async ({ page }) => {
  await page.goto("/restaurantes/login");
  await page.getByRole("textbox", { name: "Tu correo", exact: true }).fill("persona@example.test");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Welcome to atiende restaurants");
  await expect(page.getByRole("textbox", { name: "Your email", exact: true })).toHaveValue("persona@example.test");
  await expect(page.locator(".login-story-steps")).toHaveCount(0);
  await page.getByRole("button", { name: "Forgot your password?", exact: true }).click();
  await expect(page.getByText("Reset your password", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to sign in", exact: true }).click();
  await page.getByRole("button", { name: "Español", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Bienvenido a atiende restaurantes");
});
