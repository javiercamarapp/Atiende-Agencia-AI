// QA R1 (lente botones y paginas) de citas: Resumen, Avisos (escalaciones de crisis), Primeros pasos, Configuracion, Staff,
// Auditoria, Privacidad (ARCO), Agente de WhatsApp (+ prueba de voz), Mensajes y Plantillas de WhatsApp. Contra la API simulada
// (fixtures/citas-qa.ts): ningun mensaje sale a WhatsApp ni a Meta, ninguna llamada de voz se abre de verdad.
import type { Page } from "@playwright/test";
import { afirmarCancelarNoEscribe, dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { citasQa } from "../../mock-api/fixtures/citas-qa.ts";

const BASE = `/citas/${citasQa.orgSlug}`;

async function abrir(page: Page, iniciarSesion: (v: "citas", r?: "owner" | "admin" | "staff") => Promise<string>, ruta: string, rol: "owner" | "admin" | "staff" = "owner"): Promise<void> {
  await iniciarSesion("citas", rol);
  await page.goto(`${BASE}/${ruta}`);
  await afirmarPantallaSana(page, ruta);
}

test.describe("citas QA R1 botones: resumen, avisos y primeros pasos", () => {
  test("Resumen: cada tarjeta enlaza a su pantalla real y el error tiene Reintentar", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "resumen");
    await page.getByRole("link", { name: /Ver agenda/ }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/agenda$`));
    await page.goto(`${BASE}/resumen`);
    await page.getByRole("link", { name: /Agente de WhatsApp/ }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/agente-whatsapp$`));

    vigilante.permitirRespuesta5xx(/\/resumen/);
    await mock.inyectarFalla({ metodo: "GET", ruta: "/resumen", status: 503, veces: 1 });
    await page.goto(`${BASE}/resumen`);
    await page.getByRole("button", { name: "Reintentar" }).click();
    await expect(page.getByRole("link", { name: /Ver agenda/ })).toBeVisible();
    vigilante.verificar();
  });

  test("Avisos: por confirmar enlaza a la agenda; una escalacion de crisis se toma y se resuelve con nota", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "avisos");
    const escalacion = page.getByTestId("aviso-escalacion");
    await expect(escalacion).toContainText("Señal «emergencia» · cliente ***0202");
    await escalacion.getByLabel("Nota de seguimiento").fill("Se llamo al paciente");
    await escalacion.getByRole("button", { name: "Tomar seguimiento" }).click();
    await expect(escalacion).toHaveAttribute("data-seguimiento", "in_progress");
    await expect(escalacion).toContainText("Nota: Se llamo al paciente");
    await escalacion.getByRole("button", { name: "Marcar resuelta" }).click();
    await expect(escalacion).toHaveAttribute("data-seguimiento", "resolved");
    await expect(escalacion.getByRole("button")).toHaveCount(0);
    const posts = await mock.buscar({ metodo: "POST", ruta: "/escalaciones/esc-1/seguimiento" });
    expect(posts.map((x) => (x.cuerpo as { estado: string }).estado)).toEqual(["in_progress", "resolved"]);
    vigilante.verificar();
  });

  test("Avisos: el error de seguimiento (409) se muestra en la fila sin romper la pantalla", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "avisos");
    await mock.inyectarFalla({ metodo: "POST", ruta: "/seguimiento", status: 409, cuerpo: { message: "La escalacion ya esta resuelta." }, veces: 1 });
    const escalacion = page.getByTestId("aviso-escalacion");
    await escalacion.getByRole("button", { name: "Marcar resuelta" }).click();
    await expect(escalacion.getByRole("alert")).toHaveText("La escalacion ya esta resuelta.");
    await expect(escalacion.getByRole("button", { name: "Marcar resuelta" })).toBeEnabled();
    vigilante.verificar();
  });

  test("Primeros pasos: progreso real, cada paso lleva a su pantalla, posponer y volver a mostrar; sin enlace publico mientras no este lista", async ({ page, iniciarSesion, vigilante }) => {
    await abrir(page, iniciarSesion, "primeros-pasos");
    const pasos = page.getByRole("list", { name: "Pasos" });
    await expect(pasos.getByRole("listitem")).not.toHaveCount(0);
    const opcional = pasos.getByRole("listitem").filter({ hasText: "Revisa los recordatorios" });
    await opcional.getByRole("button", { name: /Posponer/ }).click();
    await expect(pasos.getByRole("listitem").filter({ hasText: "Revisa los recordatorios" })).toHaveCount(0);
    await page.getByRole("button", { name: "Volver a mostrar" }).first().click();
    await expect(pasos.getByRole("listitem").filter({ hasText: "Revisa los recordatorios" })).toHaveCount(1);
    // Un paso requerido no se puede descartar.
    await expect(pasos.getByRole("listitem").filter({ hasText: "Conecta WhatsApp" }).getByRole("button", { name: "Descartar" })).toHaveCount(0);
    await pasos.getByRole("listitem").filter({ hasText: "Conecta WhatsApp" }).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/agente-whatsapp$`));
    await page.goBack();
    // Mientras falte un paso requerido, la pantalla lo dice y NO ofrece el enlace publico de reservas.
    await expect(page.getByText("Aún no estás listo para recibir citas en línea")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copiar" })).toHaveCount(0);
    vigilante.verificar();
  });
});

test.describe("citas QA R1 botones: configuracion y staff", () => {
  test("Configuracion: guarda rubro, zona y telefono con PATCH; una zona invalida muestra el 400 del servidor", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "configuracion");
    await expect(page.getByLabel("Zona horaria por defecto")).toHaveValue("America/Merida");
    await page.getByLabel("Rubro").selectOption("medico");
    await page.getByRole("button", { name: "Guardar cambios" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Guardado." })).toBeVisible();
    expect((await mock.buscar({ metodo: "PATCH", ruta: "/tenant-config" }))[0]!.cuerpo).toMatchObject({ rubro: "medico", default_timezone: "America/Merida", owner_notification_phone: "+529995550200" });

    await page.getByLabel("Zona horaria por defecto").fill("GMT-6 Merida");
    await page.getByRole("button", { name: "Guardar cambios" }).click();
    await expect(page.locator("main").getByText("default_timezone: zona horaria IANA invalida")).toBeVisible();
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-18: Configuracion promete 'Próximamente' plantillas de recordatorios y canal de WhatsApp que ya existen", async ({ page, iniciarSesion }) => {
    await abrir(page, iniciarSesion, "configuracion");
    await expect(page.getByText("Próximamente")).toHaveCount(0);
  });

  test("QA-citas-R1-botones-19: la zona horaria del negocio es texto libre (sin lista IANA) y el error solo llega del servidor", async ({ page, iniciarSesion }) => {
    test.fail(!process.env.QA_SIN_FAIL, "QA-citas-R1-botones-19: Configuracion.tsx usa <Input> libre para default_timezone");
    await abrir(page, iniciarSesion, "configuracion");
    await expect(page.getByRole("combobox", { name: "Zona horaria por defecto" })).toBeVisible({ timeout: 2_000 });
  });

  test("Staff: invitar (doble clic no duplica) y el error 409 del duplicado se muestra; el rol de otro cambia con PATCH", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "staff");
    await expect(page.getByText("recepcion@example.test")).toBeVisible();
    await mock.configurar({ latenciaMs: 300 });
    await page.getByLabel("Correo").fill("Nueva.Persona@Example.test");
    await page.getByRole("button", { name: "Invitar" }).dblclick();
    await expect(page.getByText("nueva.persona@example.test").first()).toBeVisible();
    expect(await mock.buscar({ metodo: "POST", ruta: "/staff/invitaciones" })).toHaveLength(1);
    await mock.configurar({ latenciaMs: 0 });

    await page.getByLabel("Correo").fill("recepcion@example.test");
    await page.getByRole("button", { name: "Invitar" }).click();
    await expect(page.locator("main").getByText("Ya hay una invitacion pendiente para ese correo.")).toBeVisible();

    await page.getByLabel("Rol de Asistente Dental").selectOption("admin");
    await dialogo(page, "¿Cambiar el rol de esta persona?").getByRole("button", { name: "Cambiar rol" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PATCH", ruta: "/staff/miembros/usr-asistente" })).length).toBe(1);
    await expect(page.getByLabel("Rol de Asistente Dental")).toHaveValue("admin");
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-20: Revocar una invitacion y cambiar el rol de un staff se ejecutan sin confirmar", async ({ page, iniciarSesion, mock }) => {
    await abrir(page, iniciarSesion, "staff");
    await mock.limpiarRegistro();
    await page.getByRole("button", { name: "Revocar" }).first().click();
    await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 2_000 });
    expect(await mock.escrituras()).toEqual([]);
    await dialogo(page, "¿Revocar esta invitación?").getByRole("button", { name: "Volver" }).click();
    expect(await mock.escrituras()).toEqual([]);
    await page.getByRole("button", { name: "Revocar" }).first().click();
    await dialogo(page, "¿Revocar esta invitación?").getByRole("button", { name: "Revocar invitación" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "DELETE", ruta: "/staff/invitaciones/" })).length).toBe(1);
    // Cambiar el rol de otra persona tambien pide confirmar; Volver deja el rol como estaba.
    await mock.limpiarRegistro();
    await page.getByLabel("Rol de Asistente Dental").selectOption("admin");
    await dialogo(page, "¿Cambiar el rol de esta persona?").getByRole("button", { name: "Volver" }).click();
    expect(await mock.escrituras()).toEqual([]);
    await expect(page.getByLabel("Rol de Asistente Dental")).not.toHaveValue("admin");
  });

  test("QA-citas-R1-botones-21: el panel ofrece cambiar tu propio rol (el servidor siempre lo rechaza)", async ({ page, iniciarSesion }) => {
    await abrir(page, iniciarSesion, "staff", "admin");
    await expect(page.getByLabel(/^Rol de /).first()).toBeDisabled({ timeout: 2_000 });
  });
});

test.describe("citas QA R1 botones: auditoria y privacidad", () => {
  test("Auditoria: filtro por tipo pide al servidor, Cargar mas agrega la siguiente pagina", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "auditoria");
    await expect(page.getByRole("table")).toBeVisible();
    const filas = page.getByRole("table").getByRole("row");
    const antes = await filas.count();
    const mas = page.getByRole("button", { name: /Cargar más/ });
    if (await mas.isVisible()) {
      await mas.click();
      await expect.poll(() => filas.count()).toBeGreaterThan(antes);
    }
    await page.getByLabel(/Tipo/).selectOption({ index: 1 });
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "tipo=" })).length).toBeGreaterThan(0);
    vigilante.verificar();
  });

  test("Privacidad (ARCO): Cancelar la accion no escribe; Rechazar exige motivo; Resolver manda el PATCH", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "privacidad");
    const fila = page.getByRole("row").filter({ hasText: "ARCO-0001" });
    await expect(fila).toContainText("***0201");
    await fila.getByRole("button", { name: "Rechazar" }).click();
    await fila.getByRole("button", { name: "Confirmar: Rechazar" }).click();
    await expect(fila.getByRole("alert")).toHaveText("Indica el motivo del rechazo.");
    await fila.getByRole("button", { name: "Cancelar" }).click();
    expect(await mock.escrituras()).toEqual([]);

    await fila.getByRole("button", { name: "Resolver" }).click();
    await fila.getByLabel("Nota (opcional)").fill("Se entrego copia de sus datos");
    await fila.getByRole("button", { name: "Confirmar: Resolver" }).click();
    await expect(page.getByRole("row").filter({ hasText: "ARCO-0001" })).toContainText(/Resuelta/);
    expect((await mock.buscar({ metodo: "PATCH", ruta: "/solicitudes/arco-1/estado" }))[0]!.cuerpo).toEqual({ estado: "resuelta", nota: "Se entrego copia de sus datos" });

    await page.getByLabel("Derecho").selectOption("cancelacion");
    await expect(page.getByRole("row").filter({ hasText: "ARCO-0001" })).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: "ARCO-0002" })).toBeVisible();
    vigilante.verificar();
  });
});

test.describe("citas QA R1 botones: WhatsApp y voz", () => {
  test("Agente de WhatsApp: Desconectar el numero pide confirmacion (Cancelar/Escape no escriben); revisar y guardar crea version", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "agente-whatsapp");
    const desconectar = page.getByRole("button", { name: "Desconectar" });
    await afirmarCancelarNoEscribe(page, mock, desconectar, { nombre: "Desconectar el número", verificarFoco: false });

    await page.getByLabel(/Nombre del agente/).fill("Sofi");
    await page.getByRole("button", { name: "Revisar cambios" }).click();
    const previa = page.getByRole("region", { name: "Vista previa de los cambios" });
    await expect(previa).toContainText("agentName");
    await previa.getByRole("button", { name: "Confirmar y guardar" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PUT", ruta: /whatsapp-agente$/ })).length).toBe(1);
    expect((await mock.buscar({ metodo: "PUT", ruta: /whatsapp-agente$/ }))[0]!.cuerpo).toMatchObject({ agentName: "Sofi", versionEsperada: 1 });
    vigilante.verificar();
  });

  test("Agente de WhatsApp: la prueba de voz dice con honestidad que requiere credenciales y no ofrece llamar", async ({ page, iniciarSesion, vigilante }) => {
    await abrir(page, iniciarSesion, "agente-whatsapp");
    await expect(page.getByText("Requiere credenciales")).toBeVisible();
    await expect(page.getByTestId("preview-no-disponible")).toContainText("No disponible aún");
    await expect(page.getByRole("button", { name: "Hacer llamada de prueba" })).toHaveCount(0);
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-22: la llamada de prueba de voz no es un dialogo: Escape no la cierra y el foco no entra", async ({ page, iniciarSesion, mock }) => {
    test.fail(!process.env.QA_SIN_FAIL, "QA-citas-R1-botones-22: LlamadaDePrueba (voz/PruebaAgenteVoz.tsx) es un div fixed inset-0 sin role=dialog, sin Escape ni trampa de foco");
    await abrir(page, iniciarSesion, "agente-whatsapp");
    await mock.agregarAEstado("citas.qa.banderas", "voz-preview");
    await page.reload();
    await page.getByRole("button", { name: "Hacer llamada de prueba" }).click();
    await expect(page.getByTestId("llamada-de-prueba")).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("llamada-de-prueba")).toBeHidden({ timeout: 2_000 });
  });

  test("Mensajes de WhatsApp: revisar, guardar con version; Restablecer pide confirmar; un 409 de version se explica", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "mensajes-whatsapp");
    await afirmarCancelarNoEscribe(page, mock, page.getByRole("button", { name: "Volver a los valores por defecto" }), { nombre: "Volver a los valores por defecto", verificarFoco: false });
    await page.getByRole("switch", { name: /reagendado/i }).click();
    await page.getByRole("button", { name: "Revisar cambios" }).click();
    const previa = page.getByRole("region", { name: "Vista previa de los cambios" });
    await expect(previa).toContainText("rescheduleEnabled");
    // Otra persona guardo antes: el servidor responde 409 y la pantalla lo dice sin perder lo escrito.
    await mock.inyectarFalla({ metodo: "PUT", ruta: "/whatsapp-mensajes$/", status: 409, cuerpo: { message: "Otra persona guardo cambios: recarga para ver la version nueva." }, veces: 1 });
    await previa.getByRole("button", { name: "Confirmar y guardar" }).click();
    await expect(page.locator("main").getByText("Otra persona guardo cambios")).toBeVisible();
    await expect(page.getByRole("switch", { name: /reagendado/i })).toBeChecked();
    vigilante.verificar();
  });

  test("Plantillas de WhatsApp: crear con Cancelar/Escape sin escribir, nombre invalido muestra el 400, Quitar pide confirmar", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrir(page, iniciarSesion, "mensajes-whatsapp");
    const seccion = page.getByRole("region", { name: "Aviso de lista de espera" });
    const abrirBtn = seccion.getByRole("button").first();
    await afirmarCancelarNoEscribe(page, mock, abrirBtn, { verificarFoco: false });
    await abrirBtn.click();
    const d = dialogo(page);
    await d.getByLabel(/Nombre/).fill("Plantilla Con Espacios");
    await d.getByRole("button", { name: /Guardar/ }).click();
    await expect(d.getByText(/solo minusculas/)).toBeVisible();
    await d.getByLabel(/Nombre/).fill("citas_lista_espera_v1");
    await d.getByRole("button", { name: /Guardar/ }).click();
    await expect(d).toBeHidden();
    await expect(seccion).toContainText("citas_lista_espera_v1");
    const quitar = page.getByRole("region", { name: "Recordatorio de cita" }).getByRole("button", { name: /Quitar/ });
    await afirmarCancelarNoEscribe(page, mock, quitar, { nombre: "Quitar la plantilla", verificarFoco: false });
    vigilante.verificar();
  });
});
