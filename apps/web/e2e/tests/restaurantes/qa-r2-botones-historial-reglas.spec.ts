// QA adversarial ronda 2 (lente botones) -- verificacion con evidencia de los defectos de la ronda 1 en Historial (R1-06/07) y en Reglas de
// pedido de la sucursal (R1-12..16), mas el cierre administrativo de un pedido entregado desde Historial. Contra la API simulada.
import type { Page } from "@playwright/test";
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarSinEscrituras, cuerpoDe, esperarEscrituras, ir } from "../../helpers/recorrido.ts";
import { propiedadDe } from "../../mock-api/personas.ts";
import { elegirValor } from "../../helpers/listas.ts";

const main = (page: Page) => page.locator("main#contenido-principal");
// DataTable: tabla en escritorio, lista de tarjetas (listitem) en movil.
const fila = (page: Page, texto: string) => main(page).getByRole("row").or(main(page).getByRole("listitem")).filter({ hasText: texto });
const PROP = propiedadDe("restaurantes");

async function abrirReglas(page: Page) {
  await ir(page, "/sucursales");
  await main(page).getByRole("button", { name: "Reglas de pedido" }).first().click();
  await expect(main(page).getByRole("button", { name: "Guardar reglas" })).toBeVisible();
}

test.describe("restaurantes R2 botones: Historial y Reglas de pedido @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("R1-botones-06 (verifica cierre): si falla el filtro nuevo, no quedan las filas del filtro anterior", async ({ page, mock, vigilante }) => {
    vigilante.permitirRespuesta5xx(/status=cancelado/);
    await ir(page, "/historial");
    await expect(fila(page, "Marisol Pech").first()).toBeVisible();
    await mock.inyectarFalla({ metodo: "GET", ruta: "status=cancelado", status: 503 });
    await elegirValor(main(page).getByLabel("Estado"), "cancelado");
    await expect(main(page).getByRole("alert").filter({ has: page.getByRole("button", { name: "Reintentar" }) })).toBeVisible();
    await expect(fila(page, "Marisol Pech")).toHaveCount(0);
  });

  test("R1-botones-07 (verifica cierre): la respuesta lenta de Completado no pisa el filtro Preparando", async ({ page, mock, vigilante }) => {
    await ir(page, "/historial");
    await expect(fila(page, "Marisol Pech").first()).toBeVisible();
    await mock.inyectarFalla({ metodo: "GET", ruta: "status=completado", status: 200, retrasoMs: 2500, veces: 1, cuerpo: { orders: [{ id: "ord-viejo", propertyId: PROP.id, branch: PROP.nombre, customerId: "c", customerName: "Fila Vieja Completado", customerPhone: "+529995550111", customerAddress: null, total: 99, status: "completado", items: [], source: "web", notes: null, paymentMethod: "efectivo", createdAt: "2026-09-28T18:00:00.000Z", assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null }], nextCursor: null } });
    await elegirValor(main(page).getByLabel("Estado"), "completado");
    await elegirValor(main(page).getByLabel("Estado"), "preparando");
    await expect(fila(page, "Jorge Canul")).toBeVisible();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "status=completado" })).filter((r) => r.inyectada).length, { timeout: 8000 }).toBe(1);
    await expect(fila(page, "Fila Vieja Completado")).toHaveCount(0);
    vigilante.verificar();
  });

  test("Historial: Registrar incidencia con Volver/Escape no escribe; con nota hace UN PATCH a Incidencia", async ({ page, mock, vigilante }) => {
    // Siembra un pedido entregado (la semilla no tiene) y abre Historial.
    await ir(page, "/historial");
    await mock.agregarAEstado("rest.ordenes", { id: "ord-ent-1", propertyId: PROP.id, branch: PROP.nombre, customerId: "c9", customerName: "Entregado Queja", customerPhone: "+529995550120", customerAddress: "Calle 1", total: 150, status: "entregado", items: [], source: "whatsapp", notes: null, paymentMethod: "efectivo", createdAt: new Date().toISOString(), assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null, canal: "domicilio", propina: null, horaRecogida: null });
    await elegirValor(main(page).getByLabel("Estado"), "entregado");
    const filaQueja = fila(page, "Entregado Queja");
    await expect(filaQueja).toBeVisible();
    await mock.limpiarRegistro();
    await filaQueja.getByRole("button", { name: "Registrar incidencia" }).click();
    let d = dialogo(page);
    await d.getByRole("button", { name: "Volver" }).click();
    await expect(d).toBeHidden();
    await filaQueja.getByRole("button", { name: "Registrar incidencia" }).click();
    d = dialogo(page);
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    await afirmarSinEscrituras(mock, "Registrar incidencia cancelado");
    await filaQueja.getByRole("button", { name: "Registrar incidencia" }).click();
    d = dialogo(page);
    await d.getByRole("textbox").fill("Faltó una horchata");
    await d.getByRole("button", { name: "Registrar incidencia" }).click();
    const [p] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/ord-ent-1/status" }, 1);
    expect(cuerpoDe(p)).toMatchObject({ status: "problema", incidentNote: "Faltó una horchata" });
    vigilante.verificar();
  });

  test("R1-botones-12/13 (verifica cierre): guardado a medias lo dice y Reintentar repite SOLO las zonas", async ({ page, mock, vigilante }) => {
    vigilante.permitirRespuesta5xx(/zonas-reparto/);
    await abrirReglas(page);
    await main(page).getByLabel("Pedido mínimo a domicilio", { exact: false }).fill("150");
    await mock.limpiarRegistro();
    await mock.inyectarFalla({ metodo: "PUT", ruta: "zonas-reparto", status: 503, veces: 1 });
    await main(page).getByRole("button", { name: "Guardar reglas" }).click();
    const alerta = main(page).getByRole("alert").filter({ hasText: /sí se guardaron/ });
    await expect(alerta).toBeVisible();
    await alerta.getByRole("button", { name: "Reintentar" }).click();
    await expect(alerta).toHaveCount(0);
    expect((await mock.buscar({ metodo: "PUT", ruta: "/politica" })).length, "Reintentar no repite la politica ya guardada").toBe(1);
    expect((await mock.buscar({ metodo: "PUT", ruta: "zonas-reparto" })).map((r) => r.status)).toEqual([503, 200]);
    vigilante.verificar();
  });

  test("R1-botones-14/15 (verifica cierre): puente con Hasta < Desde no se manda; Quitar pide confirmacion y Cancelar no borra", async ({ page, mock, vigilante }) => {
    await abrirReglas(page);
    await mock.limpiarRegistro();
    await main(page).getByLabel("Desde").last().fill("2026-11-16");
    await main(page).getByLabel("Hasta").last().fill("2026-11-14");
    await main(page).getByLabel("Turno 1 (abre / cierra)").fill("08:00");
    await main(page).getByLabel("Cierre del turno 1").fill("23:00");
    await main(page).getByRole("button", { name: "Guardar puente" }).click();
    await expect(main(page).getByText(/no sea anterior a la inicial/)).toBeVisible();
    await afirmarSinEscrituras(mock, "puente con fechas invertidas");

    await main(page).getByLabel("Hasta").last().fill("2026-11-17");
    await main(page).getByRole("button", { name: "Guardar puente" }).click();
    await esperarEscrituras(mock, { metodo: "POST", ruta: "/config/puentes" }, 1);
    const quitar = main(page).getByTestId(`puentes-${PROP.id}`).getByRole("button", { name: "Quitar", exact: true });
    await expect(quitar).toBeVisible();
    await mock.limpiarRegistro();
    await quitar.click();
    let d = dialogo(page, "Quitar el puente");
    await d.getByRole("button", { name: /Cancelar|Volver/ }).click();
    await expect(d).toBeHidden();
    await quitar.click();
    d = dialogo(page, "Quitar el puente");
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    await afirmarSinEscrituras(mock, "Quitar puente cancelado");
    await quitar.click();
    await dialogo(page, "Quitar el puente").getByRole("button", { name: "Quitar puente" }).click();
    await esperarEscrituras(mock, { metodo: "DELETE", ruta: "/config/puentes/" }, 1);
    await expect(quitar).toHaveCount(0);
    vigilante.verificar();
  });

  test("R1-botones-16 (verifica cierre): vaciar el WhatsApp de la sucursal pide confirmacion; Cancelar no lo desconecta", async ({ page, mock, vigilante }) => {
    await abrirReglas(page);
    const campo = main(page).getByLabel("WhatsApp de esta sucursal (phone_number_id de Meta)");
    await campo.fill("1234567890");
    await main(page).getByRole("button", { name: "Guardar número" }).click();
    await esperarEscrituras(mock, { metodo: "PUT", ruta: "/whatsapp" }, 1);
    await mock.limpiarRegistro();
    await campo.fill("");
    await main(page).getByRole("button", { name: "Guardar número" }).click();
    const d = dialogo(page);
    await expect(d).toBeVisible();
    await d.getByRole("button", { name: /Cancelar|Volver/ }).click();
    await expect(d).toBeHidden();
    await afirmarSinEscrituras(mock, "desconectar WhatsApp cancelado");
    vigilante.verificar();
  });
});
