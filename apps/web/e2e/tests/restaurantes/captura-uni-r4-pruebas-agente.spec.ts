// UNI-R4 -- pruebas del agente (chat de WhatsApp de demostracion y vista previa de la llamada) de punta a punta con la API simulada y una llamada
// simulada (WebSocket de Gemini y microfono falsos): botones y composicion, errores honestos, que NO se escriba nada y capturas (claro, oscuro, movil
// 375 px). Los PNG solo se escriben si CAPTURAS_R4_DIR apunta a una carpeta (asi CI no genera nada). Se corre con Chrome (H.264 del video del orbe).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { afirmarModo, afirmarSinScrollHorizontal } from "../../helpers/ds.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { ARGUMENTOS_MICROFONO_FALSO, simularLlamada } from "../../helpers/llamada-simulada.ts";
import { BASE } from "../../helpers/recorrido.ts";

test.use({ channel: "chrome", launchOptions: { args: [...ARGUMENTOS_MICROFONO_FALSO] }, permissions: ["microphone"] });

const main = (page: Page) => page.locator("main#contenido-principal");
const chat = (page: Page) => page.getByRole("dialog", { name: /Chat de prueba con el agente de WhatsApp/ });

async function foto(page: Page, nombre: string, proyecto: string): Promise<void> {
  const destino = process.env["CAPTURAS_R4_DIR"];
  if (!destino) return;
  mkdirSync(destino, { recursive: true });
  await page.waitForTimeout(600); // deja terminar las animaciones de entrada
  await page.screenshot({ path: join(destino, `${nombre}-${proyecto}.png`) });
}

test.describe("UNI-R4 pruebas del agente @recorrido @oscuro", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("Agente de WhatsApp: boton flotante «Iniciar chat», chat con pedido simulado PRUEBA y sin escrituras", async ({ page, mock, vigilante }, info) => {
    await page.goto(`${BASE}/agente-whatsapp`);
    const iniciar = page.getByRole("button", { name: /Iniciar chat/ });
    await expect(iniciar).toBeVisible();
    await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
    await foto(page, "whatsapp-pagina", info.project.name);

    await mock.limpiarRegistro();
    await iniciar.click();
    await expect(chat(page)).toBeVisible();
    await expect(iniciar).toBeHidden();
    const campo = chat(page).getByLabel("Mensaje de prueba");
    await expect(campo).toBeFocused();
    await expect(chat(page)).toContainText("no se crean pedidos ni se avisa a nadie");
    await campo.fill("hola, buenas tardes");
    await campo.press("Enter");
    await expect(chat(page).getByText("bienvenido a Taquería El Faro")).toBeVisible();
    await campo.fill("quiero 3 tacos al pastor y una horchata");
    await campo.press("Enter");
    await expect(chat(page).getByText("Pedido simulado · PRUEBA-AB12 · Prueba", { exact: true })).toBeVisible();
    await expect(chat(page).getByTestId("tarjeta-pedido-simulado")).toContainText("$183.00");
    await expect(chat(page).locator(".wa-burbuja--cliente")).toHaveCount(2);
    await expect(chat(page).locator(".wa-burbuja--cliente").first()).toContainText(/\d{2}:\d{2}/);

    // Mensaje de prueba: solo POST al preview, ninguna escritura real (ni pedidos ni avisos).
    const escrituras = await mock.escrituras();
    expect(escrituras.filter((e) => !/\/agente-whatsapp\/preview\/mensaje$/.test(e.ruta))).toEqual([]);
    expect(escrituras.length).toBe(2);
    await afirmarSinScrollHorizontal(page);
    await foto(page, "whatsapp-chat", info.project.name);

    // Reiniciar desde el encabezado vacia la conversacion; Escape cierra y devuelve el foco al boton flotante.
    await chat(page).getByRole("button", { name: "Reiniciar conversación" }).click();
    await expect(chat(page).locator(".wa-burbuja--cliente")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(chat(page)).toBeHidden();
    await expect(iniciar).toBeFocused();
    vigilante.verificar();
  });

  test("Agente de WhatsApp: un 503 del servidor se dice tal cual dentro del chat y no se inventa respuesta", async ({ page, mock }) => {
    await page.goto(`${BASE}/agente-whatsapp`);
    await mock.inyectarFalla({ metodo: "POST", ruta: "/agente-whatsapp/preview/mensaje", status: 503, cuerpo: { code: "agente_no_disponible", message: "No disponible: requiere OPENROUTER_API_KEY. Sin un proveedor de IA configurado el agente no puede responder." } });
    await page.getByRole("button", { name: /Iniciar chat/ }).click();
    const campo = chat(page).getByLabel("Mensaje de prueba");
    await campo.fill("hola");
    await campo.press("Enter");
    await expect(chat(page).getByRole("alert")).toContainText("requiere OPENROUTER_API_KEY");
    await expect(chat(page).locator(".wa-burbuja--agente:not(.wa-burbuja--error)")).toHaveCount(0);
    await expect(campo).toHaveValue("hola");
  });

  test("Configuracion: el chat de prueba ofrece Simular cliente y «Probar con los cambios sin guardar» dentro del encabezado", async ({ page }) => {
    await page.goto(`${BASE}/configuracion`);
    await page.getByRole("button", { name: /Iniciar chat/ }).click();
    await chat(page).getByRole("button", { name: "Opciones de prueba" }).click();
    await expect(chat(page).getByLabel("Simular cliente")).toBeVisible();
    await expect(chat(page).getByLabel("Probar con los cambios sin guardar")).toBeVisible();
  });

  test("Agente de voz: el globo flotante «Iniciar llamada» abre la vista previa", async ({ page }) => {
    await page.goto(`${BASE}/agente-voz`);
    await page.getByTestId("globo-llamada").click();
    await expect(page.getByRole("dialog", { name: /Vista previa de llamada/ })).toBeVisible();
  });

  test("Agente de voz: «Vista previa» arriba a la derecha, orbe, chip «● Llamada en curso» y boton que pasa a «Terminar llamada»", async ({ page, mock, vigilante }, info) => {
    await simularLlamada(page);
    await page.goto(`${BASE}/agente-voz`);
    // «Vista previa» va dentro de la barra superior de la página (escritorio) y en el encabezado de la página en móvil.
    const abrir = page.getByRole("button", { name: "Vista previa", exact: true }).locator("visible=true").first();
    await expect(abrir).toBeVisible();
    if (!info.project.name.startsWith("movil")) await expect(page.getByTestId("barra-pagina").getByRole("button", { name: "Vista previa" })).toBeVisible();
    await expect(page.getByTestId("globo-llamada")).toBeVisible();
    await foto(page, "voz-pagina", info.project.name);
    await foto(page, "voz-globo", info.project.name);
    await abrir.click();
    const vista = page.getByRole("dialog", { name: /Vista previa de llamada/ });
    await expect(vista).toBeVisible();
    await expect(page.getByTestId("globo-llamada")).toBeHidden();
    // En escritorio la vista previa cubre tambien la barra superior (como el original).
    if (!info.project.name.startsWith("movil")) {
      const caja = await vista.boundingBox();
      const barra = await page.getByTestId("barra-pagina").boundingBox();
      expect(caja!.y).toBeLessThanOrEqual(barra!.y + 1);
    }
    await expect(vista.getByTestId("chip-estado")).toHaveText("Vista previa");
    await expect(vista).toContainText("Aún no hay una llamada activa");
    await expect(vista).toContainText("Sucursal Centro");
    await foto(page, "voz-inactiva", info.project.name);

    await mock.limpiarRegistro();
    await vista.getByRole("button", { name: "Iniciar llamada de prueba" }).last().click();
    await expect(vista.getByTestId("chip-estado")).toHaveText("● Llamada en curso", { timeout: 15_000 });
    const terminar = vista.getByRole("button", { name: "Terminar llamada" }).last();
    await expect(terminar).toBeVisible();
    await expect(terminar).toHaveClass(/bg-destructive/);
    await expect(vista).toContainText("Quiero tres tacos al pastor para recoger.");
    await afirmarSinScrollHorizontal(page);
    await foto(page, "voz-activa", info.project.name);

    await terminar.click();
    await expect(vista.getByTestId("chip-estado")).toHaveText("Vista previa");
    await page.keyboard.press("Escape");
    await expect(vista).toBeHidden();
    // La llamada de prueba solo emite la sesion efimera (POST); nada mas se escribe.
    const escrituras = await mock.escrituras();
    expect(escrituras.length).toBeGreaterThan(0);
    expect(escrituras.every((e) => /\/voz\/preview\//.test(e.ruta))).toBe(true);
    vigilante.verificar();
  });
});
