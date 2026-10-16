// CHAT-08: Copiloto ("Pregunta a tus datos") de restaurantes de punta a punta contra la API simulada: abre la pagina desde el
// Sidebar, pregunta con un chip, ve los pasos y la respuesta (NDJSON real) con su tabla/grafica y su fuente, y reabre la conversacion
// desde el historial. La respuesta sale de la fixture NDJSON de e2e/mock-api (jamas de la SPA).
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { abrirMasMovil, esMovil, sidebar } from "../helpers/navegacion.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const RUTA = `/restaurantes/${restaurantes.orgSlug}/copiloto`;
const PREGUNTA = "¿Cuánto vendí esta semana?";
const TEXTO_RESPUESTA = "En los últimos 7 días vendiste $18,450 MXN en 96 pedidos.";

test.describe("copiloto de restaurantes @copiloto", () => {
  test("owner: abre el Copiloto desde el menu, pregunta con un chip y ve la respuesta con su fuente", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
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
    await expect(hilo.getByText("Ventas por día").first()).toBeVisible();
    await expect(hilo.getByRole("link", { name: /Pedidos completados/ })).toHaveAttribute("href", `/restaurantes/${restaurantes.orgSlug}/historial`);

    // El POST fue NDJSON, con SOLO pregunta + conversationId "new" (sin ids de negocio ni organizacion).
    const posts = await mock.buscar({ metodo: "POST", ruta: "/chat-datos" });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.cuerpo).toEqual({ tool: "ventas_por_dia", args: { periodo: "esta_semana" }, label: PREGUNTA, conversationId: "new" });
    vigilante.verificar();
  });

  test("el historial lista la conversacion guardada, empieza un chat nuevo y la reabre", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
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
    await iniciarSesion("restaurantes", "owner");
    const enlace = page.getByRole("link", { name: /Chatea con tus datos/ }).first();
    await expect(enlace).toHaveAttribute("href", RUTA);
    await enlace.click();
    await expect(page.getByTestId("barra-pagina-titulo")).toHaveText("Pregunta a tus datos");
  });
});
