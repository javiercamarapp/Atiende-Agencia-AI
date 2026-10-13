// CHAT-12: Copiloto ("Pregunta a tus datos") de licitaciones de punta a punta contra la API simulada: abre la pagina desde el
// Sidebar, pregunta con un chip, ve los pasos y la respuesta (NDJSON real) con su tabla/grafica y su fuente, y reabre la conversacion
// desde el historial. La respuesta sale de la fixture NDJSON de e2e/mock-api (jamas de la SPA).
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { abrirMasMovil, esMovil, sidebar } from "../helpers/navegacion.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";

const RUTA = `/licitaciones/${licitaciones.orgSlug}/copiloto`;
const PREGUNTA = "¿Cómo va el semáforo de mis plazos?";
const TEXTO_RESPUESTA = "Tienes 7 convocatorias abiertas: 1 en rojo, 2 en amarillo y 4 en verde.";

test.describe("copiloto de licitaciones @copiloto", () => {
  test("owner: abre el Copiloto desde el menu, pregunta con un chip y ve la respuesta con su fuente", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
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
    await expect(hilo.getByText("Plazos y semáforo").first()).toBeVisible();
    await expect(hilo.getByRole("link", { name: /Convocatorias de la organización/ })).toHaveAttribute("href", `/licitaciones/${licitaciones.orgSlug}/seguimiento`);

    // El POST fue NDJSON, con SOLO pregunta + conversationId "new" (sin ids de negocio ni organizacion).
    const posts = await mock.buscar({ metodo: "POST", ruta: /\/chat-datos$/ });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.cuerpo).toEqual({ tool: "plazos_semaforo", label: PREGUNTA, conversationId: "new" });
    vigilante.verificar();
  });

  test("el historial lista la conversacion guardada, empieza un chat nuevo y la reabre", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
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
    await iniciarSesion("licitaciones", "owner");
    const enlace = page.getByRole("link", { name: /Chatea con tus datos/ }).first();
    await expect(enlace).toHaveAttribute("href", RUTA);
    await enlace.click();
    await expect(page.getByTestId("barra-pagina-titulo")).toHaveText("Pregunta a tus datos");
  });

  test("cualquier rol de la vertical (staff) tambien ve la entrada Copiloto: el servidor no restringe por rol", async ({ page, iniciarSesion, vigilante }) => {
    test.skip(esMovil(page), "la entrada del Sidebar es de escritorio");
    await iniciarSesion("licitaciones", "staff");
    await expect(sidebar(page).getByRole("link", { name: "Copiloto", exact: true })).toBeVisible();
    await page.goto(RUTA);
    await expect(page.getByRole("button", { name: PREGUNTA })).toBeVisible();
    vigilante.verificar();
  });
});
