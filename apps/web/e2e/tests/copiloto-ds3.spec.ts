// ds3 / «Pregúntale a tus datos» de restaurantes con la bandera encendida, contra la API simulada: temas con su punto de color, pregunta
// desde un tema, respuesta con «Cómo se calculó» en el Drawer (fuente, periodo y alcance que mando el servidor), e historial con la
// anatomia del Drawer sm (420 px a 8 px del borde en escritorio; hoja inferior en movil) con «Chat nuevo», grupos y filas de 40 px.
// Sin la bandera, la pantalla es la de siempre (copiloto-restaurantes.spec.ts sigue pasando sin cambios).
// Capturas opcionales: COPILOTO_CAPTURAS=<carpeta> guarda PNG de portada, respuesta, «Cómo se calculó» e historial («antes» = la
// misma ruta sin la bandera, que no cambia; la genera copiloto-restaurantes.spec.ts o el job capturas-ds3 con etapa «antes»).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil } from "../helpers/navegacion.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const RUTA = `/restaurantes/${restaurantes.orgSlug}/copiloto`;
const TEXTO_RESPUESTA = "En los últimos 7 días vendiste $18,450 MXN en 96 pedidos.";
const CAPTURAS = process.env["COPILOTO_CAPTURAS"];

async function capturar(page: Page, nombre: string, proyecto: string): Promise<void> {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  await page.screenshot({ path: join(CAPTURAS, `${proyecto}-despues-${nombre}.png`) });
}

test.describe("copiloto ds3 de restaurantes @copiloto @ds3", () => {
  test.beforeEach(async ({ page }) => {
    // Bandera del diseno nuevo (la lee /theme-boot.js antes de pintar).
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("atiende-diseno", "ds3");
      } catch {
        // sin almacenamiento: la prueba fallara en la afirmacion de la bandera
      }
    });
  });

  test("portada con temas, respuesta con traza y «Ver cómo lo calculé» en el Drawer e historial en Drawer sm", async ({ page, iniciarSesion, mock, vigilante }, info) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(RUTA);
    await afirmarPantallaSana(page, "copiloto");
    await expect(page.locator("html")).toHaveAttribute("data-diseno", "ds3");
    await expect(page.getByRole("heading", { level: 1, name: "Pregúntale a tus datos" })).toBeVisible();

    // Temas: «Consulta» y los chips sueltos se apagan; los temas se ven con su primer tema activo.
    const temas = page.getByTestId("copiloto-temas");
    await expect(temas).toBeVisible();
    await expect(page.getByRole("button", { name: "Consulta" })).toBeHidden();
    await expect(temas.getByRole("button", { name: "Ventas", exact: true })).toHaveAttribute("aria-pressed", "true");
    await temas.getByRole("button", { name: "Operación", exact: true }).click();
    await expect(temas.getByRole("button", { name: "Operación", exact: true })).toHaveAttribute("aria-pressed", "true");
    const pregunta = "¿Cuántos pedidos tengo por canal este mes?";
    await expect(temas.getByRole("button", { name: pregunta })).toBeVisible();
    // El compositor es de radio 12 (campo grande de la referencia).
    expect(await page.getByRole("form", { name: "Preguntar al Copiloto" }).evaluate((f) => getComputedStyle(f).borderRadius)).toBe("12px");
    await capturar(page, "portada", info.project.name);

    await temas.getByRole("button", { name: pregunta }).click();
    const hilo = page.getByRole("log", { name: "Conversación con el Copiloto" });
    await expect(hilo.getByText(TEXTO_RESPUESTA)).toBeVisible();
    const posts = await mock.buscar({ metodo: "POST", ruta: "/chat-datos" });
    expect(posts).toHaveLength(1);
    await capturar(page, "respuesta", info.project.name);

    // «Cómo se calculó»: Drawer con la evidencia que mando el servidor (no se inventa nada en el cliente).
    // «Cómo llegué a esto»: los pasos que el servidor reporto en vivo (NDJSON), plegados por omision.
    await expect(hilo.getByTestId("copiloto-traza").locator("summary")).toHaveText(/Cómo llegué a esto · 1 paso · /);
    await hilo.getByRole("button", { name: "Ver cómo lo calculé" }).click();
    const calculo = page.getByRole("dialog", { name: /Cómo se calculó: Ventas por día/ });
    await expect(calculo).toBeVisible();
    await expect(calculo.getByText("Pedidos completados")).toBeVisible();
    await expect(calculo.getByText("últimos 7 días")).toBeVisible();
    await expect(calculo.getByText("todas tus sucursales")).toBeVisible();
    await capturar(page, "como-se-calculo", info.project.name);
    await page.keyboard.press("Escape");
    await expect(calculo).toBeHidden();
    await expect(hilo.getByRole("button", { name: "Ver cómo lo calculé" })).toBeFocused();

    // Historial: Drawer sm con cabecera, «Chat nuevo», grupo «Hoy» y filas de 40 px.
    await page.getByRole("button", { name: "Historial de chats" }).click();
    const panel = page.getByRole("dialog", { name: "Historial de chats" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("1 chat guardado en tu cuenta")).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Hoy" })).toBeVisible();
    // «Chat nuevo»: su nombre accesible es su texto visible (WCAG 2.5.3); el dialogo es modal.
    await expect(panel.getByRole("button", { name: "Chat nuevo", exact: true })).toBeVisible();
    await expect(panel).toHaveAttribute("aria-modal", "true");
    await expect(panel.getByText("Se guardan en tu cuenta de Atiende")).toBeVisible();
    const fila = panel.getByRole("button", { name: pregunta, exact: true });
    expect((await fila.boundingBox())?.height).toBe(40);
    const vp = page.viewportSize();
    if (!vp) throw new Error("sin viewport");
    // Se mide cuando termino la entrada (la hoja sube 32 px en 240 ms; el Drawer entra 16 px en 180 ms).
    const caja = async () => {
      const b = await panel.boundingBox();
      if (!b) throw new Error("sin caja del panel");
      return { ancho: Math.round(b.width), alto: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y), abajo: Math.round(b.y + b.height) };
    };
    if (esMovil(page)) {
      // Hoja inferior de 90dvh pegada abajo y a lo ancho.
      await expect.poll(async () => (await caja()).abajo).toBe(vp.height);
      const c = await caja();
      expect(c.ancho).toBe(vp.width);
      expect(Math.abs(c.alto - vp.height * 0.9)).toBeLessThanOrEqual(2);
    } else {
      await expect.poll(async () => vp.width - ((await caja()).x + (await caja()).ancho)).toBe(8);
      const c = await caja();
      expect(c.ancho).toBe(420);
      expect(c.y).toBe(8);
      await expect(page.getByTestId("copiloto-hist-marca")).toBeVisible();
    }
    await capturar(page, "historial", info.project.name);

    // Chat nuevo: vuelve la portada y el panel se cierra; reabrir la conversacion la trae del servidor.
    await panel.getByRole("button", { name: "Chat nuevo", exact: true }).click();
    await expect(page.getByText(TEXTO_RESPUESTA)).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Historial de chats" })).toHaveCount(0);
    await page.getByRole("button", { name: "Historial de chats" }).click();
    await page.getByRole("dialog", { name: "Historial de chats" }).getByRole("button", { name: pregunta, exact: true }).click();
    await expect(page.getByText(TEXTO_RESPUESTA)).toBeVisible();
    vigilante.verificar();
  });

  test("Esc y el velo cierran el historial y el foco vuelve al boton", async ({ page, iniciarSesion }) => {
    await iniciarSesion("restaurantes", "staff");
    await page.goto(RUTA);
    await afirmarPantallaSana(page, "copiloto");
    const boton = page.getByRole("button", { name: "Historial de chats" });
    await boton.click();
    await expect(page.getByRole("dialog", { name: "Historial de chats" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Historial de chats" })).toHaveCount(0);
    await expect(boton).toBeFocused();
    await boton.click();
    await expect(page.getByRole("dialog", { name: "Historial de chats" })).toBeVisible();
    await page.mouse.click(10, 10);
    await expect(page.getByRole("dialog", { name: "Historial de chats" })).toHaveCount(0);
  });
});
