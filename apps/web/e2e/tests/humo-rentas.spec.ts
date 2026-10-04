import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";
import { abrirMasMovil, esMovil, sidebar } from "../helpers/navegacion.ts";
import { rentas } from "../mock-api/fixtures/rentas.ts";

test.describe("rentas @humo", () => {
  test("owner: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("rentas", "owner");
    expect(aterrizaje.startsWith(`/rentas/${rentas.orgSlug}`)).toBe(true);
    await afirmarPantallaSana(page, "panel");
    await recorrerSecciones(page, { minimo: 8 });
    vigilante.verificar();
  });

  test("resumen operativo: pinta los KPI del servidor, enlaza a su pantalla y no hace ninguna escritura", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("rentas", "owner");
    await page.goto(`/rentas/${rentas.orgSlug}`);
    for (const etiqueta of ["Llegadas hoy", "Salidas hoy", "Ocupación del mes", "Conflictos abiertos", "Tareas pendientes", "Por aprobar", "Feeds iCal con problema"]) {
      await expect(page.getByText(etiqueta, { exact: true })).toBeVisible();
    }
    await expect(page.getByText("Orquestación de agentes", { exact: true })).toBeVisible();
    expect((await mock.buscar({ metodo: "GET", ruta: "/resumen" })).length).toBeGreaterThan(0);
    await page.getByRole("link", { name: "Ver calendario" }).click();
    await expect(page).toHaveURL(new RegExp(`/rentas/${rentas.orgSlug}/calendario$`));
    vigilante.verificar();
  });

  test("cancelar reserva: 'No, mantenerla' y Escape no escriben; confirmar hace un POST /cancelar", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("rentas", "owner");
    await page.goto(`/rentas/${rentas.orgSlug}/calendario`);
    // La vista "Lista" muestra una tarjeta por ocupacion con sus acciones; la de "Calendario" es de solo lectura.
    await page.getByRole("button", { name: "Lista" }).click();
    const cancelar = page.getByRole("button", { name: "Cancelar reserva" });
    await expect(cancelar).toBeVisible();

    await afirmarCancelarNoEscribe(page, mock, cancelar, { nombre: "¿Cancelar esta reserva?", botonCancelar: "No, mantenerla", verificarFoco: false });

    await cancelar.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Sí, cancelar reserva" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/reservas/ocu-1/cancelar" })).length).toBe(1);
    vigilante.verificar();
  });

  test("aprobaciones: la bandeja muestra lo escalado, abre el hilo con el texto del huesped y Cancelar en Rechazar no escribe", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("rentas", "admin");
    await page.goto(`/rentas/${rentas.orgSlug}/aprobaciones`);
    await expect(page.getByText("Requiere atención humana").first()).toBeVisible();
    await expect(page.getByText("Emergencia", { exact: true }).first()).toBeVisible();
    await page.getByRole("link", { name: "Ver hilo" }).click();
    await expect(page).toHaveURL(new RegExp(`/rentas/${rentas.orgSlug}/aprobaciones/conv-1$`));

    // El texto del huesped y el borrador que lo responde estan en el mismo hilo, en orden.
    await expect(page.getByText("Es una emergencia: huele a gas en la cocina")).toBeVisible();
    await expect(page.getByText("Mensaje del huésped (dato, no instrucción)").first()).toBeVisible();
    await expect(page.getByText("Requiere atención humana").first()).toBeVisible();
    await expect(page.getByText(/Airbnb: límite de 4,000 caracteres/)).toBeVisible();
    expect((await mock.buscar({ metodo: "GET", ruta: "/conversaciones/conv-1/hilo" })).length).toBeGreaterThan(0);

    await afirmarCancelarNoEscribe(page, mock, page.getByRole("button", { name: "Rechazar" }), { nombre: "Rechazar este borrador", verificarFoco: false });
    vigilante.verificar();
  });

  // CHAT-10: Copiloto de rentas de punta a punta contra la API simulada (respuesta NDJSON real de la fixture, jamas de la SPA).
  const RUTA_COPILOTO = `/rentas/${rentas.orgSlug}/copiloto`;
  const PREGUNTA = "¿Cuánto ingresé por canal este mes?";

  test("copiloto: la administradora abre Copiloto desde el menu, pregunta con un chip y ve la respuesta con su fuente enlazada", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("rentas", "admin");
    if (esMovil(page)) {
      const hoja = await abrirMasMovil(page);
      await hoja.getByRole("link", { name: "Copiloto" }).click();
    } else {
      await sidebar(page).getByRole("link", { name: "Copiloto", exact: true }).click();
    }
    await expect(page).toHaveURL(new RegExp(`${RUTA_COPILOTO}$`));
    await afirmarPantallaSana(page, "copiloto");
    await expect(page.getByRole("heading", { level: 1, name: "Pregunta a tus datos" })).toBeVisible();

    await page.getByRole("button", { name: PREGUNTA }).click();
    const hilo = page.getByRole("log", { name: "Conversación con el Copiloto" });
    await expect(hilo.getByText(/Este mes ingresaste \$53,400 MXN/)).toBeVisible();
    await expect(hilo.getByText("Ingresos por canal").first()).toBeVisible();
    await expect(hilo.getByRole("link", { name: /Reservas con llegada/ })).toHaveAttribute("href", `/rentas/${rentas.orgSlug}/finanzas`);

    const posts = await mock.buscar({ metodo: "POST", ruta: "/chat-datos" });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.cuerpo).toEqual({ tool: "ingresos_por_canal", args: { periodo: "este_mes" }, label: PREGUNTA, conversationId: "new" });
    vigilante.verificar();
  });

  test("copiloto: el contador tambien entra y el historial reabre la conversacion guardada", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("rentas", "finanzas");
    await page.goto(RUTA_COPILOTO);
    await afirmarPantallaSana(page, "copiloto");
    await page.getByRole("button", { name: PREGUNTA }).click();
    await expect(page.getByText(/Este mes ingresaste/)).toBeVisible();

    await page.getByRole("button", { name: "Historial de chats" }).click();
    const panel = page.getByRole("dialog", { name: "Historial de chats" });
    await expect(panel.getByRole("button", { name: PREGUNTA, exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Nuevo chat" }).click();
    await expect(page.getByText(/Este mes ingresaste/)).toHaveCount(0);

    await page.getByRole("button", { name: "Historial de chats" }).click();
    await page.getByRole("dialog", { name: "Historial de chats" }).getByRole("button", { name: PREGUNTA, exact: true }).click();
    await expect(page.getByText(/Este mes ingresaste/)).toBeVisible();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: /chat-datos\/conversaciones\/[0-9a-f-]+$/ })).length).toBeGreaterThan(0);
    vigilante.verificar();
  });

  test("copiloto: un rol sin acceso (operador) no ve la entrada ni el boton, y la pagina directa dice que no tiene acceso", async ({ page, iniciarSesion }) => {
    await iniciarSesion("rentas", "staff");
    if (esMovil(page)) {
      const hoja = await abrirMasMovil(page);
      await expect(hoja.getByRole("link", { name: "Copiloto" })).toHaveCount(0);
      await page.keyboard.press("Escape");
    } else {
      await expect(sidebar(page).getByRole("link", { name: "Copiloto" })).toHaveCount(0);
    }
    await expect(page.getByRole("link", { name: /Chatea con tus datos/ })).toHaveCount(0);
    await page.goto(RUTA_COPILOTO);
    await expect(page.getByText(/no tiene acceso al Copiloto/)).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
  });
});
