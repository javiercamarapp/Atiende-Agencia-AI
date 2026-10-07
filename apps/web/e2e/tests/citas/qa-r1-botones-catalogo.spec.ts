// QA R1 (lente botones y paginas) de citas: paginas de Negocio (Proveedores y su ficha con calendarios, Servicios y su ficha,
// Clientes y su ficha, Disponibilidad). Cada control contra la API simulada (fixtures/citas-qa.ts); Cancelar nunca escribe.
import type { Page } from "@playwright/test";
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { citasQa } from "../../mock-api/fixtures/citas-qa.ts";

const BASE = `/citas/${citasQa.orgSlug}`;

async function abrir(page: Page, iniciarSesion: (v: "citas", r?: "owner") => Promise<string>, ruta: string): Promise<void> {
  await iniciarSesion("citas", "owner");
  await page.goto(`${BASE}/${ruta}`);
  await afirmarPantallaSana(page, ruta);
}

test.describe("citas QA R1 botones: proveedores", () => {
  test("crear proveedor manda el POST, limpia el formulario y la tarjeta aparece; doble clic no duplica", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "proveedores");
    await expect(page.getByRole("link", { name: /Dra. Paola Medina/ })).toBeVisible();
    await mock.configurar({ latenciaMs: 300 });
    await page.getByLabel("Nombre").fill("Dra. Ana Ruiz");
    await page.getByLabel("Rol").fill("Periodoncista");
    await page.getByRole("button", { name: "Crear proveedor" }).dblclick();
    await expect(page.getByRole("link", { name: /Dra. Ana Ruiz/ })).toBeVisible();
    const posts = await mock.buscar({ metodo: "POST", ruta: /\/providers$/ });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.cuerpo).toMatchObject({ display_name: "Dra. Ana Ruiz", role_label: "Periodoncista" });
    await expect(page.getByLabel("Nombre")).toHaveValue("");
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-10: crear proveedor o servicio sin datos validos no hace nada y no dice por que", async ({ page, iniciarSesion, mock }) => {
    await abrir(page, iniciarSesion, "proveedores");
    await page.getByRole("button", { name: "Crear proveedor" }).click();
    expect(await mock.escrituras()).toEqual([]);
    await expect(page.locator("main").getByText(/nombre|obligatorio|requerido/i).and(page.locator("[role='alert'], .text-destructive"))).toBeVisible({ timeout: 2_000 });
  });

  test("ficha: Editar y Cancelar no escriben; Guardar manda el PATCH y el titulo cambia", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "proveedores/prv-1");
    await expect(page.getByRole("heading", { level: 1, name: "Dra. Paola Medina" })).toBeVisible();
    await page.getByRole("button", { name: "Editar proveedor" }).click();
    await page.getByLabel("Nombre", { exact: true }).fill("Cambio Descartado");
    await page.getByRole("button", { name: "Cancelar" }).click();
    expect(await mock.escrituras()).toEqual([]);
    await expect(page.getByRole("heading", { level: 1, name: "Dra. Paola Medina" })).toBeVisible();

    await page.getByRole("button", { name: "Editar proveedor" }).click();
    await page.getByLabel("Nombre", { exact: true }).fill("Dra. Paola Medina Pech");
    await page.getByRole("button", { name: "Guardar cambios" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dra. Paola Medina Pech" })).toBeVisible();
    const patch = await mock.buscar({ metodo: "PATCH", ruta: "/providers/prv-1" });
    expect(patch).toHaveLength(1);
    expect(patch[0]!.cuerpo).toMatchObject({ display_name: "Dra. Paola Medina Pech", is_active: true });
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-11: Cancelar la edicion no descarta lo escrito; al volver a Editar reaparece el cambio descartado", async ({ page, iniciarSesion }) => {
    await abrir(page, iniciarSesion, "proveedores/prv-1");
    await page.getByRole("button", { name: "Editar proveedor" }).click();
    await page.getByLabel("Nombre", { exact: true }).fill("Cambio Descartado");
    await page.getByRole("button", { name: "Cancelar" }).click();
    await page.getByRole("button", { name: "Editar proveedor" }).click();
    await expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Dra. Paola Medina");
  });

  test("ficha: quitar un servicio ofrecido manda PUT offered=false y el checkbox lo refleja", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "proveedores/prv-1");
    const casilla = page.getByLabel("Revision de ortodoncia");
    await expect(casilla).toBeChecked();
    await casilla.click();
    await expect(casilla).not.toBeChecked();
    const put = await mock.buscar({ metodo: "PUT", ruta: "/providers/prv-1/services/srv-2" });
    expect(put).toHaveLength(1);
    expect(put[0]!.cuerpo).toEqual({ offered: false });
    vigilante.verificar();
  });

  test("ficha: conectar Cal.com, probar la conexion; la llave nunca se vuelve a mostrar", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "proveedores/prv-1");
    await expect(page.getByLabel("API key")).toHaveAttribute("type", "password");
    await page.getByLabel("API key").fill("cal_live_valor_de_prueba");
    await page.getByLabel("Event type ID").fill("7788");
    await page.getByRole("button", { name: "Conectar Cal.com" }).click();
    await expect(page.getByText("Event type: 7788")).toBeVisible();
    expect((await mock.buscar({ metodo: "POST", ruta: "/calcom/connect" }))[0]!.cuerpo).toMatchObject({ api_key: "cal_live_valor_de_prueba", event_type_id: "7788" });
    await expect(page.getByText("cal_live_valor_de_prueba")).toHaveCount(0);
    const tarjetaCal = page.locator("main").locator("div.rounded-xl, div[class*='card']").filter({ hasText: "Event type: 7788" }).last();
    await tarjetaCal.getByRole("button", { name: "Probar conexión" }).click();
    await expect(page.getByText("Conexión verificada correctamente.")).toBeVisible();
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-12: Desconectar un calendario (Cal.com/CalDAV) lo desconecta con un clic, sin confirmar", async ({ page, iniciarSesion, mock }) => {
    await abrir(page, iniciarSesion, "proveedores/prv-2");
    await expect(page.getByText("Event type: 4455")).toBeVisible();
    await mock.limpiarRegistro();
    await page.getByRole("button", { name: "Desconectar" }).first().click();
    await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 2_000 });
    expect(await mock.escrituras()).toEqual([]);
    // Volver (o Escape) no escribe; confirmar manda el POST de desconexion.
    await dialogo(page, "¿Desconectar Cal.com?").getByRole("button", { name: "Volver" }).click();
    expect(await mock.escrituras()).toEqual([]);
    await page.getByRole("button", { name: "Desconectar" }).first().click();
    await dialogo(page, "¿Desconectar Cal.com?").getByRole("button", { name: "Desconectar calendario" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/calcom/disconnect" })).length).toBe(1);
  });

  test("ficha: el aviso de citas sin sincronizar y Google Calendar conectado se muestran; Conectar Google pide la URL real y navega", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "proveedores/prv-2");
    await expect(page.getByRole("alert").filter({ hasText: "1 cita no se sincronizó" })).toContainText("Cal.com exige el correo del cliente");
    await page.goto(`${BASE}/proveedores/prv-1`);
    await page.getByRole("button", { name: "Conectar Google Calendar" }).click();
    await expect(page).toHaveURL(/google-oauth-simulado/);
    expect(await mock.buscar({ metodo: "GET", ruta: "/providers/prv-1/google-calendar/connect" })).toHaveLength(1);
    vigilante.verificar();
  });

  test("ficha de un proveedor que no existe: error honesto y enlace de regreso", async ({ page, iniciarSesion, vigilante }) => {
    await abrir(page, iniciarSesion, "proveedores/prv-inexistente");
    await expect(page.locator("main").getByText("Proveedor no encontrado.")).toBeVisible();
    await page.getByRole("link", { name: "Volver a proveedores" }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/proveedores$`));
    vigilante.verificar();
  });
});

test.describe("citas QA R1 botones: servicios", () => {
  test("crear servicio con precio en pesos lo manda en centavos; la ficha edita y guarda", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "servicios");
    await page.getByLabel("Nombre").fill("Blanqueamiento");
    await page.getByLabel("Duración (min)").fill("60");
    await page.getByLabel("Precio (opcional)").fill("1250.50");
    await page.getByRole("button", { name: "Crear servicio" }).click();
    await expect(page.getByRole("link", { name: /Blanqueamiento/ })).toContainText("60 min");
    expect((await mock.buscar({ metodo: "POST", ruta: /\/services$/ }))[0]!.cuerpo).toMatchObject({ name: "Blanqueamiento", duration_minutes: 60, price_cents: 125050 });

    await page.getByRole("link", { name: /Limpieza dental/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Limpieza dental" })).toBeVisible();
    await page.getByRole("button", { name: /Editar/ }).click();
    await page.getByLabel(/Precio/).fill("700");
    await page.getByRole("button", { name: "Cancelar" }).click();
    expect(await mock.buscar({ metodo: "PATCH" })).toHaveLength(0);
    await page.getByRole("button", { name: /Editar/ }).click();
    await page.getByLabel(/Precio/).fill("700");
    await page.getByRole("button", { name: /Guardar/ }).click();
    await expect(page.getByRole("button", { name: /Editar/ })).toBeVisible();
    expect((await mock.buscar({ metodo: "PATCH", ruta: "/services/srv-1" }))[0]!.cuerpo).toMatchObject({ price_cents: 70000 });
    vigilante.verificar();
  });
});

test.describe("citas QA R1 botones: clientes", () => {
  test("busqueda, vacio de busqueda y paginacion de 20 en 20", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "clientes");
    await expect(page.getByText("1–20 de 25")).toBeVisible();
    await page.getByRole("button", { name: "Siguiente" }).click();
    await expect(page.getByText("21–25 de 25")).toBeVisible();
    await expect(page.getByRole("button", { name: "Siguiente" })).toBeDisabled();
    await page.getByRole("button", { name: "Anterior" }).click();
    await expect(page.getByText("1–20 de 25")).toBeVisible();
    await expect(page.getByRole("button", { name: "Anterior" })).toBeDisabled();

    await page.getByLabel("Buscar cliente").fill("Mario");
    await expect(page.getByRole("link", { name: "Mario Chan" })).toBeVisible();
    await expect(page.getByText("1–1 de 1")).toBeVisible();
    await page.getByLabel("Buscar cliente").fill("zzz-no-existe");
    await expect(page.getByText("Ningún cliente coincide con esa búsqueda.")).toBeVisible();
    expect(await mock.buscar({ metodo: "GET", ruta: "search=Mario" })).not.toHaveLength(0);
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-13: si una busqueda falla, el error se queda aunque las siguientes respondan bien", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "clientes");
    vigilante.permitirRespuesta5xx(/\/customers/);
    await mock.inyectarFalla({ metodo: "GET", ruta: "search=Ma", status: 503, veces: 1 });
    await page.getByLabel("Buscar cliente").fill("Ma");
    await expect(page.locator("main").getByText("No se pudo cargar la información")).toBeVisible();
    await page.getByLabel("Buscar cliente").fill("Mario");
    await expect(page.getByRole("link", { name: "Mario Chan" })).toBeVisible();
    await expect(page.locator("main").getByText("No se pudo cargar la información")).toHaveCount(0);
  });

  test("QA-citas-R1-botones-14: la busqueda de clientes pide al servidor en cada tecla (sin espera)", async ({ page, iniciarSesion, mock }) => {
    await abrir(page, iniciarSesion, "clientes");
    await mock.limpiarRegistro();
    await page.getByLabel("Buscar cliente").pressSequentially("Paciente", { delay: 30 });
    await expect(page.getByText("1–20 de 23")).toBeVisible();
    expect((await mock.buscar({ metodo: "GET", ruta: "/customers?" })).length).toBeLessThanOrEqual(3);
  });

  test("ficha del cliente: proximas citas, editar correo con Cancelar sin escribir y guardar con PATCH", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "clientes/cli-2");
    await expect(page.getByRole("heading", { level: 1, name: "Mario Chan" })).toBeVisible();
    await expect(page.getByText("Revision de ortodoncia")).toBeVisible();
    await page.getByRole("button", { name: /Agregar correo/ }).click();
    await page.getByLabel("Correo del cliente").fill("mario.chan@example.test");
    await page.getByRole("button", { name: "Cancelar" }).click();
    expect(await mock.escrituras()).toEqual([]);
    await page.getByRole("button", { name: /Agregar correo/ }).click();
    await page.getByLabel("Correo del cliente").fill("mario.chan@example.test");
    await page.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByRole("button", { name: /mario.chan@example.test/ })).toBeVisible();
    expect((await mock.buscar({ metodo: "PATCH", ruta: "/customers/cli-2" }))[0]!.cuerpo).toEqual({ email: "mario.chan@example.test" });
    vigilante.verificar();
  });
});

test.describe("citas QA R1 botones: disponibilidad", () => {
  test("cambiar de proveedor, agregar, editar (Cancelar no escribe) y el horario invalido muestra el error del servidor", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "disponibilidad");
    const tabla = page.getByRole("table");
    await expect(tabla.getByRole("row", { name: /Lunes/ })).toContainText("09:00 – 18:00");
    await page.getByLabel("Proveedor", { exact: true }).selectOption("prv-2");
    await expect(tabla.getByRole("row", { name: /Sábado/ })).toContainText("10:00 – 14:00");
    await expect(tabla.getByRole("row", { name: /Lunes/ })).toContainText("Cerrado");

    await page.locator("#citas-nuevo-horario-dia").selectOption({ label: "Domingo" });
    await page.locator("#citas-nuevo-horario-inicio").fill("09:00");
    await page.locator("#citas-nuevo-horario-fin").fill("13:00");
    await page.getByRole("button", { name: "Agregar horario" }).click();
    await expect(tabla.getByRole("row", { name: /Domingo/ })).toContainText("09:00 – 13:00");

    const sabado = tabla.getByRole("row", { name: /Sábado/ });
    await sabado.getByRole("button", { name: "Editar" }).click();
    await sabado.getByLabel("Hora de fin").fill("15:00");
    await sabado.getByRole("button", { name: "Cancelar" }).click();
    expect(await mock.buscar({ metodo: "PATCH" })).toHaveLength(0);
    await sabado.getByRole("button", { name: "Editar" }).click();
    await sabado.getByLabel("Hora de fin").fill("15:00");
    await sabado.getByRole("button", { name: "Guardar" }).click();
    await expect(sabado).toContainText("10:00 – 15:00");

    // Inicio despues del fin: el panel lo manda tal cual y el 400 del servidor se pinta como error.
    await page.locator("#citas-nuevo-horario-dia").selectOption({ label: "Lunes" });
    await page.locator("#citas-nuevo-horario-inicio").fill("18:00");
    await page.locator("#citas-nuevo-horario-fin").fill("09:00");
    await page.getByRole("button", { name: "Agregar horario" }).click();
    await expect(page.locator("main").getByText("start_time debe ser menor que end_time")).toBeVisible();
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-15: Quitar un horario o una excepcion borra con un clic, sin confirmar", async ({ page, iniciarSesion, mock }) => {
    await abrir(page, iniciarSesion, "disponibilidad");
    await expect(page.getByText(/25 dic/)).toBeVisible();
    await mock.limpiarRegistro();
    await page.getByRole("table").getByRole("row", { name: /Lunes/ }).getByRole("button", { name: "Quitar" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 2_000 });
    expect(await mock.escrituras()).toEqual([]);
    await dialogo(page, "¿Quitar este horario?").getByRole("button", { name: "Volver" }).click();
    expect(await mock.escrituras()).toEqual([]);
    await page.getByRole("table").getByRole("row", { name: /Lunes/ }).getByRole("button", { name: "Quitar" }).click();
    await dialogo(page, "¿Quitar este horario?").getByRole("button", { name: "Quitar horario" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "DELETE", ruta: "/availability-rules/" })).length).toBe(1);
  });

  test("excepcion: guardar dia cerrado y dia con horario mandan su PUT; Quitar manda DELETE", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "disponibilidad");
    await page.getByLabel("Fecha").fill("2026-11-20");
    await page.getByLabel("Motivo (opcional)").fill("Congreso");
    await page.getByRole("button", { name: "Guardar excepción" }).click();
    await expect(page.getByText("(Congreso)")).toBeVisible();
    expect((await mock.buscar({ metodo: "PUT", ruta: "/availability-overrides/2026-11-20" }))[0]!.cuerpo).toMatchObject({ is_closed: true, reason: "Congreso" });

    await page.getByLabel("Fecha").fill("2026-11-21");
    await page.getByLabel("Cerrado todo el día").uncheck();
    await page.locator("#citas-excepcion-inicio").fill("10:00");
    await page.locator("#citas-excepcion-fin").fill("12:00");
    await page.getByRole("button", { name: "Guardar excepción" }).click();
    await expect(page.getByText("10:00 – 12:00")).toBeVisible();

    const fila = page.locator("main div.text-sm").filter({ hasText: "Congreso" });
    await fila.getByRole("button", { name: "Quitar" }).click();
    await dialogo(page, "¿Quitar esta excepción?").getByRole("button", { name: "Quitar excepción" }).click();
    await expect(page.getByText("(Congreso)")).toHaveCount(0);
    expect(await mock.buscar({ metodo: "DELETE", ruta: "/availability-overrides/2026-11-20" })).toHaveLength(1);
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-16: un error al cargar un proveedor se queda pegado al cambiar a otro que si carga", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "disponibilidad");
    vigilante.permitirRespuesta5xx(/\/providers\/prv-2/);
    await mock.inyectarFalla({ metodo: "GET", ruta: "/\\/providers\\/prv-2$/", status: 503, veces: 1 });
    await page.getByLabel("Proveedor", { exact: true }).selectOption("prv-2");
    await expect(page.locator("main").getByText("No se pudo cargar la información")).toBeVisible();
    await page.getByLabel("Proveedor", { exact: true }).selectOption("prv-1");
    await expect(page.getByRole("table").getByRole("row", { name: /Lunes/ })).toContainText("09:00 – 18:00");
    await expect(page.locator("main").getByText("No se pudo cargar la información")).toHaveCount(0);
  });

  test("QA-citas-R1-botones-17: las excepciones muestran la fecha cruda en ISO (2026-12-25) en vez del formato es-MX", async ({ page, iniciarSesion }) => {
    await abrir(page, iniciarSesion, "disponibilidad");
    await expect(page.getByText(/25 dic/)).toBeVisible({ timeout: 2_000 });
  });
});
