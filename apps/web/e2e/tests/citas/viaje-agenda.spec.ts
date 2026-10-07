// QA citas R1 -- lente VIAJE COMPLETO en el panel (Playwright contra la API simulada; nunca la base real). El dueno entra, revisa Primeros
// pasos, da de alta una cita a mano, la confirma y la completa, marca un no-show, cancela otra, avisa a la lista de espera, revisa el
// Resumen y cierra sesion; el staff opera la agenda sin Copiloto. Los `test.fail` documentan defectos (QA-citas-R1-viaje-NN): fallan en
// cuanto se corrijan. El navegador corre en America/Merida (playwright.config.ts), la misma zona del negocio simulado.
import { expect, test } from "../../helpers/fixtures.ts";
import type { Page } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { esMovil } from "../../helpers/navegacion.ts";
import { citas } from "../../mock-api/fixtures/citas.ts";

const BASE = `/citas/${citas.orgSlug}`;
const ZONA = "America/Merida";

/** YYYY-MM-DD en Merida, `dias` dias despues de hoy; si cae en fin de semana avanza al lunes. */
function diaHabil(dias: number): string {
  const d = new Date(Date.now() + dias * 86_400_000);
  for (;;) {
    const s = new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    const dow = new Date(`${s}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return s;
    d.setTime(d.getTime() + 86_400_000);
  }
}
const siguienteDia = (fecha: string) => new Date(Date.parse(`${fecha}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Tarjeta de una cita en la Agenda (acotada por el nombre del cliente). */
function tarjeta(page: Page, cliente: string) {
  return page.locator("section div.card").filter({ hasText: cliente }).first();
}

async function nuevaCita(page: Page, datos: { proveedor: string; servicio: string; fechaHora: string; cliente: string; telefono: string }) {
  await page.getByRole("button", { name: "Nueva cita" }).click();
  const dialogo = page.getByRole("dialog", { name: "Nueva cita" });
  await expect(dialogo).toBeVisible();
  await dialogo.getByLabel("Proveedor").selectOption({ label: datos.proveedor });
  await dialogo.getByLabel("Servicio").selectOption({ label: datos.servicio });
  await dialogo.getByLabel("Fecha y hora").fill(datos.fechaHora);
  await dialogo.getByLabel("Nombre del cliente").fill(datos.cliente);
  await dialogo.getByLabel("Teléfono").fill(datos.telefono);
  await dialogo.getByRole("button", { name: "Crear cita" }).click();
  await expect(dialogo).toBeHidden();
}

test.describe("citas: viaje del dueno en la agenda @viaje", () => {
  test("primeros pasos -> nueva cita -> confirmar -> completar; no-show; cancelar; lista de espera; resumen; cerrar sesion", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");

    // 1) Primeros pasos: el checklist del servidor, con el negocio listo para recibir citas.
    await page.goto(`${BASE}/primeros-pasos`);
    await afirmarPantallaSana(page, "primeros pasos");
    await expect(page.getByText("Registra una primera cita de prueba").first()).toBeVisible();

    // 2) Agenda: alta manual de una cita a las 10:00 (hora del negocio) dentro de dos dias habiles.
    await page.goto(`${BASE}/agenda`);
    await afirmarPantallaSana(page, "agenda");
    const fecha = diaHabil(2);
    await nuevaCita(page, { proveedor: "Dra. Paola Medina", servicio: "Limpieza dental", fechaHora: `${fecha}T10:00`, cliente: "Lucía Canul", telefono: "+529995550310" });
    const altas = await mock.buscar({ metodo: "POST", ruta: /\/appointments$/ });
    expect(altas).toHaveLength(1);
    // 10:00 en Merida (UTC-6) = 16:00Z: lo que viaja al servidor es el instante correcto.
    expect((altas[0]!.cuerpo as { starts_at: string }).starts_at).toBe(`${fecha}T16:00:00.000Z`);
    const nueva = tarjeta(page, "Lucía Canul");
    await expect(nueva).toContainText("10:00");
    await expect(nueva).toContainText("Pendiente");
    await expect(nueva).toContainText("Manual");

    // 3) Confirmar y completar: el estado cambia en pantalla y en el servidor; ya no ofrece acciones de una cita viva.
    await nueva.getByRole("button", { name: "Confirmar" }).click();
    await expect(nueva).toContainText("Confirmada");
    await nueva.getByRole("button", { name: "Completar" }).click();
    await expect(nueva).toContainText("Completada");
    await expect(nueva.getByRole("button", { name: /Cancelar|No-show|Confirmar|Completar/ })).toHaveCount(0);
    expect(await mock.buscar({ metodo: "POST", ruta: /\/apt-qa-\d+\/confirm$/ })).toHaveLength(1);
    expect(await mock.buscar({ metodo: "POST", ruta: /\/apt-qa-\d+\/complete$/ })).toHaveLength(1);

    // 4) No-show de la cita pendiente de Mario Chan (con confirmacion; Volver no escribe).
    const mario = tarjeta(page, "Mario Chan");
    await mario.getByRole("button", { name: "No-show" }).click();
    const dNoShow = page.getByRole("alertdialog");
    await dNoShow.getByRole("button", { name: "Volver" }).click();
    expect(await mock.buscar({ metodo: "POST", ruta: /\/no-show$/ })).toHaveLength(0);
    await mario.getByRole("button", { name: "No-show" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Marcar no-show" }).click();
    await expect(mario).toContainText("No se presentó");

    // 5) Cancelar la cita confirmada de Ana Lilia Pech: el horario se libera.
    const ana = tarjeta(page, "Ana Lilia Pech");
    await ana.getByRole("button", { name: /^Cancelar/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancelar cita" }).click();
    await expect(ana).toContainText("Cancelada");

    // 6) Lista de espera: quien espera aparece y el aviso manual se encola (con confirmacion).
    await expect(page.getByText("Mario Chan").last()).toBeVisible();
    await page.getByRole("button", { name: "Avisar a la lista de espera" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Enviar aviso" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/waitlist/broadcast" })).length).toBe(1);

    // 7) Resumen abre sin errores con sus cifras.
    await page.goto(`${BASE}/resumen`);
    await afirmarPantallaSana(page, "resumen");

    // 8) Cerrar sesion: vuelve al login y la agenda ya no abre sin sesion.
    if (esMovil(page)) await page.getByRole("button", { name: "Abrir menú de cuenta" }).click();
    await page.getByRole("button", { name: "Cerrar sesión" }).first().click();
    await expect(page).toHaveURL(/\/citas(\/[^/]+)?(\/login)?\/?$|\/login/);
    await page.goto(`${BASE}/agenda`);
    await expect(page.getByRole("button", { name: "Nueva cita" })).toHaveCount(0);
    vigilante.verificar();
  });

  test("staff: opera la agenda (confirma) pero no ve Copiloto", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "staff");
    await page.goto(`${BASE}/agenda`);
    const mario = tarjeta(page, "Mario Chan");
    await mario.getByRole("button", { name: "Confirmar" }).click();
    await expect(mario).toContainText("Confirmada");
    expect(await mock.buscar({ metodo: "POST", ruta: /\/apt-2\/confirm$/ })).toHaveLength(1);
    await expect(page.getByRole("link", { name: "Copiloto" })).toHaveCount(0);
    vigilante.verificar();
  });

  test("una cita que choca con otra del mismo profesional muestra el error del servidor y no se cierra el alta", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(`${BASE}/agenda`);
    const fecha = diaHabil(3);
    await nuevaCita(page, { proveedor: "Dra. Paola Medina", servicio: "Limpieza dental", fechaHora: `${fecha}T11:00`, cliente: "Primera Persona", telefono: "+529995550321" });
    await page.getByRole("button", { name: "Nueva cita" }).click();
    const d = page.getByRole("dialog", { name: "Nueva cita" });
    await d.getByLabel("Proveedor").selectOption({ label: "Dra. Paola Medina" });
    await d.getByLabel("Servicio").selectOption({ label: "Limpieza dental" });
    await d.getByLabel("Fecha y hora").fill(`${fecha}T11:15`);
    await d.getByLabel("Nombre del cliente").fill("Segunda Persona");
    await d.getByLabel("Teléfono").fill("+529995550322");
    await d.getByRole("button", { name: "Crear cita" }).click();
    await expect(d.getByRole("alert")).toContainText("ocupado");
    await expect(d).toBeVisible();
    vigilante.verificar();
  });
});

test.describe("citas: zona horaria y reagendar en el panel @viaje", () => {
  test("QA-citas-R1-viaje-13: una cita de la TARDE (19:00 Merida = dia siguiente en UTC) aparece bajo SU dia en la Agenda", async ({ page, iniciarSesion, vigilante }) => {
    test.fail(true, "QA-citas-R1-viaje-13: Agenda.groupByDay agrupa por startsAt.slice(0, 10) (fecha UTC) y titula el grupo con la primera cita en hora local");
    await iniciarSesion("citas", "owner");
    await page.goto(`${BASE}/agenda`);
    const martes = diaHabil(8);
    const miercoles = siguienteDia(martes);
    await nuevaCita(page, { proveedor: "Dr. Luis Cetina", servicio: "Revision de ortodoncia", fechaHora: `${martes}T19:00`, cliente: "Paciente De La Tarde", telefono: "+529995550331" });
    await nuevaCita(page, { proveedor: "Dr. Luis Cetina", servicio: "Revision de ortodoncia", fechaHora: `${miercoles}T10:00`, cliente: "Paciente Del Dia Siguiente", telefono: "+529995550332" });
    const diaDe = (cliente: string) => page.locator("section", { has: page.getByText(cliente) }).locator("h2").first();
    const nombreDia = (fecha: string) => new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", weekday: "long" }).format(new Date(`${fecha}T12:00:00Z`));
    await expect(diaDe("Paciente Del Dia Siguiente")).toContainText(nombreDia(miercoles));
    await expect(diaDe("Paciente De La Tarde")).toContainText(nombreDia(martes));
    vigilante.verificar();
  });

  test("QA-citas-R1-viaje-14: la vista Semana le pide al servidor la semana LOCAL (desde el lunes 00:00 de Merida, no desde el lunes 00:00 UTC)", async ({ page, iniciarSesion, mock, vigilante }) => {
    test.fail(true, "QA-citas-R1-viaje-14: computeRange manda from/to a medianoche UTC: excluye el domingo 18:00-24:00 local e incluye el del domingo anterior");
    await iniciarSesion("citas", "owner");
    await page.goto(`${BASE}/agenda`);
    await mock.limpiarRegistro();
    await page.getByRole("tab", { name: "Semana" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: /\/appointments\?/ })).length).toBeGreaterThan(0);
    const ultima = (await mock.buscar({ metodo: "GET", ruta: /\/appointments\?/ })).at(-1)!;
    const from = new URL(`http://x${ultima.ruta}`).searchParams.get("from")!;
    // La medianoche local de Merida es 06:00Z.
    expect(from).toMatch(/T06:00:00\.000Z$/);
    vigilante.verificar();
  });

  test("QA-citas-R1-viaje-15: el panel puede REAGENDAR una cita (hoy solo cancelar y crear otra, perdiendo el historial)", async ({ page, iniciarSesion, vigilante }) => {
    test.fail(true, "QA-citas-R1-viaje-15: Agenda no ofrece reagendar ni reasignar; solo el agente puede (appointments-client.ts)");
    await iniciarSesion("citas", "owner");
    await page.goto(`${BASE}/agenda`);
    const ana = tarjeta(page, "Ana Lilia Pech");
    await expect(ana).toBeVisible();
    await expect(ana.getByRole("button", { name: /Reagendar|Mover|Cambiar horario/ })).toBeVisible({ timeout: 2_000 });
    vigilante.verificar();
  });
});

test.describe("citas: lista de espera legible @viaje", () => {
  test("QA-citas-R1-viaje-17: la columna Preferencias de la lista de espera no muestra el valor crudo 'any'/'morning' de la base", async ({ page, iniciarSesion, vigilante }) => {
    test.fail(true, "QA-citas-R1-viaje-17: Agenda.tsx pinta candidate.preferredTimeWindow tal cual ('any', 'morning', 'afternoon', 'evening')");
    await iniciarSesion("citas", "owner");
    await page.goto(`${BASE}/agenda`);
    const fila = page.getByRole("row").filter({ hasText: "Mario Chan" });
    await expect(fila).toBeVisible();
    await expect(fila).not.toContainText(/any|morning|afternoon|evening/);
    vigilante.verificar();
  });
});

test.describe("citas: el staff trabaja desde otra zona horaria @viaje", () => {
  test.use({ timezoneId: "America/Tijuana" });
  test("QA-citas-R1-viaje-16: 'Nueva cita' a las 10:00 se guarda a las 10:00 del NEGOCIO (Merida) aunque el navegador este en Tijuana", async ({ page, iniciarSesion, mock }) => {
    test.fail(true, "QA-citas-R1-viaje-16: Agenda convierte datetime-local con la zona del navegador (new Date(local).toISOString()) y muestra horas en la zona del navegador");
    await iniciarSesion("citas", "owner");
    await page.goto(`${BASE}/agenda`);
    const fecha = diaHabil(4);
    await nuevaCita(page, { proveedor: "Dra. Paola Medina", servicio: "Limpieza dental", fechaHora: `${fecha}T10:00`, cliente: "Desde Tijuana", telefono: "+529995550341" });
    const alta = (await mock.buscar({ metodo: "POST", ruta: /\/appointments$/ }))[0]!;
    expect((alta.cuerpo as { starts_at: string }).starts_at).toBe(`${fecha}T16:00:00.000Z`);
  });
});
