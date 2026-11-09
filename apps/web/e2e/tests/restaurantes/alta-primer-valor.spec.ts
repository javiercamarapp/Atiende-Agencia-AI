// Alta autoservicio de punta a punta: «tu restaurante listo en 30 minutos». Un dueño nuevo se registra con su correo, abre el enlace,
// entra al panel y recorre la ruta corta de Primer valor (menu -> horario -> zonas -> cobro -> probar agente -> activar) hasta que la
// sucursal queda activa. Contra la API simulada (mock-api/fixtures/restaurantes-alta.ts): cada paso se afirma en la pantalla Y en la
// peticion exacta que recibio el mock; el estimado de minutos baja paso a paso y arranca debajo de 30.
//
// Lo que el mock no representa (ver el encabezado de la fixture): el correo (el enlace se arma con `enlaceDeRegistroSimulado`), la
// organizacion nueva (la cuenta registrada es la persona simulada `restaurantes-owner`, con su sucursal vaciada e inactiva) y el resto
// del panel de una cuenta recien creada (Resumen y Primeros pasos siguen con sus datos de siempre).
import type { Locator, Page } from "@playwright/test";
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test, URL_API } from "../../helpers/fixtures.ts";
import { barraMovil, sidebar } from "../../helpers/navegacion.ts";
import { BASE, cuerpoDe, esperarEscrituras, ir } from "../../helpers/recorrido.ts";
import { ClienteMock } from "../../mock-api/cliente.ts";
import { enlaceDeRegistroSimulado } from "../../mock-api/fixtures/restaurantes-alta.ts";
import { propiedadDe } from "../../mock-api/personas.ts";

const PROP = propiedadDe("restaurantes");
const main = (page: Page) => page.locator("main#contenido-principal");
const pasos = (page: Page) => page.getByTestId("primer-valor-pasos");
const paso = (page: Page, titulo: string): Locator => pasos(page).getByRole("listitem").filter({ hasText: titulo });

/** Vuelve a Primer valor y espera a que el servidor (mock) haya recalculado el avance. */
async function primerValor(page: Page, hechos: number, minutos: number | null): Promise<void> {
  await ir(page, "/primer-valor");
  await expect(pasos(page)).toBeVisible();
  if (minutos === null) {
    await expect(main(page).getByText("¡Listo! Tu sucursal ya atiende por WhatsApp")).toBeVisible();
    return;
  }
  await expect(main(page).getByText(`Altabrisa: ${hechos} de 6 pasos`)).toBeVisible();
  await expect(main(page).getByText(`Te faltan unos ${minutos} minutos para recibir tu primer pedido.`)).toBeVisible();
}

async function irDesdePaso(page: Page, titulo: string, destino: string): Promise<void> {
  await paso(page, titulo).getByRole("link", { name: "Ir a la pantalla" }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}/${destino}$`));
  await expect(page.locator("[data-atiende-carga-ruta]")).toHaveCount(0);
}

test.describe("restaurantes alta autoservicio: primer valor en <30 min @recorrido", () => {
  test("registro -> menu -> horario -> zonas -> cobro -> probar agente -> activar", async ({ page, mock, vigilante }) => {
    test.setTimeout(120_000);
    const correo = `dueno+${mock.escenario}@example.test`;
    const anon = new ClienteMock(URL_API, "anon");

    // ---- 1) Registro. El servidor descarta como bot un formulario llenado en < 3 s: se adelanta el reloj de la pagina en vez de esperar.
    await page.clock.install();
    await page.goto("/restaurantes/registro");
    const form = page.getByRole("form", { name: "Registro de restaurante" });
    await expect(form.getByRole("button", { name: "Recibir enlace para crear mi restaurante" })).toBeEnabled();
    await form.getByLabel("Nombre del restaurante").fill("Cocina de Ana");
    await form.getByLabel("Nombre de tu primera sucursal").fill("Altabrisa");
    await form.getByLabel("Tu nombre").fill("Ana Canul");
    await form.getByLabel("Correo").fill(correo);
    await page.clock.fastForward("00:05");
    await form.getByRole("button", { name: "Recibir enlace para crear mi restaurante" }).click();
    await expect(page.getByRole("heading", { name: "Revisa tu correo" })).toBeVisible();
    const iniciar = (await anon.buscar({ metodo: "POST", ruta: "/auth/registro/restaurantes/iniciar" })).filter((r) => cuerpoDe(r)["correo"] === correo);
    expect(iniciar).toHaveLength(1);
    expect(iniciar[0]!.status).toBe(202);
    expect(cuerpoDe(iniciar[0])).toMatchObject({ metodo: "correo", nombreNegocio: "Cocina de Ana", nombreSucursal: "Altabrisa", nombreCompleto: "Ana Canul", sitioWeb: "" });
    expect(cuerpoDe(iniciar[0])["msLlenado"]).toBeGreaterThanOrEqual(3_000);

    // ---- 2) El enlace del correo: el token viaja en el fragmento y solo el clic lo canjea; el codigo de intercambio abre la sesion.
    await page.goto(enlaceDeRegistroSimulado(correo));
    await page.getByRole("button", { name: "Crear mi restaurante" }).click();
    await page.waitForURL((url) => !url.pathname.includes("/registro") && !url.pathname.includes("/auth/google/callback"), { timeout: 20_000 });
    await sidebar(page).or(barraMovil(page)).first().waitFor({ state: "visible", timeout: 15_000 });
    expect((await anon.buscar({ metodo: "POST", ruta: "/auth/registro/restaurantes/confirmar" })).map((r) => r.status)).toContain(201);
    expect(await mock.buscar({ metodo: "GET", ruta: "/auth/me" })).not.toHaveLength(0);

    // ---- 3) Primeros pasos ofrece la ruta corta; Primer valor arranca en 0 de 6 y < 30 minutos, con «Activar» bloqueado.
    await ir(page, "/primeros-pasos");
    await main(page).getByRole("link", { name: "Empezar" }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/primer-valor$`));
    await expect(main(page).getByText("Altabrisa: 0 de 6 pasos")).toBeVisible();
    await expect(main(page).getByText("Te faltan unos 25 minutos para recibir tu primer pedido.")).toBeVisible();
    await expect(paso(page, "Activa la sucursal").getByRole("button", { name: "Activar sucursal" })).toBeDisabled();
    await expect(paso(page, "Activa la sucursal")).toContainText("Primero completa menú, horario y zonas.");

    // ---- 4) Menu: un producto creado y activado en esta sucursal («Disponible aquí»).
    await irDesdePaso(page, "Sube tu menú", "productos");
    await main(page).getByRole("button", { name: "Nuevo producto" }).click();
    const d = dialogo(page, "Nuevo producto");
    await d.getByLabel("Nombre").fill("Cochinita pibil (torta)");
    await d.getByLabel("Precio base").fill("65");
    await d.getByRole("button", { name: "Crear producto" }).click();
    const [prod] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/admin/products" });
    expect(cuerpoDe(prod)).toMatchObject({ name: "Cochinita pibil (torta)", price: 65 });
    await expect(d).toBeHidden();
    const filaProducto = main(page).getByRole("row").filter({ hasText: "Cochinita pibil (torta)" });
    await filaProducto.getByRole("button", { name: "No disponible" }).click();
    const [disp] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/branch-availability" });
    expect(cuerpoDe(disp)).toEqual({ isAvailable: true });
    await expect(filaProducto.getByRole("button", { name: "Disponible", exact: true })).toBeVisible();
    await primerValor(page, 1, 15);
    await expect(paso(page, "Sube tu menú")).toContainText("1 productos a la venta en esta sucursal.");

    // ---- 5) Zonas: la colonia se da de alta en Configuracion (catalogo vacio en una cuenta nueva).
    await ir(page, "/configuracion");
    await page.getByLabel("Nombre", { exact: true }).fill("Altabrisa");
    await page.getByLabel("Latitud").fill("21.0190");
    await page.getByLabel("Longitud").fill("-89.5850");
    await page.getByRole("button", { name: "Agregar zona" }).click();
    const [zona] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/config/zonas" });
    expect(cuerpoDe(zona)).toMatchObject({ name: "Altabrisa" });

    // ---- 6) Horario y cobertura: en Reglas de pedido de la sucursal, un turno y la colonia marcada; un solo «Guardar reglas».
    await primerValor(page, 1, 15);
    await irDesdePaso(page, "Pon tu horario", "sucursales");
    await main(page).getByRole("button", { name: "Reglas de pedido" }).first().click();
    await expect(main(page).getByRole("button", { name: "Guardar reglas" })).toBeVisible();
    await main(page).getByRole("button", { name: "Agregar turno" }).click();
    await main(page).getByRole("checkbox", { name: "Altabrisa" }).check();
    await main(page).getByRole("button", { name: "Guardar reglas" }).click();
    const [politica] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/politica" });
    expect(cuerpoDe(politica)["horario"]).toEqual([{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }]);
    const [zonas] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/zonas-reparto" });
    expect(cuerpoDe(zonas)["zoneIds"]).toHaveLength(1);
    await primerValor(page, 3, 7);
    await expect(paso(page, "Define dónde entregas")).toContainText("1 colonias con entrega.");
    await expect(paso(page, "Activa la sucursal").getByRole("button", { name: "Activar sucursal" })).toBeEnabled();

    // ---- 7) Cobro: el dueño confirma efectivo y tarjeta con terminal para ESTA sucursal.
    await paso(page, "Confirma cómo cobras").getByRole("button", { name: "Confirmo: efectivo y tarjeta con terminal" }).click();
    await esperarEscrituras(mock, { metodo: "POST", ruta: `/v1/restaurantes/${PROP.id}/admin/primer-valor/metodos-pago` });
    await expect(paso(page, "Confirma cómo cobras")).toContainText("Listo");
    await expect(main(page).getByText("Te faltan unos 6 minutos para recibir tu primer pedido.")).toBeVisible();

    // ---- 8) Probar el agente: pedido de prueba en la vista previa de WhatsApp (no llega a cocina ni cobra).
    await irDesdePaso(page, "Prueba tu agente", "agente-whatsapp");
    await page.getByTestId("globo-whatsapp").click();
    const chat = page.getByRole("dialog", { name: /Vista previa de conversación: Agente de WhatsApp/ });
    const campo = chat.getByLabel("Mensaje de prueba");
    await campo.fill("quiero 3 tacos al pastor y una horchata");
    await campo.press("Enter");
    await expect(chat.getByTestId("tarjeta-pedido-simulado")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(chat).toBeHidden();
    await primerValor(page, 5, 1);

    // ---- 9) Activar: POST real de activacion (0071) y la sucursal queda lista.
    await paso(page, "Activa la sucursal").getByRole("button", { name: "Activar sucursal" }).click();
    await esperarEscrituras(mock, { metodo: "POST", ruta: `/v1/restaurantes/taqueria-el-faro/admin/alta-sucursal/${PROP.id}/activar` });
    await expect(page.getByText("Sucursal activa: ya recibe pedidos.")).toBeVisible();
    await expect(main(page).getByText("¡Listo! Tu sucursal ya atiende por WhatsApp")).toBeVisible();
    await expect(pasos(page).getByText("Pendiente")).toHaveCount(0);
    await primerValor(page, 6, null);

    // Ninguna escritura de mas: exactamente una por paso (y ninguna activacion rechazada).
    expect((await mock.buscar({ metodo: "POST", ruta: "/activar" })).map((r) => r.status)).toEqual([200]);
    expect((await mock.buscar({ metodo: "POST", ruta: "/metodos-pago" })).map((r) => r.status)).toEqual([200]);
    vigilante.verificar();
  });
});
