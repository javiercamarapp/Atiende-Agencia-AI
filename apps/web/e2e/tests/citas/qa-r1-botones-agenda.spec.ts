// QA R1 (lente botones y paginas) de citas: Agenda. Cada control contra la API simulada (fixtures/citas-qa.ts): ciclo de vida de
// la cita (confirmar, completar, no-show, cancelar), alta manual, lista de espera, filtros, navegacion de rango, zonas horarias,
// doble clic, carreras y errores. Cancelar/Escape/clic fuera NUNCA escriben. Los defectos confirmados quedan como `test.fail` con
// su id QA-citas-R1-botones-NN (ver work/qa/citas/ronda-1-botones.md); cuando se corrijan, la prueba avisa al "pasar".
import type { Locator, Page } from "@playwright/test";
import { abrirDialogo, afirmarCancelarNoEscribe, dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { CLAVE_CITAS, citasQa } from "../../mock-api/fixtures/citas-qa.ts";

const AGENDA = `/citas/${citasQa.orgSlug}/agenda`;
const ZONA_NEGOCIO = "America/Merida"; // la del negocio (Resumen/catalogo publico); UTC-6 todo el ano

/** Tarjeta de una cita en la agenda (cada `<section>` es un dia; sus hijos directos son las tarjetas). */
function tarjeta(page: Page, texto: string | RegExp): Locator {
  return page.locator("main section > div").filter({ hasText: texto });
}

/** Instante UTC de una hora local de Merida (UTC-6 fijo). */
function enMerida(fecha: string, hhmm: string): string {
  return new Date(`${fecha}T${hhmm}:00-06:00`).toISOString();
}

/** Fecha de calendario (YYYY-MM-DD) en Merida desplazada `dias` desde hoy. */
function fechaMerida(dias: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_NEGOCIO, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + dias * 86_400_000));
}

function citaExtra(id: string, startsAt: string, minutos: number, cliente: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    property_id: citasQa.propertyId,
    provider_id: "prv-1",
    service_id: "srv-1",
    customer_id: "cli-1",
    starts_at: startsAt,
    ends_at: new Date(new Date(startsAt).getTime() + minutos * 60_000).toISOString(),
    status: "confirmed",
    source: "voice",
    notes: null,
    provider_name: "Dra. Paola Medina",
    service_name: "Limpieza dental",
    customer_name: cliente,
    customer_phone: "+529995550299",
    ...extra,
  };
}

async function abrirAgenda(page: Page, iniciarSesion: (v: "citas", r?: "owner" | "admin" | "staff") => Promise<string>, rol: "owner" | "admin" | "staff" = "owner"): Promise<void> {
  await iniciarSesion("citas", rol);
  await page.goto(AGENDA);
  await afirmarPantallaSana(page, "agenda");
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
  await expect(tarjeta(page, "Revision de ortodoncia")).toBeVisible();
}

test.describe("citas QA R1 botones: agenda", () => {
  test("confirmar, completar, no-show y cancelar: cada boton hace su POST real y la tarjeta refleja el estado nuevo", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirAgenda(page, iniciarSesion);
    const pendiente = tarjeta(page, "Revision de ortodoncia");
    await expect(pendiente).toContainText("Pendiente");

    await pendiente.getByRole("button", { name: "Confirmar" }).click();
    await expect(pendiente).toContainText("Confirmada");
    await expect(pendiente.getByRole("button", { name: "Confirmar" })).toHaveCount(0);
    expect(await mock.buscar({ metodo: "POST", ruta: "/appointments/apt-2/confirm" })).toHaveLength(1);

    await pendiente.getByRole("button", { name: "Completar" }).click();
    await expect(pendiente).toContainText("Completada");
    // Una cita completada ya no ofrece acciones de ciclo de vida.
    await expect(pendiente.getByRole("button")).toHaveCount(0);

    const confirmada = tarjeta(page, "Limpieza dental");
    const noShow = confirmada.getByRole("button", { name: "No-show" });
    await afirmarCancelarNoEscribe(page, mock, noShow, { nombre: "¿Marcar esta cita como no-show?", botonCancelar: "Volver", verificarFoco: false });
    await noShow.click();
    await dialogo(page, "¿Marcar esta cita como no-show?").getByRole("button", { name: "Marcar no-show" }).click();
    await expect(confirmada).toContainText("No se presentó");
    expect(await mock.buscar({ metodo: "POST", ruta: "/appointments/apt-1/no-show" })).toHaveLength(1);
    vigilante.verificar();
  });

  test("el confirm de cancelar no escribe con Volver ni Escape y confirma con un solo POST; el 409 del servidor se muestra", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirAgenda(page, iniciarSesion);
    const cita = tarjeta(page, "Limpieza dental");
    const cancelar = cita.getByRole("button", { name: "Cancelar" });
    await afirmarCancelarNoEscribe(page, mock, cancelar, { nombre: "¿Cancelar esta cita?", botonCancelar: "Volver", verificarFoco: false });

    // Otro miembro del staff la cancelo antes: el servidor responde 409 y la agenda lo dice sin quedar rota.
    await mock.inyectarFalla({ metodo: "POST", ruta: "/appointments/apt-1/cancel", status: 409, cuerpo: { message: "La cita ya fue cancelada por otra persona." }, veces: 1 });
    await cancelar.click();
    await dialogo(page, "¿Cancelar esta cita?").getByRole("button", { name: "Cancelar cita" }).click();
    await expect(page.getByText("La cita ya fue cancelada por otra persona.")).toBeVisible();
    await expect(cancelar).toBeEnabled();

    await cancelar.click();
    await dialogo(page, "¿Cancelar esta cita?").getByRole("button", { name: "Cancelar cita" }).click();
    await expect(cita).toContainText("Cancelada");
    expect(await mock.buscar({ metodo: "POST", ruta: "/appointments/apt-1/cancel" })).toHaveLength(2);
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-01: cuando falla una accion o la carga, el error de la agenda no ofrece Reintentar", async ({ page, iniciarSesion, mock }) => {
    await abrirAgenda(page, iniciarSesion);
    await mock.inyectarFalla({ metodo: "POST", ruta: "/appointments/apt-2/confirm", status: 500, veces: 1 });
    await tarjeta(page, "Revision de ortodoncia").getByRole("button", { name: "Confirmar" }).click();
    const error = page.locator("main").getByText("No se pudo cargar la información").or(page.locator("main [role='alert']")).first();
    await expect(error).toBeVisible();
    // El EstadoError de la agenda no ofrece "Reintentar": la unica salida es cambiar de rango o recargar la pagina.
    await expect(page.locator("main").getByRole("button", { name: "Reintentar" })).toBeVisible({ timeout: 2_000 });
  });

  test("doble clic en Confirmar manda un solo POST y no pinta un error falso", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirAgenda(page, iniciarSesion);
    await mock.configurar({ latenciaMs: 300 });
    await tarjeta(page, "Revision de ortodoncia").getByRole("button", { name: "Confirmar" }).dblclick();
    await expect(tarjeta(page, "Revision de ortodoncia")).toContainText("Confirmada");
    expect(await mock.buscar({ metodo: "POST", ruta: "/appointments/apt-2/confirm" })).toHaveLength(1);
    await expect(page.locator("main [role='alert']")).toHaveCount(0);
    vigilante.verificar();
  });

  test("Nueva cita: Cerrar, Escape y clic fuera no escriben; crear manda el POST con los datos y la cita aparece", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirAgenda(page, iniciarSesion);
    const nueva = page.getByRole("button", { name: "Nueva cita" });
    await mock.limpiarRegistro();
    for (const via of ["cerrar", "escape", "fuera"] as const) {
      const d = await abrirDialogo(page, nueva, "Nueva cita");
      await d.getByLabel("Nombre del cliente").fill("No debe guardarse");
      if (via === "cerrar") await d.getByRole("button", { name: "Cerrar" }).click();
      else if (via === "escape") await page.keyboard.press("Escape");
      else await page.mouse.click(5, 5);
      await expect(d).toBeHidden();
    }
    expect(await mock.escrituras()).toEqual([]);

    const d = await abrirDialogo(page, nueva, "Nueva cita");
    // Sin datos el formulario no se envia (validacion nativa de `required`).
    await d.getByRole("button", { name: "Crear cita" }).click();
    await expect(d).toBeVisible();
    expect(await mock.escrituras()).toEqual([]);

    const fecha = fechaMerida(4);
    await d.getByLabel("Proveedor").selectOption("prv-2");
    await d.getByLabel("Servicio").selectOption("srv-2");
    await d.getByLabel("Fecha y hora").fill(`${fecha}T11:30`);
    await d.getByLabel("Nombre del cliente").fill("Carmen Dzib");
    await d.getByLabel("Teléfono").fill("+529995550260");
    await d.getByLabel("Correo (opcional)").fill("carmen.dzib@example.test");
    await d.getByLabel("Notas (opcional)").fill("Primera vez");
    await d.getByRole("button", { name: "Crear cita" }).click();
    await expect(d).toBeHidden();
    const posts = await mock.buscar({ metodo: "POST", ruta: /\/appointments$/ });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.cuerpo).toMatchObject({ provider_id: "prv-2", service_id: "srv-2", customer_name: "Carmen Dzib", customer_phone: "+529995550260", customer_email: "carmen.dzib@example.test", notes: "Primera vez" });
    expect((posts[0]!.cuerpo as { starts_at: string }).starts_at).toBe(enMerida(fecha, "11:30"));
    await expect(tarjeta(page, "Carmen Dzib")).toContainText("Manual");

    // Al reabrir, el formulario esta limpio.
    const otra = await abrirDialogo(page, nueva, "Nueva cita");
    await expect(otra.getByLabel("Nombre del cliente")).toHaveValue("");
    vigilante.verificar();
  });

  test("Nueva cita: un choque de horario (409) se muestra dentro del dialogo y no lo cierra; doble clic en Crear manda un solo POST", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirAgenda(page, iniciarSesion);
    const fecha = fechaMerida(5);
    const llenar = async (d: Locator, cliente: string) => {
      await d.getByLabel("Proveedor").selectOption("prv-1");
      await d.getByLabel("Servicio").selectOption("srv-1");
      await d.getByLabel("Fecha y hora").fill(`${fecha}T10:00`);
      await d.getByLabel("Nombre del cliente").fill(cliente);
      await d.getByLabel("Teléfono").fill("+529995550261");
    };
    await mock.configurar({ latenciaMs: 300 });
    let d = await abrirDialogo(page, page.getByRole("button", { name: "Nueva cita" }), "Nueva cita");
    await llenar(d, "Primera Persona");
    await d.getByRole("button", { name: "Crear cita" }).dblclick();
    await expect(d).toBeHidden();
    expect(await mock.buscar({ metodo: "POST", ruta: /\/appointments$/ })).toHaveLength(1);

    d = await abrirDialogo(page, page.getByRole("button", { name: "Nueva cita" }), "Nueva cita");
    await llenar(d, "Segunda Persona");
    await d.getByRole("button", { name: "Crear cita" }).click();
    await expect(d.getByRole("alert")).toContainText("Ese horario ya no esta disponible");
    await expect(d).toBeVisible();
    // Lo que se escribio no se pierde: se puede corregir la hora y reintentar.
    await expect(d.getByLabel("Nombre del cliente")).toHaveValue("Segunda Persona");
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-02: el 409 de choque trae horarios alternativos y el dialogo no los ofrece", async ({ page, iniciarSesion }) => {
    await abrirAgenda(page, iniciarSesion);
    const fecha = fechaMerida(6);
    for (const cliente of ["Uno Ocupa", "Dos Choca"]) {
      const d = await abrirDialogo(page, page.getByRole("button", { name: "Nueva cita" }), "Nueva cita");
      await d.getByLabel("Proveedor").selectOption("prv-1");
      await d.getByLabel("Servicio").selectOption("srv-1");
      await d.getByLabel("Fecha y hora").fill(`${fecha}T12:00`);
      await d.getByLabel("Nombre del cliente").fill(cliente);
      await d.getByLabel("Teléfono").fill("+529995550262");
      await d.getByRole("button", { name: "Crear cita" }).click();
    }
    const d = dialogo(page, "Nueva cita");
    await expect(d.getByRole("alert")).toBeVisible();
    // El servidor sugirio 13:00 (fin de la cita que choca + colchon): el dialogo lo ofrece (el panel pinta las horas en 12 h, "01:00 p.m.").
    const sugerencia = d.getByRole("button", { name: /01:00\s*p\.\s*m\./ });
    await expect(sugerencia).toBeVisible({ timeout: 2_000 });
    // Elegirla rellena la hora y el siguiente intento ya no choca.
    await sugerencia.click();
    await expect(d.getByLabel("Fecha y hora")).toHaveValue(`${fecha}T13:00`);
    await d.getByRole("button", { name: "Crear cita" }).click();
    await expect(d).toBeHidden();
  });

  test("filtro de proveedor: pide solo sus citas y la lista de espera usa el mismo filtro", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirAgenda(page, iniciarSesion);
    await mock.limpiarRegistro();
    await page.getByLabel("Filtrar por proveedor").selectOption("prv-2");
    await expect(tarjeta(page, "Limpieza dental")).toHaveCount(0);
    await expect(tarjeta(page, "Revision de ortodoncia")).toBeVisible();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "provider_id=prv-2" })).length).toBeGreaterThanOrEqual(2);
    await expect(page.getByText("Filtro de proveedor: el mismo selector de arriba (Dr. Luis Cetina).")).toBeVisible();
    vigilante.verificar();
  });

  test("Anterior, Hoy, Siguiente y las pestanas Mes/Semana cambian el rango pedido y la etiqueta", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirAgenda(page, iniciarSesion);
    const etiqueta = page.locator("main header p.capitalize");
    const inicial = (await etiqueta.textContent()) ?? "";
    await mock.limpiarRegistro();
    await page.getByRole("button", { name: "Siguiente" }).click();
    await expect(etiqueta).not.toHaveText(inicial);
    await page.getByRole("button", { name: "Anterior" }).click();
    await expect(etiqueta).toHaveText(inicial);
    await page.getByRole("tab", { name: "Semana" }).click();
    await expect(etiqueta).toHaveText(/^Semana del /i);
    await expect(page.getByRole("tab", { name: "Semana" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Siguiente" }).click();
    await page.getByRole("button", { name: "Hoy" }).click();
    await page.getByRole("tab", { name: "Mes" }).click();
    await expect(etiqueta).toHaveText(inicial);
    const gets = await mock.buscar({ metodo: "GET", ruta: "/appointments?" });
    expect(new Set(gets.map((g) => new URL(`http://x${g.ruta}`).searchParams.get("from"))).size).toBeGreaterThanOrEqual(3);
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-03: la respuesta lenta del mes anterior pisa la agenda del mes que se esta viendo", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("citas", "owner");
    const fecha = fechaMerida(0);
    const mes = fecha.slice(0, 7);
    // La primera carga del mes actual tarda 1.5 s y trae una cita marcada; la del mes siguiente responde al instante.
    await mock.inyectarFalla({ metodo: "GET", ruta: `/\\/appointments\\?from=${mes}-01/`, status: 200, cuerpo: { appointments: [citaExtra("apt-lenta", enMerida(fecha, "12:00"), 45, "Respuesta Vieja")] }, retrasoMs: 1_500, veces: 1 });
    await page.goto(AGENDA);
    await page.getByRole("button", { name: "Siguiente" }).click();
    await expect(page.locator("main header p.capitalize")).not.toHaveText(new RegExp(new Intl.DateTimeFormat("es-MX", { month: "long", timeZone: "UTC" }).format(new Date(`${mes}-15T00:00:00Z`)), "i"));
    // Se espera a que la respuesta vieja (inyectada, 1.5 s) llegue de verdad antes de mirar la lista.
    await expect.poll(async () => (await mock.peticiones()).some((r) => r.inyectada), { timeout: 5_000 }).toBe(true);
    await page.waitForLoadState("networkidle");
    await expect(tarjeta(page, "Respuesta Vieja")).toHaveCount(0);
  });

  test("QA-citas-R1-botones-04: si falla la carga de otro rango, el error queda ENCIMA de las citas del rango anterior", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirAgenda(page, iniciarSesion);
    vigilante.permitirRespuesta5xx(/\/appointments\?/);
    await mock.inyectarFalla({ metodo: "GET", ruta: "/appointments?", status: 503, veces: 1 });
    await page.getByRole("button", { name: "Siguiente" }).click();
    await expect(page.locator("main").getByText("No se pudo cargar la información")).toBeVisible();
    // La etiqueta ya dice el mes siguiente, pero las tarjetas del mes actual siguen ahi como si fueran del nuevo rango.
    await expect(tarjeta(page, "Limpieza dental")).toHaveCount(0);
  });

  test("QA-citas-R1-botones-05: una cita de la noche (despues de las 18:00 de Merida) se agrupa bajo el dia equivocado", async ({ page, iniciarSesion, mock }) => {
    test.fail(!process.env.QA_SIN_FAIL, "QA-citas-R1-botones-05: groupByDay usa startsAt.slice(0,10) (dia UTC) y el encabezado usa el dia local de la primera cita");
    await abrirAgenda(page, iniciarSesion);
    const hoy = fechaMerida(0);
    const mes = hoy.slice(0, 7);
    // Dia 20 a las 19:30 de Merida (= dia 21 01:30 UTC) y dia 21 a las 09:00 de Merida.
    const dia20 = `${mes}-20`;
    const dia21 = `${mes}-21`;
    await mock.agregarAEstado(CLAVE_CITAS(), citaExtra("apt-noche", enMerida(dia20, "19:30"), 45, "Cita Nocturna"));
    await mock.agregarAEstado(CLAVE_CITAS(), citaExtra("apt-manana", enMerida(dia21, "09:00"), 45, "Cita Matutina"));
    await page.reload();
    const encabezado21 = new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: ZONA_NEGOCIO }).format(new Date(enMerida(dia21, "09:00")));
    const seccion21 = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: encabezado21 }) });
    await expect(seccion21).toContainText("Cita Matutina");
    await expect(seccion21).not.toContainText("Cita Nocturna");
  });

  test("QA-citas-R1-botones-06: el rango del mes se pide en medianoche UTC: la noche del ultimo dia del mes no aparece en su mes", async ({ page, iniciarSesion, mock }) => {
    test.fail(!process.env.QA_SIN_FAIL, "QA-citas-R1-botones-06: computeRange manda from/to a las 00:00 UTC (18:00 de Merida del dia anterior), no a la medianoche del negocio");
    await abrirAgenda(page, iniciarSesion);
    await mock.agregarAEstado("citas.qa.banderas", "rango");
    const hoy = fechaMerida(0);
    const [y, m] = hoy.split("-").map(Number) as [number, number];
    const ultimo = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    await mock.agregarAEstado(CLAVE_CITAS(), citaExtra("apt-fin-de-mes", enMerida(ultimo, "19:00"), 45, "Ultima Del Mes"));
    await page.reload();
    await expect(tarjeta(page, "Revision de ortodoncia")).toBeVisible();
    await expect(tarjeta(page, "Ultima Del Mes")).toBeVisible({ timeout: 3_000 });
  });

  test("lista de espera: filtro por servicio, Volver/Escape no avisan y confirmar encola el aviso real", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirAgenda(page, iniciarSesion);
    const tabla = page.getByRole("table").filter({ hasText: "Lucia Pool" });
    await expect(tabla).toContainText("Jorge Ek");
    await expect(tabla).toContainText("ya avisado 1x");
    const avisar = page.getByRole("button", { name: "Avisar a la lista de espera" });
    await afirmarCancelarNoEscribe(page, mock, avisar, { nombre: "¿Avisar a la lista de espera?", botonCancelar: "Volver", verificarFoco: false });

    await page.getByLabel("Filtrar la lista de espera por servicio").selectOption("srv-1");
    await expect(page.getByText("Jorge Ek")).toHaveCount(0);
    await avisar.click();
    await dialogo(page, "¿Avisar a la lista de espera?").getByRole("button", { name: "Enviar aviso" }).click();
    await expect(page.getByText("Aviso encolado para 1 candidato considerado; se procesa en segundo plano.")).toBeVisible();
    const avisos = await mock.buscar({ metodo: "POST", ruta: "/waitlist/broadcast" });
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.cuerpo).toMatchObject({ service_id: "srv-1" });
    await expect(page.getByText("ya avisado 1x")).toBeVisible();
    vigilante.verificar();
  });

  test("lista de espera vacia: el boton de avisar queda deshabilitado y se explica el vacio", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirAgenda(page, iniciarSesion);
    await page.getByLabel("Filtrar por proveedor").selectOption("prv-1");
    await page.getByLabel("Filtrar la lista de espera por servicio").selectOption("srv-2");
    await expect(page.getByText("Nadie está esperando con estos filtros.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Avisar a la lista de espera" })).toBeDisabled();
    expect(await mock.buscar({ metodo: "POST", ruta: "/waitlist/broadcast" })).toHaveLength(0);
    vigilante.verificar();
  });

  test("Reintentar sincronizacion solo aparece en una cita 'invalid' y hace su POST", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirAgenda(page, iniciarSesion);
    await mock.agregarAEstado(CLAVE_CITAS(), citaExtra("apt-sync", enMerida(fechaMerida(1), "13:00"), 45, "Sin Correo", { google_sync_status: "invalid", google_sync_error: "Cal.com exige el correo del cliente" }));
    await page.reload();
    const cita = tarjeta(page, "Sin Correo");
    await expect(cita).toContainText("No sincronizada: Cal.com exige el correo del cliente");
    await expect(tarjeta(page, "Ana Lilia Pech").getByRole("button", { name: "Reintentar sincronización" })).toHaveCount(0);
    await cita.getByRole("button", { name: "Reintentar sincronización" }).click();
    await expect(cita.getByRole("button", { name: "Reintentar sincronización" })).toHaveCount(0);
    expect(await mock.buscar({ metodo: "POST", ruta: "/appointments/apt-sync/retry-sync" })).toHaveLength(1);
    vigilante.verificar();
  });

  test("staff tambien opera la agenda (no es una pantalla solo de dueno)", async ({ page, iniciarSesion, vigilante }) => {
    await abrirAgenda(page, iniciarSesion, "staff");
    await expect(page.getByRole("button", { name: "Nueva cita" })).toBeEnabled();
    vigilante.verificar();
  });
});

test.describe("citas QA R1 botones: agenda con el navegador en otra zona horaria", () => {
  // El staff abre el panel desde un navegador en Tijuana (UTC-7 en octubre); el negocio esta en Merida (UTC-6).
  test.use({ timezoneId: "America/Tijuana" });

  test("QA-citas-R1-botones-07: Nueva cita interpreta la hora en la zona del navegador y no en la del negocio", async ({ page, iniciarSesion, mock }) => {
    test.fail(!process.env.QA_SIN_FAIL, "QA-citas-R1-botones-07: Agenda.tsx manda new Date(datetime-local).toISOString() (zona del navegador); el negocio tiene su propia zona");
    await abrirAgenda(page, iniciarSesion);
    const fecha = fechaMerida(3);
    const d = await abrirDialogo(page, page.getByRole("button", { name: "Nueva cita" }), "Nueva cita");
    await d.getByLabel("Proveedor").selectOption("prv-1");
    await d.getByLabel("Servicio").selectOption("srv-1");
    await d.getByLabel("Fecha y hora").fill(`${fecha}T10:00`);
    await d.getByLabel("Nombre del cliente").fill("Hora Del Negocio");
    await d.getByLabel("Teléfono").fill("+529995550263");
    await d.getByRole("button", { name: "Crear cita" }).click();
    await expect(d).toBeHidden();
    const post = (await mock.buscar({ metodo: "POST", ruta: /\/appointments$/ }))[0]!;
    expect((post.cuerpo as { starts_at: string }).starts_at).toBe(enMerida(fecha, "10:00"));
  });

  test("QA-citas-R1-botones-07b: la agenda pinta las horas en la zona del navegador y no en la del negocio", async ({ page, iniciarSesion, mock }) => {
    test.fail(!process.env.QA_SIN_FAIL, "QA-citas-R1-botones-07: formatTimeRange/formatDateLong de lib/format.ts no fijan la zona del negocio");
    await abrirAgenda(page, iniciarSesion);
    await mock.agregarAEstado(CLAVE_CITAS(), citaExtra("apt-hora", enMerida(fechaMerida(2), "10:00"), 30, "Hora Exacta"));
    await page.reload();
    await expect(tarjeta(page, "Hora Exacta")).toContainText(/10:00/);
  });
});
