// H-42: reserva directa PUBLICA del hotel (/hoteles/:orgSlug/reservar), sin sesion y sin menu de panel, contra la API simulada de e2e: flujo
// buscar -> cotizar -> reservar (pago pendiente honesto), estado y cancelacion por token, ultima habitacion (409) y hotel inexistente. El estado se
// aisla por slug (cada prueba usa un slug unico).
import { ClienteMock } from "../mock-api/cliente.ts";
import { afirmarSinScrollHorizontal, afirmarUnSoloMain } from "../helpers/ds.ts";
import { expect, test, URL_API } from "../helpers/fixtures.ts";
import type { Page } from "../helpers/fixtures.ts";

const SLUG_BASE = "hotel-casa-azul";
const slugUnico = (info: { workerIndex: number; testId: string }) => `${SLUG_BASE}--w${info.workerIndex}${info.testId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 10)}${Math.random().toString(36).slice(2, 6)}`;

async function hastaCotizacion(page: Page, slug: string) {
  await page.goto(`/hoteles/${slug}/reservar`);
  await expect(page.getByRole("heading", { name: "Reserva directa" })).toBeVisible();
  await page.getByRole("button", { name: "Ver disponibilidad" }).click();
  await page.getByRole("button", { name: "Cotizar" }).click();
  await expect(page.getByRole("button", { name: "Reservar", exact: true })).toBeVisible();
}
async function llenar(page: Page) {
  await page.getByLabel("Nombre completo").fill("Ana Prueba");
  await page.getByLabel("Teléfono").fill("999 123 4567");
  await page.getByLabel("Correo").fill("ana@example.com");
  await page.getByRole("checkbox").check();
}

test.describe("reserva publica de hoteles @humo", () => {
  test("flujo completo sin menu de panel: cotiza, reserva con pago pendiente y la reserva queda consultable por su enlace", async ({ page, vigilante }, info) => {
    const slug = slugUnico(info);
    await hastaCotizacion(page, slug);
    await afirmarUnSoloMain(page);
    await afirmarSinScrollHorizontal(page);
    await expect(page.locator("nav, aside")).toHaveCount(0);
    await expect(page.getByText("pago pendiente")).toBeVisible();
    await llenar(page);
    await page.getByRole("button", { name: "Reservar", exact: true }).click();

    await expect(page.getByText("Reserva apartada")).toBeVisible();
    await expect(page.getByText("El hotel te contactará para registrar tu anticipo.")).toBeVisible();
    const enlace = page.getByRole("link", { name: new RegExp(`/hoteles/${slug}/reservar/estado/`) });
    await expect(enlace).toBeVisible();
    await afirmarSinScrollHorizontal(page);

    const anon = new ClienteMock(URL_API, "anon");
    const envios = (await anon.buscar({ metodo: "POST", ruta: `/v1/hoteles/${slug}/reservar/confirmar` })).filter((p) => p.status === 202);
    expect(envios).toHaveLength(1);
    expect(envios[0]!.cuerpo).toMatchObject({ consentimientoAviso: true, huesped: { nombre: "Ana Prueba" } });

    await enlace.click();
    await expect(page.getByRole("heading", { name: "Tu reserva" })).toBeVisible();
    await expect(page.getByText("Pago pendiente")).toBeVisible();
    await page.getByRole("button", { name: "Cancelar reserva" }).click();
    await page.getByRole("button", { name: "Sí, cancelar" }).click();
    await expect(page.getByText("Cancelación registrada")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancelar reserva" })).toHaveCount(0);
    vigilante.verificar();
  });

  test("la ultima habitacion: si otra persona la toma antes de confirmar, 409 y la pagina pide cotizar de nuevo", async ({ page, request, vigilante }, info) => {
    const slug = slugUnico(info);
    await hastaCotizacion(page, slug);
    await llenar(page);
    const q = (await (await request.post(`${URL_API}/v1/hoteles/${slug}/reservar/cotizacion`, { data: { llegada: "2026-12-10", salida: "2026-12-11", huespedes: 2, tipoHabitacionId: "11111111-1111-4111-8111-111111111111" } })).json()) as { quoteToken: string };
    const ganada = await request.post(`${URL_API}/v1/hoteles/${slug}/reservar/confirmar`, { headers: { "idempotency-key": "otra-persona-123" }, data: { quoteToken: q.quoteToken, consentimientoAviso: true, huesped: { nombre: "Otra Persona", telefono: "9990000000", correo: "otra@example.com" } } });
    expect(ganada.status()).toBe(202);
    await page.getByRole("button", { name: "Reservar", exact: true }).click();
    await expect(page.getByText("Tu cotización cambió o venció")).toBeVisible();
    await expect(page.getByText("Reserva apartada")).toHaveCount(0);
    vigilante.verificar();
  });

  test("enlace de reserva invalido y hotel inexistente: mensajes honestos, sin formulario", async ({ page, vigilante }, info) => {
    const slug = slugUnico(info);
    await page.goto(`/hoteles/${slug}/reservar/estado/no-es-un-token`);
    await expect(page.getByText("No encontramos esa reserva")).toBeVisible();
    await page.goto("/hoteles/no-existe/reservar");
    await expect(page.getByText("No encontramos ese hotel")).toBeVisible();
    await expect(page.locator("form")).toHaveCount(0);
    vigilante.verificar();
  });
});
