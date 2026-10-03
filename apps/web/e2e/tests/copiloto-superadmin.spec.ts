// CHAT-17: Copiloto de PLATAFORMA (superadmin) de punta a punta contra la API simulada: pagina /superadmin/copiloto, panel lateral Cmd+J que NO se desmonta al
// navegar, historial de conversaciones y tarjeta de accion propuesta (Cancelar y Escape sin NINGUNA confirmacion; Confirmar con motivo hace UN POST). Las respuestas salen
// de la fixture NDJSON de e2e/mock-api (jamas de la SPA). Los casos @oscuro corren ademas en los proyectos oscuros (escritorio y movil).
import { expect, test } from "../helpers/fixtures.ts";
import type { Locator, Page } from "@playwright/test";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil, irASeccion } from "../helpers/navegacion.ts";

const RUTA = "/superadmin/copiloto";
const CHIP = "¿Cuántas organizaciones tengo por estado?";
const TEXTO = "Hay 6 organizaciones, 5 activas.";
const PEDIDO_ACCION = "apaga el agente de whatsapp de restaurantes";
const MOTIVO = "Costos fuera de control en este agente";
const panel = (page: Page) => page.locator("#copiloto-panel");

async function abrirPanel(page: Page): Promise<void> {
  if (esMovil(page)) {
    await page.getByRole("button", { name: "Abrir menú de cuenta" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /Chatea con tus datos/ }).click();
  } else {
    await page.keyboard.press("ControlOrMeta+j");
  }
  await expect(panel(page)).toHaveAttribute("data-abierto", "true");
}

async function pedirAccion(donde: Locator | Page): Promise<void> {
  await donde.getByRole("textbox").fill(PEDIDO_ACCION);
  await donde.getByRole("button", { name: "Enviar" }).click();
  await expect(donde.getByTestId("copiloto-tarjeta-accion")).toBeVisible();
  await expect(donde.getByTestId("copiloto-tarjeta-accion")).toHaveAttribute("data-fase", "pendiente");
}

test.describe("copiloto de superadmin @copiloto", () => {
  test("pagina: aparece primera en Agentes, pregunta con un chip y ve la respuesta con su fuente @oscuro", async ({ page, iniciarSesion, mock, vigilante }, info) => {
    await iniciarSesion("superadmin");
    await irASeccion(page, { texto: "Copiloto", href: RUTA });
    await expect(page).toHaveURL(new RegExp(`${RUTA}$`));
    await afirmarPantallaSana(page, "copiloto");
    await expect(page.getByRole("heading", { level: 1, name: "Pregunta a tus datos" })).toBeVisible();
    if (!esMovil(page)) await expect(page.getByTestId("barra-pagina-titulo")).toHaveText("Copiloto");
    await expect(page.getByText("Toda la plataforma").first()).toBeVisible();

    await page.getByRole("button", { name: CHIP }).click();
    const hilo = page.getByRole("log", { name: "Conversación con el Copiloto" });
    await expect(hilo.getByText(TEXTO)).toBeVisible();
    await expect(hilo.getByRole("link", { name: /Organizaciones de la plataforma/ })).toHaveAttribute("href", "/superadmin/organizaciones");

    const posts = await mock.buscar({ metodo: "POST", ruta: "/superadmin/copiloto" });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.cuerpo).toEqual({ tool: "organizaciones", label: CHIP, conversationId: "new" });

    if (info.project.name.endsWith("oscuro")) await afirmarModo(page, "oscuro");
    await afirmarSinScrollHorizontal(page);
    await page.screenshot({ path: info.outputPath(`copiloto-pagina-${info.project.name}.png`), fullPage: false });
    vigilante.verificar();
  });

  test("Cmd+J abre el panel, su conversacion sobrevive al navegar y Esc lo cierra @oscuro", async ({ page, iniciarSesion, mock, vigilante }, info) => {
    await iniciarSesion("superadmin");
    await expect(panel(page)).toHaveAttribute("data-abierto", "false");
    await expect(panel(page)).toHaveAttribute("inert", "");
    await abrirPanel(page);
    await expect(panel(page)).not.toHaveAttribute("inert", "");
    if (!esMovil(page)) await expect.poll(async () => (await panel(page).boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(399);

    await panel(page).getByRole("button", { name: CHIP }).click();
    await expect(panel(page).getByText(TEXTO)).toBeVisible();
    await page.screenshot({ path: info.outputPath(`copiloto-panel-${info.project.name}.png`) });

    if (!esMovil(page)) {
      // Navegar con el menu (cliente, sin recargar): el panel sigue abierto y con la MISMA conversacion; no hubo otro POST ni otra consulta de estado.
      await irASeccion(page, { texto: "Salud operativa", href: "/superadmin/salud" });
      await expect(page).toHaveURL(/\/superadmin\/salud$/);
      await expect(panel(page).getByText(TEXTO)).toBeVisible();
      await expect(panel(page)).toHaveAttribute("data-abierto", "true");
    }

    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveAttribute("data-abierto", "false");
    await expect(panel(page)).toHaveAttribute("inert", "");
    await abrirPanel(page);
    await expect(panel(page).getByText(TEXTO)).toBeVisible();

    expect(await mock.buscar({ metodo: "POST", ruta: "/superadmin/copiloto" })).toHaveLength(1);
    expect(await mock.buscar({ metodo: "GET", ruta: "/superadmin/copiloto/estado" })).toHaveLength(1);
    vigilante.verificar();
  });

  test("'Abrir en página completa' lleva la conversacion a la pagina", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("superadmin");
    await abrirPanel(page);
    await panel(page).getByRole("button", { name: CHIP }).click();
    await expect(panel(page).getByText(TEXTO)).toBeVisible();
    await panel(page).getByRole("link", { name: "Abrir en página completa" }).click();
    await expect(page).toHaveURL(new RegExp(`${RUTA}\\?c=`));
    // El panel sigue montado (cerrado e inert) en la pagina completa: se acota el hilo a la pagina.
    await expect(page.locator("main").getByRole("log", { name: "Conversación con el Copiloto" }).getByText(TEXTO)).toBeVisible();
    vigilante.verificar();
  });

  test("historial: lista la conversacion guardada, empieza un chat nuevo y la reabre", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("superadmin");
    await page.goto(RUTA);
    await afirmarPantallaSana(page, "copiloto");
    await page.getByRole("button", { name: CHIP }).click();
    await expect(page.getByText(TEXTO)).toBeVisible();

    await page.getByRole("button", { name: "Historial de chats" }).click();
    const historial = page.getByRole("dialog", { name: "Historial de chats" });
    await expect(historial.getByRole("button", { name: CHIP, exact: true })).toBeVisible();
    await historial.getByRole("button", { name: "Nuevo chat" }).click();
    await expect(page.getByText(TEXTO)).toHaveCount(0);

    await page.getByRole("button", { name: "Historial de chats" }).click();
    await page.getByRole("dialog", { name: "Historial de chats" }).getByRole("button", { name: CHIP, exact: true }).click();
    await expect(page.getByText(TEXTO)).toBeVisible();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: /\/superadmin\/copiloto\/conversaciones\/[0-9a-f-]+$/ })).length).toBeGreaterThan(0);
    vigilante.verificar();
  });

  test("accion propuesta: Cancelar y Escape NO confirman nada (cero POST de confirmacion)", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("superadmin");
    await abrirPanel(page);
    await pedirAccion(panel(page));
    const tarjeta = panel(page).getByTestId("copiloto-tarjeta-accion");
    await expect(tarjeta.getByText(/Apagar el agente restaurantes:whatsapp_agent/)).toBeVisible();
    await expect(tarjeta.getByRole("button", { name: "Confirmar" })).toBeDisabled(); // sin motivo no se puede confirmar

    await tarjeta.getByRole("textbox").fill(MOTIVO);
    await page.keyboard.press("Escape"); // Esc cierra el panel; no confirma
    await expect(panel(page)).toHaveAttribute("data-abierto", "false");
    await abrirPanel(page);
    await panel(page).getByTestId("copiloto-tarjeta-accion").getByRole("button", { name: "Cancelar" }).click();
    await expect(panel(page).getByTestId("copiloto-tarjeta-accion")).toHaveAttribute("data-fase", "cancelada");

    expect(await mock.buscar({ metodo: "POST", ruta: "/superadmin/copiloto/acciones/confirmar" })).toHaveLength(0);
    expect(await mock.escrituras()).not.toContainEqual(expect.objectContaining({ ruta: expect.stringContaining("/acciones/") }));
    vigilante.verificar();
  });

  test("accion propuesta: Confirmar con motivo hace UN POST y la tarjeta queda ejecutada; la tarjeta enlaza a Acciones", async ({ page, iniciarSesion, mock, vigilante }, info) => {
    await iniciarSesion("superadmin");
    await abrirPanel(page);
    await pedirAccion(panel(page));
    const tarjeta = panel(page).getByTestId("copiloto-tarjeta-accion");
    await expect(tarjeta.getByRole("link", { name: /Ver pendientes en Acciones/ })).toHaveAttribute("href", "/superadmin/acciones");
    await tarjeta.getByRole("textbox").fill(MOTIVO);
    await page.screenshot({ path: info.outputPath(`copiloto-tarjeta-${info.project.name}.png`) });
    await tarjeta.getByRole("button", { name: "Confirmar" }).click();
    await expect(tarjeta).toHaveAttribute("data-fase", "ejecutada");

    const posts = await mock.buscar({ metodo: "POST", ruta: "/superadmin/copiloto/acciones/confirmar" });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.cuerpo).toEqual({ propuesta: "bcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrst", agente: "restaurantes:whatsapp_agent", motivo: MOTIVO });
    vigilante.verificar();
  });

  test("al reabrir la conversacion, la propuesta ya ejecutada no se puede volver a confirmar (un solo uso)", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("superadmin");
    await page.goto(RUTA);
    await pedirAccion(page);
    await page.getByTestId("copiloto-tarjeta-accion").getByRole("textbox").fill(MOTIVO);
    await page.getByTestId("copiloto-tarjeta-accion").getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByTestId("copiloto-tarjeta-accion")).toHaveAttribute("data-fase", "ejecutada");

    await page.getByRole("button", { name: "Historial de chats" }).click();
    await page.getByRole("dialog", { name: "Historial de chats" }).getByRole("button", { name: "Nuevo chat" }).click();
    await page.getByRole("button", { name: "Historial de chats" }).click();
    await page.getByRole("dialog", { name: "Historial de chats" }).getByRole("button", { name: PEDIDO_ACCION, exact: true }).click();
    await expect(page.getByTestId("copiloto-tarjeta-accion")).toHaveAttribute("data-fase", "ejecutada");
    await expect(page.getByTestId("copiloto-tarjeta-accion").getByRole("button", { name: "Confirmar" })).toHaveCount(0);
    expect(await mock.buscar({ metodo: "POST", ruta: "/superadmin/copiloto/acciones/confirmar" })).toHaveLength(1);
    vigilante.verificar();
  });
});
