// QA adversarial ronda 2 (lente botones y paginas) -- Pedidos de restaurantes: el corazon del flujo de PM (pedido entra -> cocina -> repartidor ->
// entrega -> cierre). Cada control se ejerce contra la API simulada y se afirma sobre el REGISTRO de peticiones: carreras de pestanas, pedido que
// llega antes del primer sondeo, doble clic, dialogos que no deben escribir con Cancelar/Escape, reglas del autopiloto y aprobaciones.
// Los defectos R2-01..08 estaban como `test.fail`; se corrigieron y estas pruebas son su regresion (fallan sin el arreglo).
import type { Page } from "@playwright/test";
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { BASE, afirmarSinEscrituras, cuerpoDe, esperarEscrituras, ir } from "../../helpers/recorrido.ts";
import { propiedadDe } from "../../mock-api/personas.ts";

const main = (page: Page) => page.locator("main#contenido-principal");
const tarjeta = (page: Page, nombre: string) => main(page).locator("[class*=card]").filter({ hasText: nombre }).first();
const PROP = propiedadDe("restaurantes");

function pedido(id: string, cliente: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    propertyId: PROP.id,
    branch: PROP.nombre,
    customerId: `cli-${id}`,
    customerName: cliente,
    customerPhone: "+529995550199",
    customerAddress: "Calle 59 #500, Centro",
    total: 210,
    status,
    items: [{ id: "p-1", name: "Tacos al pastor (orden)", price: 95, quantity: 2 }],
    source: "whatsapp",
    notes: null,
    paymentMethod: "efectivo",
    createdAt: new Date().toISOString(),
    assignedRepartidorId: null,
    estimatedDeliveryAt: null,
    incidentNote: null,
    canal: "domicilio",
    propina: null,
    horaRecogida: null,
    ...extra,
  };
}

test.describe("restaurantes R2 botones: Pedidos @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("R1-botones-01 (verifica cierre): la respuesta lenta de Todos no pisa la pestana Preparando", async ({ page, mock, vigilante }) => {
    await mock.inyectarFalla({ metodo: "GET", ruta: "status=en_camino", status: 200, retrasoMs: 2500, veces: 1, cuerpo: { orders: [pedido("ord-lento", "Pedro Lento", "en_camino")], nextCursor: null } });
    await page.goto(`${BASE}/pedidos`);
    await main(page).getByRole("tab", { name: "Preparando" }).click();
    await expect(main(page).getByText("Jorge Canul", { exact: false })).toBeVisible();
    // La respuesta lenta de "Todos" ya llego al navegador (la registra el mock al responder).
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "status=en_camino" })).filter((r) => r.inyectada).length, { timeout: 8000 }).toBe(1);
    await expect(main(page).getByRole("tab", { name: "Preparando" })).toHaveAttribute("aria-selected", "true");
    await expect(main(page).getByText("Pedro Lento")).toHaveCount(0);
    vigilante.verificar();
  });

  test("R1-botones-02 (verifica cierre): un pedido que entra antes del primer sondeo aparece con Actualizar ahora y cuenta como nuevo", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    await expect(tarjeta(page, "Marisol Pech")).toBeVisible();
    await mock.agregarAEstado("rest.ordenes", pedido("ord-nuevo-1", "Cliente Nuevo WhatsApp", "pending"));
    await main(page).getByRole("button", { name: "Actualizar ahora" }).click();
    await expect(main(page).getByText("Cliente Nuevo WhatsApp", { exact: false })).toBeVisible();
    await expect(main(page).getByTestId("aviso-nuevos")).toHaveText(/1 pedido nuevo/);
    vigilante.verificar();
  });

  test("QA-R2-botones-01: al cambiar de pestana y fallar la carga, NO se quedan los pedidos de la pestana anterior", async ({ page, mock, vigilante }) => {
    vigilante.permitirRespuesta5xx(/status=en_camino/);
    await ir(page, "/pedidos");
    await expect(tarjeta(page, "Marisol Pech")).toBeVisible();
    await mock.inyectarFalla({ metodo: "GET", ruta: "status=en_camino", status: 503 });
    await main(page).getByRole("tab", { name: "En camino" }).click();
    await expect(main(page).getByRole("alert").filter({ has: page.getByRole("button", { name: "Reintentar" }) })).toBeVisible();
    // La semilla no tiene pedidos "En camino": nada de lo que se ve aqui puede ser de esta pestana.
    await expect(main(page).getByText("Marisol Pech")).toHaveCount(0);
    await expect(main(page).getByRole("button", { name: "Marcar Preparando" })).toHaveCount(0);
  });

  test("doble clic en Marcar Preparando manda UN solo PATCH", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    await expect(tarjeta(page, "Marisol Pech")).toBeVisible();
    await mock.configurar({ latenciaMs: 600 });
    await mock.limpiarRegistro();
    await tarjeta(page, "Marisol Pech").getByRole("button", { name: "Marcar Preparando" }).dblclick();
    await expect(main(page).getByRole("button", { name: "Marcar En camino" })).toBeVisible();
    const parches = await mock.buscar({ metodo: "PATCH", ruta: "/status" });
    expect(parches, "un doble clic no debe repetir la transicion").toHaveLength(1);
    expect(cuerpoDe(parches[0])).toMatchObject({ status: "preparando" });
    vigilante.verificar();
  });

  test("Cancelar pedido: Volver, Escape y clic fuera no hacen PATCH; el motivo es obligatorio", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    const boton = tarjeta(page, "Marisol Pech").getByRole("button", { name: "Marcar Cancelado" });
    await mock.limpiarRegistro();
    // Volver
    await boton.click();
    let d = dialogo(page, "Cancelar pedido");
    await expect(d).toBeVisible();
    await d.getByRole("button", { name: "Volver" }).click();
    await expect(d).toBeHidden();
    // Escape
    await boton.click();
    d = dialogo(page, "Cancelar pedido");
    await expect(d).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    // Clic fuera (esquina de la pantalla, sobre el velo)
    await boton.click();
    d = dialogo(page, "Cancelar pedido");
    await expect(d).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(d).toBeHidden();
    await afirmarSinEscrituras(mock, "Cancelar pedido cerrado por Volver/Escape/clic fuera");
    // Elegir un motivo y luego Volver tampoco escribe; al reabrir el motivo vuelve a estar vacio.
    await boton.click();
    d = dialogo(page, "Cancelar pedido");
    await d.getByRole("combobox").selectOption("duplicado");
    await d.getByRole("button", { name: "Volver" }).click();
    await boton.click();
    d = dialogo(page, "Cancelar pedido");
    await expect(d.getByRole("button", { name: "Cancelar el pedido" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await afirmarSinEscrituras(mock, "Cancelar pedido con motivo elegido y Volver");
    vigilante.verificar();
  });

  test("Cancelar pedido con error del servidor: el dialogo queda abierto con el error y Reintentar no duplica", async ({ page, mock, vigilante }) => {
    vigilante.permitirRespuesta5xx(/\/status/);
    await ir(page, "/pedidos");
    await mock.inyectarFalla({ metodo: "PATCH", ruta: "/status", status: 503, veces: 1 });
    await tarjeta(page, "Marisol Pech").getByRole("button", { name: "Marcar Cancelado" }).click();
    const d = dialogo(page, "Cancelar pedido");
    await d.getByRole("combobox").selectOption("cliente_desistio");
    await d.getByRole("button", { name: "Cancelar el pedido" }).click();
    await expect(d).toBeVisible();
    await expect(d.getByText(/Falla inyectada 503|no se pudo/i)).toBeVisible();
    await d.getByRole("button", { name: "Cancelar el pedido" }).click();
    await expect(d).toBeHidden();
    const parches = await mock.buscar({ metodo: "PATCH", ruta: "/status" });
    expect(parches.map((p) => p.status)).toEqual([503, 200]);
    vigilante.verificar();
  });

  test("Historial del pedido: abre el registro de transiciones y Cerrar/Escape no escriben", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    await mock.limpiarRegistro();
    await tarjeta(page, "Marisol Pech").getByRole("button", { name: "Historial", exact: true }).click();
    const d = dialogo(page);
    await expect(d).toBeVisible();
    await expect(d.getByText(/Recibido/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    await afirmarSinEscrituras(mock, "Historial del pedido");
    expect((await mock.buscar({ metodo: "GET", ruta: "/historial" })).length).toBe(1);
    vigilante.verificar();
  });

  test("Imprimir ticket marca el pedido como impreso (Reimprimir) sin escribir al servidor; Vista previa se cierra con Escape", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    await mock.limpiarRegistro();
    const t = tarjeta(page, "Marisol Pech");
    await t.getByRole("button", { name: "Vista previa" }).click();
    const d = dialogo(page);
    await expect(d).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    await t.getByRole("button", { name: "Imprimir ticket" }).click();
    await expect(t.getByRole("button", { name: "Reimprimir ticket" })).toBeVisible();
    await afirmarSinEscrituras(mock, "imprimir ticket");
    vigilante.verificar();
  });

  test("Reglas del autopiloto: Cancelar/Escape no guardan; un valor fuera de rango no llega al servidor; Guardar hace UN PUT", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    const abrir = main(page).getByRole("button", { name: "Reglas del autopiloto" });
    await mock.limpiarRegistro();
    await abrir.click();
    let d = dialogo(page, "Reglas del autopiloto");
    await expect(d).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    await abrir.click();
    d = dialogo(page, "Reglas del autopiloto");
    await d.getByRole("button", { name: /Cancelar|Cerrar|Volver/ }).first().click();
    await expect(d).toBeHidden();
    await afirmarSinEscrituras(mock, "Reglas del autopiloto cerradas sin guardar");

    await abrir.click();
    d = dialogo(page, "Reglas del autopiloto");
    const primerNumero = d.locator("input[type=number], input[inputmode=numeric]").first();
    await primerNumero.fill("0");
    await d.getByRole("button", { name: /Guardar/ }).click();
    await expect(d).toBeVisible();
    await afirmarSinEscrituras(mock, "valor fuera de rango");
    await primerNumero.fill("10");
    await d.getByRole("button", { name: /Guardar/ }).click();
    await expect(d).toBeHidden();
    await esperarEscrituras(mock, { metodo: "PUT", ruta: "/autopiloto/config" }, 1);
    vigilante.verificar();
  });

  test("QA-R2-botones-02: si la carga de las reglas del autopiloto falla, el dialogo NO se queda en 'Cargando reglas…' para siempre", async ({ page, mock, vigilante }) => {
    vigilante.permitirRespuesta5xx(/autopiloto\/config/);
    await mock.inyectarFalla({ metodo: "GET", ruta: "/autopiloto/config", status: 503 });
    await ir(page, "/pedidos");
    await expect(tarjeta(page, "Marisol Pech")).toBeVisible();
    await main(page).getByRole("button", { name: "Reglas del autopiloto" }).click();
    const d = dialogo(page, "Reglas del autopiloto");
    await expect(d).toBeVisible();
    await expect(d.getByRole("button", { name: "Reintentar" }), "una falla de carga debe ofrecer Reintentar").toBeVisible({ timeout: 4000 });
  });

  test("Por aprobar: compensacion y cancelacion -- Reponer/Descuento/Cancelar con Escape o Volver no resuelven; Descuento y Mantener mandan UNA resolucion", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    await expect(main(page).getByTestId("insignia-por-aprobar")).toHaveText("1");
    const base = { propertyId: PROP.id, estado: "pendiente", decision: null, motivoResolucion: null, codigoDescuento: null, solicitadaAt: new Date(Date.now() - 3 * 60_000).toISOString(), escaladaAt: null, resueltaAt: null };
    await mock.agregarAEstado("rest.autopiloto.solicitudes", { ...base, id: "5a000000-0000-4000-8000-0000000000c1", tipo: "compensacion", orderId: "ord-0999", detalle: { subtipo: "frio" }, pedido: { numero: 999, total: 143, status: "entregado", clienteNombre: "Queja Frio", canal: "domicilio", renglones: [{ indice: 0, nombre: "Tacos al pastor (orden)", cantidad: 1 }, { indice: 1, nombre: "Horchata", cantidad: 1 }] }, decisionesPosibles: ["sin_compensacion", "reponer_producto", "descuento_proximo"] });
    await mock.agregarAEstado("rest.autopiloto.solicitudes", { ...base, id: "5a000000-0000-4000-8000-0000000000c2", tipo: "cancelacion", orderId: "ord-1002", detalle: {}, pedido: { numero: 1002, total: 190, status: "preparando", clienteNombre: "Cancela Cocina", canal: "recoger", renglones: [{ indice: 0, nombre: "Cochinita pibil (torta)", cantidad: 2 }] }, decisionesPosibles: ["cancelar", "mantener"] });
    await main(page).getByRole("tab", { name: /Por aprobar/ }).click();
    const queja = main(page).getByTestId("solicitud-5a000000-0000-4000-8000-0000000000c1");
    const cancela = main(page).getByTestId("solicitud-5a000000-0000-4000-8000-0000000000c2");
    await expect(queja).toContainText("Queja Frio");
    await expect(main(page).getByTestId("insignia-por-aprobar")).toHaveText("3");
    await mock.limpiarRegistro();

    await queja.getByRole("button", { name: "Reponer producto" }).click();
    let d = dialogo(page, "Reponer producto");
    await expect(d.getByRole("button", { name: "Reponer sin costo" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    await queja.getByRole("button", { name: "Descuento en el próximo pedido" }).click();
    d = dialogo(page, "Descuento en el próximo pedido");
    await d.getByRole("button", { name: /Cancelar|Volver|Cerrar/ }).first().click();
    await expect(d).toBeHidden();
    await cancela.getByRole("button", { name: "Cancelar el pedido" }).click();
    d = dialogo(page, "Cancelar el pedido");
    await d.getByRole("button", { name: "Volver" }).click();
    await expect(d).toBeHidden();
    await afirmarSinEscrituras(mock, "dialogos de aprobaciones cerrados sin decidir");

    await queja.getByRole("button", { name: "Descuento en el próximo pedido" }).click();
    d = dialogo(page, "Descuento en el próximo pedido");
    await d.getByRole("button", { name: "Enviar código" }).click();
    await expect(d).toBeHidden();
    await cancela.getByRole("button", { name: "Mantener el pedido" }).dblclick();
    await expect(cancela).toHaveCount(0);
    const resoluciones = await mock.buscar({ metodo: "POST", ruta: "/resolver" });
    expect(resoluciones.map((r) => cuerpoDe(r))).toEqual([{ decision: "descuento_proximo", valor: 10 }, { decision: "mantener" }]);
    await expect(main(page).getByTestId("insignia-por-aprobar")).toHaveText("1");
    vigilante.verificar();
  });

  test("PM de punta a punta en el panel: pedido nuevo -> Preparando -> repartidor -> En camino -> Entregado -> Historial lo cierra (Completado)", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    await expect(tarjeta(page, "Marisol Pech")).toBeVisible();
    await mock.agregarAEstado("rest.ordenes", pedido("ord-e2e-1", "Viaje Completo", "pending"));
    await main(page).getByRole("button", { name: "Actualizar ahora" }).click();
    const t = tarjeta(page, "Viaje Completo");
    await expect(t).toBeVisible();
    await t.getByRole("button", { name: "Marcar Preparando" }).click();
    await expect(t.getByRole("button", { name: "Marcar En camino" })).toBeVisible();
    await t.getByLabel("Repartidor:").selectOption({ label: "Ramon Uc" });
    await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/ord-e2e-1/assign-repartidor" }, 1);
    await t.getByRole("button", { name: "Marcar En camino" }).click();
    await expect(t.getByRole("button", { name: "Marcar Entregado" })).toBeVisible();
    await t.getByRole("button", { name: "Marcar Entregado" }).click();
    // Entregado ya no es un estado operativo: sale de Pedidos y se cierra desde Historial.
    await expect(main(page).getByText("Viaje Completo")).toHaveCount(0);
    await ir(page, "/historial");
    const fila = main(page).getByRole("row").or(main(page).getByRole("listitem")).filter({ hasText: "Viaje Completo" });
    await expect(fila).toContainText("Entregado");
    await fila.getByRole("button", { name: "Cerrar (completado)" }).click();
    await expect(fila).toContainText("Completado");
    const estados = (await mock.buscar({ metodo: "PATCH", ruta: "/ord-e2e-1/status" })).map((p) => cuerpoDe(p)["status"]);
    expect(estados).toEqual(["preparando", "en_camino", "entregado", "completado"]);
    vigilante.verificar();
  });
});
