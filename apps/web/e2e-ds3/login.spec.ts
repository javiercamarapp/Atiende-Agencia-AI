// Inicio de sesion = el de Rovaq AI, por omision en las 6 verticales (escritorio y movil de la matriz ds3, claro y oscuro;
// con E2E_DISENO=ds3 se mide ademas con la bandera de diseno encendida).
// Comprueba en el navegador lo que jsdom no ve: la rejilla de dos columnas iguales con el panel oscuro a la IZQUIERDA (radio 24)
// y la esfera de particulas en un canvas real; en movil una sola columna sin canvas; tipografias y medidas de Rovaq (titular
// Fraunces 36, kicker IBM Plex Mono 11, campo de 44 con radio 12, botones en pildora de 48, columna de 470); tema SIEMPRE claro
// aunque el sistema este en oscuro; sin scroll horizontal; y el medidor ds3 (medidas.js: contraste, areas de toque, fuentes)
// sin defectos. Accesibilidad con axe: el repo no trae @axe-core/playwright (agregarlo requiere visto bueno), asi que el
// barrido de axe corre solo si AXE_CORE_JS apunta a un axe.min.js local; sin la variable se omite y lo dice en la salida.
//
// Capturas antes/despues: DS3_CAPTURAS=1 DS3_ETAPA=antes|despues. «antes» = build con VITE_LOGIN_LEGADO=1 (la pantalla
// anterior): solo captura y no afirma nada del login nuevo.
// API simulada de e2e/mock-api, nunca la real.
import { existsSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { VERTICALES } from "../e2e/mock-api/personas.ts";
import { ETAPA, medir, prepararBandera } from "./comun.ts";

const ANTES = ETAPA === "antes";

/**
 * Desviaciones DELIBERADAS de la escala de la app que el login de Rovaq trae (decision del dueno: login identico a Rovaq;
 * AUDITORIA-VEXA-4 §8: «el login no comparte tipografia ni forma con la app»). Viven aqui y no en excepciones.json porque
 * solo valen para esta pantalla y este spec; cualquier otro defecto del medidor sigue fallando.
 */
const DESVIACIONES_ROVAQ: ReadonlyArray<{ readonly tipo: string; readonly el: string; readonly motivo: string }> = [
  { tipo: "radio", el: "div «Atiende ·", motivo: "panel oscuro de radio 24" },
  { tipo: "padding-superficie", el: "Continuar con Google", motivo: "pildora de Rovaq con padding 10/20" },
  { tipo: "padding-superficie", el: "Continuar con correo", motivo: "pildora de Rovaq con padding 10/20" },
  { tipo: "boton-gordo", el: "«ES»", motivo: "selector de idioma de 44 px tambien en escritorio" },
  { tipo: "boton-gordo", el: "«EN»", motivo: "selector de idioma de 44 px tambien en escritorio" },
  { tipo: "gap-fuera-de-escala", el: "span «atiende»", motivo: "separacion simbolo-texto del AtiendeWordmark (logo actual, compartido)" },
  { tipo: "gap-fuera-de-escala", el: "div «Correo»", motivo: "gap interno de FormField (compartido) con etiqueta sr-only" },
];
const esDesviacionRovaq = (linea: string) => DESVIACIONES_ROVAQ.some((d) => linea.includes(`[${d.tipo}]`) && linea.includes(d.el));
const AXE = process.env["AXE_CORE_JS"];

test.beforeEach(async ({ page }) => {
  await prepararBandera(page);
});

async function abrir(page: Page, vertical: string): Promise<void> {
  await page.goto(`/${vertical}/login`);
  await expect(page.locator("main")).toHaveCount(1);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

async function caja(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  expect(b, selector).not.toBeNull();
  return b!;
}

for (const vertical of VERTICALES) {
  test(`login ds3 · ${vertical}`, async ({ page }, info) => {
    await abrir(page, vertical);
    if (ANTES) {
      await medir(page, info, "login", `/${vertical}/login`);
      return;
    }
    const escritorio = (page.viewportSize()?.width ?? 0) >= 1024;
    const main = page.locator("main.login-ds3");
    await expect(main).toBeVisible();

    // Siempre claro (Rovaq): ni la clase `dark` ni color-scheme oscuro, aunque el proyecto emule el sistema en oscuro.
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(false);
    expect(await main.evaluate((el) => getComputedStyle(el).colorScheme)).toBe("light");

    // Orden y metodos de Rovaq.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Bienvenido a atiende ${vertical}`);
    await expect(page.getByRole("button", { name: "Continuar con Google" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Correo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continuar con correo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "¿Olvidaste tu contraseña?" })).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.locator("details.ld3-ayuda summary")).toHaveText("¿Necesitas ayuda para entrar?");
    await expect(page.locator(".ld3-invitacion")).toBeVisible();

    // Tipografia y medidas.
    const h1 = await page.locator("h1").evaluate((el) => ({ familia: getComputedStyle(el).fontFamily, tamano: getComputedStyle(el).fontSize }));
    expect(h1.familia).toContain("Fraunces");
    expect(h1.tamano).toMatch(escritorio ? /^3[2-6]px$/ : /^(28|3[2-6])px$/); // movil bajo: tramo compacto de 28
    const kicker = await page.locator(".ld3-copia .ld3-kicker").evaluate((el) => ({ familia: getComputedStyle(el).fontFamily, tamano: getComputedStyle(el).fontSize }));
    expect(kicker.familia).toContain("IBM Plex Mono");
    expect(kicker.tamano).toBe("11px");
    expect(await main.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Instrument Sans");
    const campo = page.getByRole("textbox", { name: "Correo" });
    expect(Math.round((await campo.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
    expect(await campo.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("12px");
    const cta = page.getByRole("button", { name: "Continuar con correo" });
    expect(Math.round((await cta.boundingBox())!.height)).toBe(48);
    const ctaEstilo = await cta.evaluate((el) => ({ fondo: getComputedStyle(el).backgroundColor, radio: parseFloat(getComputedStyle(el).borderRadius) }));
    expect(ctaEstilo.radio).toBeGreaterThan(100); // pildora
    // Boton en tinta: casi negro (luminancia baja), no el azul.
    const [r, g, b] = ctaEstilo.fondo.match(/\d+/g)!.map(Number);
    expect(Math.max(r!, g!, b!)).toBeLessThan(40);
    expect((await caja(page, ".ld3-copia")).width).toBeLessThanOrEqual(470.5);

    // Sin scroll horizontal.
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth)).toBe(true);

    if (escritorio) {
      // Pantalla de acceso sin scroll vertical en escritorio (regla de Javier del 3-oct).
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0);
      const panel = await caja(page, ".ld3-visual");
      const columna = await caja(page, ".ld3-columna");
      const ancho = page.viewportSize()!.width;
      expect(panel.x).toBeLessThan(columna.x); // panel a la izquierda
      expect(Math.abs(panel.width - columna.width)).toBeLessThanOrEqual(2); // dos columnas iguales
      expect(Math.abs(panel.width + columna.width - ancho)).toBeLessThanOrEqual(2);
      const superficie = page.locator(".ld3-superficie");
      expect(await superficie.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("24px");
      await expect(page.locator(".ld3-visual h2")).toBeVisible();
      const canvas = page.locator(".ld3-visual canvas");
      await expect(canvas).toHaveCount(1);
      expect((await canvas.boundingBox())!.height).toBeGreaterThan(100);
      // La esfera sigue al puntero (o queda quieta con movimiento reducido): el motor marca el modo en el canvas.
      await expect(canvas).toHaveAttribute("data-motion", /^(interactive|reduced)$/);
    } else {
      await expect(page.locator(".ld3-visual")).toBeHidden();
      await expect(page.locator("canvas")).toHaveCount(0);
    }

    const linea = (await medir(page, info, "login", `/${vertical}/login`)).linea.filter((l) => !esDesviacionRovaq(l));
    expect(linea, linea.join("\n")).toEqual([]);

    if (AXE && existsSync(AXE)) {
      await page.addScriptTag({ content: readFileSync(AXE, "utf8") });
      const violaciones = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: Array<{ id: string; nodes: unknown[] }> }> } }).axe;
        const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
        return r.violations.map((v) => `${v.id} (${v.nodes.length})`);
      });
      expect(violaciones, violaciones.join(", ")).toEqual([]);
    } else {
      test.info().annotations.push({ type: "axe", description: "omitido: define AXE_CORE_JS con la ruta a axe.min.js" });
    }
  });
}

test("login ds3 · movimiento reducido: la esfera queda quieta", async ({ page }) => {
  // Solo escritorio con la bandera (en movil no hay canvas, lo cubre la prueba de arriba).
  if (ANTES || (page.viewportSize()?.width ?? 0) < 1024) return;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await abrir(page, "citas");
  await expect(page.locator(".ld3-visual canvas")).toHaveAttribute("data-motion", "reduced");
});
