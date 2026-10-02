// C-19: reserva publica de citas (/reservar/:orgSlug), sin sesion, contra la API simulada de e2e: flujo completo en escritorio y movil
// (y en oscuro con @oscuro), horario tomado (409) y negocio no listo / inexistente. Las rutas publicas caen en el escenario "anon" del
// mock; el estado de horarios tomados se aisla por slug (cada prueba usa un slug unico).
import { ClienteMock } from "../mock-api/cliente.ts";
import { citas } from "../mock-api/fixtures/citas.ts";
import { afirmarModo, afirmarSinScrollHorizontal, afirmarUnSoloMain } from "../helpers/ds.ts";
import { expect, test, URL_API } from "../helpers/fixtures.ts";
import type { Page } from "../helpers/fixtures.ts";

const slugUnico = (info: { workerIndex: number; testId: string }) => `${citas.orgSlug}--w${info.workerIndex}${info.testId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 10)}${Math.random().toString(36).slice(2, 6)}`;

async function elegirHastaHorario(page: Page, slug: string) {
  await page.goto(`/reservar/${slug}`);
  await expect(page.getByRole("heading", { name: "Reserva tu cita" })).toBeVisible();
  await page.getByRole("button", { name: /Limpieza dental/ }).click();
  await page.getByRole("button", { name: /Cualquiera disponible/ }).click();
  await page.locator("button[aria-pressed][aria-label]").first().click();
  await expect(page.getByRole("group", { name: "Horarios disponibles" })).toBeVisible();
}

async function llenarDatos(page: Page) {
  await page.getByLabel("Nombre", { exact: false }).first().fill("Ana Prueba");
  await page.getByLabel("Teléfono", { exact: false }).fill("999 123 4567");
  await page.getByRole("checkbox").check();
}

test.describe("reserva publica de citas @humo", () => {
  test("flujo completo: servicio, profesional, dia, horario, datos y confirmacion en la zona del negocio @oscuro", async ({ page, vigilante }, info) => {
    const slug = slugUnico(info);
    await elegirHastaHorario(page, slug);
    await afirmarUnSoloMain(page);
    await afirmarSinScrollHorizontal(page);
    await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
    await expect(page.getByText("Horarios en hora de America/Merida.")).toBeVisible();

    await page.getByRole("button", { name: /10:00/ }).click();
    await llenarDatos(page);
    await afirmarSinScrollHorizontal(page);
    await page.getByRole("button", { name: "Confirmar reserva" }).click();

    await expect(page.getByText("¡Tu cita quedó registrada!")).toBeVisible();
    await expect(page.getByText("Limpieza dental")).toBeVisible();
    await expect(page.getByText("America/Merida", { exact: true })).toBeVisible();
    await expect(page.getByText(/10:00/)).toBeVisible();
    await afirmarSinScrollHorizontal(page);

    const anon = new ClienteMock(URL_API, "anon");
    const envios = (await anon.buscar({ metodo: "POST", ruta: `/v1/citas/${slug}/appointments` })).filter((p) => p.status === 201);
    expect(envios).toHaveLength(1);
    expect(envios[0]!.cuerpo).toMatchObject({ source: "web", customer_name: "Ana Prueba", customer_phone: "999 123 4567" });
    vigilante.verificar();
  });

  test("horario tomado por otra persona: 409, la pagina lo explica y recarga los horarios sin ese", async ({ page, request, vigilante }, info) => {
    const slug = slugUnico(info);
    await elegirHastaHorario(page, slug);
    await page.getByRole("button", { name: /10:00/ }).click();
    await llenarDatos(page);

    // Otra persona se queda con el mismo horario justo antes de confirmar.
    const disp = (await (await request.post(`${URL_API}/v1/citas/${slug}/publico/disponibilidad`, { data: { service_id: "srv-1", date: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Merida" }).format(new Date()) } })).json()) as { slots: { starts_at: string }[] };
    const tomado = disp.slots.find((s) => s.starts_at.includes("T16:00:00"));
    expect(tomado).toBeTruthy();
    const ganada = await request.post(`${URL_API}/v1/citas/${slug}/appointments`, { data: { provider_id: "prv-1", service_id: "srv-1", customer_name: "Otra Persona", starts_at: tomado!.starts_at, source: "web" } });
    expect(ganada.status()).toBe(201);

    await page.getByRole("button", { name: "Confirmar reserva" }).click();
    await expect(page.getByText("Ese horario acaba de ocuparse")).toBeVisible();
    await expect(page.getByText("¡Tu cita quedó registrada!")).toHaveCount(0);
    // Los horarios se recargaron y el tomado ya no se ofrece.
    await expect(page.getByRole("button", { name: /10:00/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /10:30/ })).toBeVisible();
    vigilante.verificar();
  });

  test("negocio que aun no esta listo: sin formulario", async ({ page, vigilante }) => {
    await page.goto(`/reservar/${citas.slugNoListo}`);
    await expect(page.getByText("Este negocio aún no recibe reservas en línea")).toBeVisible();
    await expect(page.locator("form")).toHaveCount(0);
    await afirmarUnSoloMain(page);
    vigilante.verificar();
  });

  test("negocio inexistente: 404 honesto", async ({ page, vigilante }) => {
    await page.goto("/reservar/no-existe");
    await expect(page.getByText("No encontramos este negocio")).toBeVisible();
    await expect(page.locator("form")).toHaveCount(0);
    vigilante.verificar();
  });
});
