// CHAT-13: Copiloto ("Pregunta a tus datos") de citas de punta a punta contra la API simulada: abre la pagina desde el
// Sidebar, pregunta con un chip, ve los pasos y la respuesta (NDJSON real) con su tabla/grafica y su fuente, y reabre la conversacion
// desde el historial. La respuesta sale de la fixture NDJSON de e2e/mock-api (jamas de la SPA).
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { abrirMasMovil, esMovil, sidebar } from "../helpers/navegacion.ts";
import { citas } from "../mock-api/fixtures/citas.ts";

const RUTA = `/citas/${citas.orgSlug}/copiloto`;
const PREGUNTA = "¿Cuántas citas tengo esta semana?";
const TEXTO_RESPUESTA = "Esta semana tienes 24 citas (18 completadas, 4 por atender, 2 canceladas).";

test.describe("copiloto de citas @copiloto", () => {
  test("owner: abre el Copiloto desde el menu, pregunta con un chip y ve la respuesta con su fuente @oscuro", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    if (esMovil(page)) {
      const hoja = await abrirMasMovil(page);
      await hoja.getByRole("link", { name: "Copiloto" }).click();
    } else {
      await sidebar(page).getByRole("link", { name: "Copiloto", exact: true }).click();
    }
    await expect(page).toHaveURL(new RegExp(`${RUTA}$`));
    await afirmarPantallaSana(page, "copiloto");
    await expect(page.getByRole("heading", { level: 1, name: "Pregunta a tus datos" })).toBeVisible();
    await expect(page.getByRole("button", { name: PREGUNTA })).toBeVisible();

    await page.getByRole("button", { name: PREGUNTA }).click();
    const hilo = page.getByRole("log", { name: "Conversación con el Copiloto" });
    await expect(hilo.getByText(TEXTO_RESPUESTA)).toBeVisible();
    // La tabla del bloque y la fuente (enlace interno a la pantalla de origen).
    await expect(hilo.getByText("Citas por día").first()).toBeVisible();
    await expect(hilo.getByRole("link", { name: /Citas de la agenda/ })).toHaveAttribute("href", `/citas/${citas.orgSlug}/agenda`);

    // El POST fue NDJSON, con SOLO pregunta + conversationId "new" (sin ids de negocio ni organizacion).
    const posts = await mock.buscar({ metodo: "POST", ruta: /\/chat-datos$/ });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.cuerpo).toEqual({ tool: "citas_por_dia", args: { periodo: "esta_semana" }, label: PREGUNTA, conversationId: "new" });
    vigilante.verificar();
  });

  test("el historial lista la conversacion guardada, empieza un chat nuevo y la reabre", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(RUTA);
    await afirmarPantallaSana(page, "copiloto");
    await page.getByRole("button", { name: PREGUNTA }).click();
    await expect(page.getByText(TEXTO_RESPUESTA)).toBeVisible();

    await page.getByRole("button", { name: "Historial de chats" }).click();
    const panel = page.getByRole("dialog", { name: "Historial de chats" });
    await expect(panel.getByRole("button", { name: PREGUNTA, exact: true })).toBeVisible();
    // Chat nuevo: vuelve la portada (sin conversacion).
    await panel.getByRole("button", { name: "Nuevo chat" }).click();
    await expect(page.getByText(TEXTO_RESPUESTA)).toHaveCount(0);

    // Reabrir desde el historial trae la conversacion guardada desde el servidor.
    await page.getByRole("button", { name: "Historial de chats" }).click();
    await page.getByRole("dialog", { name: "Historial de chats" }).getByRole("button", { name: PREGUNTA, exact: true }).click();
    await expect(page.getByText(TEXTO_RESPUESTA)).toBeVisible();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: /chat-datos\/conversaciones\/[0-9a-f-]+$/ })).length).toBeGreaterThan(0);
    vigilante.verificar();
  });

  test("la barra superior muestra el nombre de la pagina y el boton del header es un enlace al Copiloto", async ({ page, iniciarSesion }) => {
    test.skip(esMovil(page), "la barra superior es de escritorio");
    await iniciarSesion("citas", "owner");
    const enlace = page.getByRole("link", { name: /Chatea con tus datos/ }).first();
    await expect(enlace).toHaveAttribute("href", RUTA);
    await enlace.click();
    await expect(page.getByTestId("barra-pagina-titulo")).toHaveText("Pregunta a tus datos");
  });

  test("rol sin acceso (staff): no ve la entrada Copiloto, la URL directa muestra 'Sin acceso' y no hay llamadas a chat-datos", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "staff");
    await page.goto(RUTA);
    await expect(page.getByText("Sin acceso").first()).toBeVisible();
    await expect(page.getByText("Tu rol no tiene acceso al Copiloto.")).toBeVisible();
    await expect(page.locator("textarea")).toHaveCount(0);
    expect(await mock.buscar({ ruta: /chat-datos/ })).toHaveLength(0);
    if (!esMovil(page)) await expect(sidebar(page).getByRole("link", { name: "Copiloto", exact: true })).toHaveCount(0);
    vigilante.verificar();
  });

  test("rol admin tiene el mismo acceso que owner: ve la entrada Copiloto y pregunta", async ({ page, iniciarSesion }) => {
    test.skip(esMovil(page), "el Sidebar es de escritorio");
    await iniciarSesion("citas", "admin");
    await sidebar(page).getByRole("link", { name: "Copiloto", exact: true }).click();
    await page.getByRole("button", { name: PREGUNTA }).click();
    await expect(page.getByText(TEXTO_RESPUESTA)).toBeVisible();
  });

  test("Escape en el compositor o en el historial nunca envia una pregunta", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(RUTA);
    await afirmarPantallaSana(page, "copiloto");
    const entrada = page.getByRole("textbox").first();
    await entrada.fill("¿cuántas citas se cancelaron?");
    await entrada.press("Escape");
    await page.getByRole("button", { name: "Historial de chats" }).click();
    const panel = page.getByRole("dialog", { name: "Historial de chats" });
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    expect(await mock.buscar({ metodo: "POST", ruta: /\/chat-datos$/ })).toHaveLength(0);
    vigilante.verificar();
  });

  test("con movimiento reducido el Copiloto responde igual, y en oscuro la pantalla sigue sana @oscuro", async ({ page, iniciarSesion, vigilante }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await iniciarSesion("citas", "owner");
    await page.goto(RUTA);
    await afirmarPantallaSana(page, "copiloto");
    await expect(page.getByRole("heading", { level: 1, name: "Pregunta a tus datos" })).toBeVisible();
    await page.getByRole("button", { name: PREGUNTA }).click();
    await expect(page.getByRole("log", { name: "Conversación con el Copiloto" }).getByText(TEXTO_RESPUESTA)).toBeVisible();
    vigilante.verificar();
  });
});
