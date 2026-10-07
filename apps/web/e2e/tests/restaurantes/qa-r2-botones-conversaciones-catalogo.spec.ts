// QA adversarial ronda 2 (lente botones) -- Conversaciones (handoff y respuesta), Callbacks (SLA e intentos), Promociones y Turnos: verificacion
// de R1-04/05/08/17 y doble clic en acciones que registran algo. Contra la API simulada.
import type { Page } from "@playwright/test";
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarSinEscrituras, cuerpoDe, esperarEscrituras, ir } from "../../helpers/recorrido.ts";
import { propiedadDe } from "../../mock-api/personas.ts";

const main = (page: Page) => page.locator("main#contenido-principal");
const PROP = propiedadDe("restaurantes");

function callback(id: string, nombre: string, estado: "nuevo" | "en_curso") {
  const ahora = Date.now();
  return {
    id,
    nombre,
    telefono: "+529995550155",
    motivo: "escalada:queja",
    mensaje: "Quiere hablar del pedido de ayer",
    origen: "whatsapp",
    resuelto: false,
    creadoEn: new Date(ahora - 5 * 60_000).toISOString(),
    sucursalId: PROP.id,
    estado,
    gestionable: true,
    asignadoA: null,
    asignadoNombre: null,
    asignadoEn: null,
    tomadoEn: null,
    resueltoEn: null,
    resueltoPor: null,
    notaResolucion: null,
    sla: { objetivoMin: 15, venceAt: new Date(ahora + 10 * 60_000).toISOString(), estado: "en_plazo", minutosRestantes: 10 },
    intentos: [] as unknown[],
  };
}

async function abrirConversacion(page: Page) {
  await ir(page, "/conversaciones");
  await main(page).getByRole("button", { name: /WhatsApp · \+529995550101/ }).click();
}

test.describe("restaurantes R2 botones: Conversaciones y Callbacks @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("R1-botones-04 (verifica cierre): el error de Devolver se anuncia como alerta, no como exito", async ({ page, mock, vigilante }) => {
    vigilante.permitirRespuesta5xx(/devolver/);
    await abrirConversacion(page);
    await main(page).getByRole("button", { name: "Tomar conversación" }).click();
    await expect(main(page).getByRole("status").filter({ hasText: "La conversación es tuya" })).toBeVisible();
    await mock.inyectarFalla({ metodo: "POST", ruta: "/devolver", status: 503, veces: 1 });
    await main(page).getByRole("button", { name: "Devolver al agente" }).click();
    await expect(main(page).getByRole("alert").filter({ hasText: /503|No se pudo/ })).toBeVisible();
    await expect(main(page).getByRole("status").filter({ hasText: /503/ })).toHaveCount(0);
  });

  test("Enviar respuesta por WhatsApp: doble clic manda UN POST y limpia el campo", async ({ page, mock, vigilante }) => {
    await abrirConversacion(page);
    await main(page).getByRole("button", { name: "Tomar conversación" }).click();
    await esperarEscrituras(mock, { metodo: "POST", ruta: "/tomar" });
    const campo = main(page).getByLabel("Responder por WhatsApp");
    await campo.fill("Ya va en camino su pedido");
    await mock.configurar({ latenciaMs: 500 });
    await main(page).getByRole("button", { name: "Enviar respuesta" }).dblclick();
    await expect(main(page).getByRole("status").filter({ hasText: "Respuesta enviada al cliente." })).toBeVisible();
    const envios = await mock.buscar({ metodo: "POST", ruta: "/responder" });
    expect(envios).toHaveLength(1);
    expect(cuerpoDe(envios[0])).toMatchObject({ texto: "Ya va en camino su pedido" });
    await expect(campo).toHaveValue("");
    vigilante.verificar();
  });

  test("Callbacks: Resolver con Escape no escribe; Tomar y Resolver con nota hacen su POST", async ({ page, mock, vigilante }) => {
    await ir(page, "/conversaciones");
    await main(page).getByRole("tab", { name: "Callbacks" }).click();
    await expect(main(page).getByText("Sin callbacks")).toBeVisible();
    await mock.agregarAEstado("rest.callbacks", callback("cb-1", "Rosa Callback", "nuevo"));
    await main(page).getByLabel("Mostrar").selectOption("todos");
    await expect(main(page).getByText("Rosa Callback", { exact: false })).toBeVisible();
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Tomar", exact: true }).click();
    await esperarEscrituras(mock, { metodo: "POST", ruta: "/callbacks/cb-1/estado" }, 1);
    await main(page).getByRole("button", { name: "Resolver", exact: true }).click();
    const d = dialogo(page, /Resolver el callback/);
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    expect((await mock.buscar({ metodo: "POST", ruta: "/callbacks/cb-1/estado" })).length, "Escape no resuelve").toBe(1);
    await main(page).getByRole("button", { name: "Resolver", exact: true }).click();
    await dialogo(page, /Resolver el callback/).getByRole("textbox").fill("Se le repuso el pedido");
    await dialogo(page, /Resolver el callback/).getByRole("button", { name: "Marcar como resuelto" }).click();
    const cambios = await esperarEscrituras(mock, { metodo: "POST", ruta: "/callbacks/cb-1/estado" }, 2);
    expect(cuerpoDe(cambios[1])).toMatchObject({ accion: "resolver", nota: "Se le repuso el pedido" });
    vigilante.verificar();
  });

  test("QA-R2-botones-06: doble clic en un resultado de intento ('No contestó') registra UN solo intento", async ({ page, mock }) => {
    await ir(page, "/conversaciones");
    await main(page).getByRole("tab", { name: "Callbacks" }).click();
    await expect(main(page).getByText("Sin callbacks")).toBeVisible();
    await mock.agregarAEstado("rest.callbacks", callback("cb-2", "Doble Intento", "en_curso"));
    await main(page).getByLabel("Mostrar").selectOption("todos");
    await expect(main(page).getByText("Doble Intento", { exact: false })).toBeVisible();
    await mock.configurar({ latenciaMs: 500 });
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "No contestó" }).dblclick();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/intentos" })).length).toBeGreaterThan(0);
    await expect(main(page).getByText(/No contestó · Owner/).first()).toBeVisible();
    expect((await mock.buscar({ metodo: "POST", ruta: "/intentos" })).length, "un doble clic no debe registrar dos intentos").toBe(1);
  });
});

test.describe("restaurantes R2 botones: Promociones y Turnos @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  async function abrirCrear(page: Page) {
    await ir(page, "/promociones");
    await main(page).getByRole("button", { name: /Crear un código nuevo|Nuevo código|Crear código/ }).first().click();
    const d = dialogo(page, "Crear un código nuevo");
    await expect(d).toBeVisible();
    await d.getByRole("textbox", { name: "Código", exact: true }).fill("QA2DESC");
    await d.getByLabel("Nombre para el staff").fill("Prueba R2");
    return d;
  }

  test("R1-botones-17 (verifica cierre): el error de 'Crear código' se ve DENTRO del dialogo", async ({ page, mock, vigilante }) => {
    const d = await abrirCrear(page);
    await d.getByLabel("Valor").fill("10");
    await d.getByLabel(/Aplicar automáticamente/).check();
    await mock.limpiarRegistro();
    await d.getByRole("button", { name: "Crear código" }).click();
    await expect(d.getByText(/necesita un canal/)).toBeVisible();
    await afirmarSinEscrituras(mock, "automatica sin canal");
    vigilante.verificar();
  });

  test("QA-R2-botones-07: 'Crear código' con valor 0 (el campo acepta min=0) avisa por que no se crea", async ({ page, mock }) => {
    const d = await abrirCrear(page);
    await d.getByLabel("Valor").fill("0");
    await mock.limpiarRegistro();
    await d.getByRole("button", { name: "Crear código" }).click();
    await afirmarSinEscrituras(mock, "valor 0");
    await expect(d, "el dialogo sigue abierto").toBeVisible();
    // El campo es valido para HTML (min=0), asi que el navegador no lo marca: la explicacion la da el dialogo con una alerta propia.
    await expect(d.getByRole("alert"), "debe explicar por que no se creo").toBeVisible({ timeout: 3000 });
    await expect(d.getByRole("alert")).toContainText("mayor que 0");
  });

  test("R1-botones-05/08 (verifican cierre): Turnos valida en el cliente y no repite el nombre tras Quitar", async ({ page, mock, vigilante }) => {
    await ir(page, "/turnos");
    await expect(main(page).getByLabel("Nombre del turno 1")).toBeVisible();
    await main(page).getByRole("button", { name: "Agregar turno" }).click();
    await main(page).getByRole("button", { name: "Agregar turno" }).click();
    await main(page).getByRole("button", { name: "Quitar turno" }).nth(1).click();
    await main(page).getByRole("button", { name: "Agregar turno" }).click();
    const nombres = await main(page).getByLabel(/^Nombre del turno \d$/).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value.trim().toLowerCase()));
    expect(new Set(nombres).size, `nombres repetidos: ${nombres.join(", ")}`).toBe(nombres.length);
    await main(page).getByLabel("Nombre del turno 1").fill("");
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Guardar turnos" }).click();
    await expect(main(page).getByRole("alert").filter({ hasText: /nombre/ })).toBeVisible();
    await afirmarSinEscrituras(mock, "turnos invalidos");
    vigilante.verificar();
  });
});
