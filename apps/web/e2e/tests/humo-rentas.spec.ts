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

  // paridad3: reparto del trabajo de limpieza de punta a punta contra la API simulada (el estado vive en el mock: cada POST se refleja en el
  // GET siguiente). El tablero «Próximos 7 días» muestra a TODO el equipo; la administradora asigna, reasigna con confirmación y completa.
  test("limpieza: la administradora reparte una tarea, reasignarla pide confirmacion (Cancelar y Escape no escriben) y completa el checklist", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("rentas", "admin");
    await page.goto(`/rentas/${rentas.orgSlug}/mis-tareas`);
    await afirmarPantallaSana(page, "mis tareas");

    // Tablero de turnos: todo el equipo, con la cola "Sin asignar" y la marca de proveedor externo.
    const tablero = page.getByRole("heading", { name: "Próximos 7 días" });
    await expect(tablero).toBeVisible();
    await expect(page.getByText("2 tareas · 1 sin responsable.")).toBeVisible();
    await expect(page.getByText("Proveedor externo").first()).toBeVisible();
    await expect(page.getByText("Beto Operador").first()).toBeVisible();

    // Abre la tarea sin asignar y la reparte a Ana.
    await page.getByRole("button", { name: "Limpieza — Casa Playa Norte" }).click();
    await expect(page.getByRole("heading", { name: "Asignar a…" })).toBeVisible();
    await page.getByLabel("Persona").selectOption("per-ana");
    await page.getByRole("button", { name: "Asignar", exact: true }).click();
    await expect(page.getByText("Tarea asignada a Ana Limpieza.")).toBeVisible();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/tareas/tar-1/asignar" })).length).toBe(1);
    expect((await mock.buscar({ metodo: "POST", ruta: "/tareas/tar-1/asignar" }))[0]?.cuerpo).toEqual({ asignadoA: "per-ana", esProveedorExterno: false });
    await expect(page.getByText("Ana Limpieza").first()).toBeVisible();

    // Reasignar una tarea que YA tiene responsable pide confirmación: Cancelar y Escape no escriben.
    await page.getByLabel("Persona").selectOption("per-beto");
    await afirmarCancelarNoEscribe(page, mock, page.getByRole("button", { name: "Asignar", exact: true }), { nombre: /Reasignar la tarea de Casa Playa Norte/, botonCancelar: "Cancelar", verificarFoco: false });
    await page.getByRole("button", { name: "Asignar", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Reasignar" }).click();
    // `afirmarCancelarNoEscribe` limpia el registro del mock al empezar: aqui solo cuenta el POST de la reasignacion confirmada.
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/tareas/tar-1/asignar" })).length).toBe(1);
    expect((await mock.buscar({ metodo: "POST", ruta: "/tareas/tar-1/asignar" }))[0]?.cuerpo).toEqual({ asignadoA: "per-beto", esProveedorExterno: false });
    await expect(page.getByText("Tarea asignada a Beto Operador.")).toBeVisible();

    // Completar con el checklist incompleto: el 409 real del servidor se muestra y no se finge exito.
    await page.getByRole("button", { name: "Completar tarea" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "checklist pendientes" })).toBeVisible();
    // El checkbox es controlado por la respuesta del servidor (clic = POST .../completar): se espera a que el servidor lo marque.
    for (const item of ["Cambiar sábanas", "Limpiar baño", "Reponer amenidades"]) {
      const casilla = page.getByRole("checkbox", { name: item });
      await casilla.click();
      await expect(casilla).toBeChecked();
    }
    await page.getByRole("button", { name: "Completar tarea" }).click();
    await expect(page.getByText("Tarea completada.")).toBeVisible();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/tareas/tar-1/completar" })).length).toBe(2);
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
