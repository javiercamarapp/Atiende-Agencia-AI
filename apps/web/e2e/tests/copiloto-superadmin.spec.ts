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
  test("pagina: aparece justo debajo de Resumen, pregunta con un chip y ve la respuesta con su fuente @oscuro", async ({ page, iniciarSesion, mock, vigilante }, info) => {
    await iniciarSesion("superadmin");
    if (!esMovil(page)) {
      // Orden de Javier: «Copiloto» va JUSTO DEBAJO de «Resumen» (primera seccion), no dentro de «Agentes».
      const enlaces = page.locator('aside[aria-label="Navegación principal"] nav a');
      await expect(enlaces.nth(0)).toHaveAttribute("href", "/superadmin");
      await expect(enlaces.nth(1)).toHaveAttribute("href", RUTA);
      await expect(enlaces.nth(1)).toHaveText(/Copiloto/);
    }
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

  test("paridad: portada con CFO y cobranza, con Fijar y Adjuntar; el historial renombra y borra chats reales", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("superadmin");
    await page.goto(RUTA);
    await afirmarPantallaSana(page, "copiloto");
    // Portada: «Consulta» abre las tres tarjetas de preguntas por categoria; los chips CFO / cobranza ya estan a la vista.
    await page.getByRole("button", { name: "Consulta", exact: true }).click();
    for (const titulo of ["CFO y cobranza", "Ventas y costos de IA", "Clientes, agentes y salud", "Varias organizaciones", "Actividad por negocio"]) await expect(page.getByText(titulo, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "¿Cuál es mi MRR por vertical?" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "¿Qué clientes tienen el pago pendiente?" }).first()).toBeVisible();

    await page.getByRole("button", { name: CHIP }).first().click();
    await expect(page.getByText(TEXTO)).toBeVisible();
    // Copiar, CSV y Fijar existen (el servidor declara `fijados`); Fijar es un POST real a /pins con conversacion + posicion + bloque.
    await expect(page.getByRole("button", { name: "Copiar respuesta" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Descargar CSV" })).toBeVisible();
    await page.getByRole("button", { name: /Fijar/ }).first().click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: /\/superadmin\/copiloto\/pins$/ })).length).toBe(1);
    const fijado = await mock.buscar({ metodo: "POST", ruta: /\/superadmin\/copiloto\/pins$/ });
    expect(fijado[0]?.cuerpo).toMatchObject({ bloque: 0 });

    // Adjuntar archivo: el clip sube el CSV a /adjuntos (base64) y el perfil se pinta en el chat; no pasa por el modelo.
    await page.locator('[data-testid="copiloto-adjunto-input"]').setInputFiles({ name: "ventas.csv", mimeType: "text/csv", buffer: Buffer.from("producto,unidades\nTaco,10\nTorta,5\n") });
    await expect(page.getByText(/«ventas\.csv» tiene 2 filas de datos/)).toBeVisible();
    const subida = await mock.buscar({ metodo: "POST", ruta: /\/superadmin\/copiloto\/adjuntos$/ });
    expect(subida).toHaveLength(1);
    expect(subida[0]?.cuerpo).toEqual({ nombre: "ventas.csv", contenidoBase64: Buffer.from("producto,unidades\nTaco,10\nTorta,5\n").toString("base64") });

    await page.getByRole("button", { name: "Historial de chats" }).click();
    const historial = page.getByRole("dialog", { name: "Historial de chats" });
    await historial.getByRole("button", { name: `Renombrar ${CHIP}` }).click();
    await historial.getByRole("textbox", { name: "Nuevo nombre del chat" }).fill("Organizaciones por estado");
    await page.keyboard.press("Enter");
    await expect(historial.getByRole("button", { name: "Organizaciones por estado", exact: true })).toBeVisible();
    const patch = await mock.buscar({ metodo: "PATCH", ruta: /\/superadmin\/copiloto\/conversaciones\/[0-9a-f-]+$/ });
    expect(patch).toHaveLength(1);
    expect(patch[0]?.cuerpo).toEqual({ titulo: "Organizaciones por estado" });

    await historial.getByRole("button", { name: "Borrar Organizaciones por estado" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Borrar" }).click();
    await expect(historial.getByRole("button", { name: "Organizaciones por estado", exact: true })).toHaveCount(0);
    expect(await mock.buscar({ metodo: "DELETE", ruta: /\/superadmin\/copiloto\/conversaciones\/[0-9a-f-]+$/ })).toHaveLength(1);
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
