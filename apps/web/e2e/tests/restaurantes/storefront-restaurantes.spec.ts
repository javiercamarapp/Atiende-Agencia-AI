// Storefront PUBLICO de restaurantes (/pedir/*) de punta a punta contra la API simulada: sucursales -> menu -> carrito -> cotizacion ->
// confirmacion -> pedido -> rastreo. Sin sesion. Las rutas publicas caen en el escenario "anon" del mock (compartido entre pruebas), asi que
// las escrituras se identifican por el nombre unico del cliente de cada prueba.
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test, URL_API } from "../../helpers/fixtures.ts";
import { afirmarSinScrollHorizontal } from "../../helpers/ds.ts";
import { ClienteMock } from "../../mock-api/cliente.ts";
import type { Page } from "@playwright/test";

const RAIZ = `/pedir/taqueria-el-faro`;
const anon = new ClienteMock(URL_API, "anon");

const unico = (): string => `Cliente E2E ${Math.random().toString(36).slice(2, 8)}`;

async function llenarContacto(page: Page, nombre: string): Promise<void> {
  await page.getByRole("textbox", { name: /^Nombre/ }).fill(nombre);
  await page.getByRole("textbox", { name: /^Teléfono/ }).fill("9995550123");
  await page.getByLabel("Efectivo").check();
  await page.getByRole("checkbox").last().check();
}

/** En pantalla ancha el pedido es la columna "Tu pedido"; en el telefono vive en una hoja que abre la barra inferior "Ver pedido". */
async function abrirPedido(page: Page) {
  const ver = page.getByRole("button", { name: "Ver pedido" });
  if (await ver.isVisible()) {
    await ver.click();
    return dialogo(page, "Tu pedido");
  }
  return page.getByRole("complementary", { name: "Tu pedido" });
}

async function escriturasDe(nombre: string, ruta: string) {
  return (await anon.buscar({ metodo: "POST", ruta })).filter((r) => JSON.stringify(r.cuerpo ?? {}).includes(nombre));
}

test.describe("restaurantes: storefront publico @recorrido", () => {
  test("sucursales -> menu -> pedido para recoger -> rastreo; Seguir editando y Escape no crean pedido", async ({ page, vigilante }) => {
    const nombre = unico();
    await page.goto(RAIZ);
    await expect(page.getByRole("heading", { level: 1, name: /Pide en Taqueria El Faro/ })).toBeVisible();
    await page.getByRole("link", { name: /Ver menú y pedir en/ }).click();
    await expect(page).toHaveURL(`${RAIZ}/centro`);
    await expect(page.getByRole("heading", { level: 1, name: "Sucursal Centro" })).toBeVisible();

    // El producto con tortilla obligatoria no se agrega sin elegirla.
    const agregarTacos = page.getByRole("button", { name: "Agregar Tacos al pastor (orden) al carrito" });
    await expect(agregarTacos).toBeDisabled();
    await page.getByLabel("Tortilla para Tacos al pastor (orden)").selectOption("maiz");
    await agregarTacos.click();
    await page.getByRole("button", { name: "Agregar Horchata al carrito" }).click();
    const carrito = await abrirPedido(page);
    await expect(carrito.getByText("$143").first()).toBeVisible();
    await page.getByRole("button", { name: "Agregar una unidad de Horchata" }).click();
    await page.getByRole("button", { name: "Quitar una unidad de Horchata" }).click();

    // Sin datos: la validacion local habla y NO hay peticion de cotizacion.
    await carrito.getByRole("button", { name: "Revisar pedido" }).click();
    await expect(carrito.getByText("Escribe tu nombre.")).toBeVisible();
    const cotizacionesAntes = (await anon.buscar({ metodo: "POST", ruta: "/quote" })).length;
    await expect(carrito.getByText("Escribe tu nombre.")).toBeVisible();
    expect((await anon.buscar({ metodo: "POST", ruta: "/quote" })).length, "la validacion local no cotiza").toBe(cotizacionesAntes);

    await llenarContacto(page, nombre);
    await page.getByRole("button", { name: "Revisar pedido" }).click();
    const d = dialogo(page, "Confirma tu pedido");
    await expect(d).toBeVisible();
    await expect(d).toContainText("Total");
    // Seguir editando y Escape: ningun pedido.
    await d.getByRole("button", { name: "Seguir editando" }).click();
    await expect(d).toBeHidden();
    await page.getByRole("button", { name: "Revisar pedido" }).click();
    await expect(dialogo(page, "Confirma tu pedido")).toBeVisible(); // la cotizacion es asincrona: Escape solo cuando el dialogo ya abrio
    await page.keyboard.press("Escape");
    await expect(dialogo(page, "Confirma tu pedido")).toBeHidden();
    expect(await escriturasDe(nombre, "/orders"), "cancelar no crea pedidos").toEqual([]);

    // Confirmar: exactamente un pedido y se llega al rastreo con su contenido.
    await page.getByRole("button", { name: "Revisar pedido" }).click();
    await dialogo(page, "Confirma tu pedido").getByRole("button", { name: "Confirmar pedido" }).click();
    await expect(page).toHaveURL(new RegExp(`${RAIZ}/pedido/trk-`));
    await expect(page.getByRole("heading", { level: 1, name: "Seguimiento de tu pedido" })).toBeVisible();
    await expect(page.getByText("1 × Tacos al pastor (orden) (maiz)")).toBeVisible();
    await expect(page.getByText("1 × Horchata")).toBeVisible();
    await expect(page.getByText("$143").last()).toBeVisible();
    const pedidos = await escriturasDe(nombre, "/orders");
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.cuerpo).toMatchObject({ canal: "recoger", payment_method: "efectivo", customer_phone: "9995550123" });
    await page.getByRole("link", { name: "Hacer otro pedido" }).click();
    await expect(page).toHaveURL(RAIZ);
    vigilante.verificar();
  });

  test("a domicilio: el pedido minimo bloquea con su aviso hasta alcanzarlo", async ({ page, vigilante }) => {
    await page.goto(`${RAIZ}/centro`);
    await page.getByRole("button", { name: "Agregar Horchata al carrito" }).click();
    await abrirPedido(page);
    await page.getByLabel("A domicilio").check();
    await expect(page.getByText(/mínimo/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Revisar pedido" })).toBeDisabled();
    vigilante.verificar();
  });

  test("un codigo de promocion invalido al recoger se avisa en la confirmacion", async ({ page, vigilante }) => {
    await page.goto(`${RAIZ}/centro`);
    await page.getByRole("button", { name: "Agregar Horchata al carrito" }).click();
    await abrirPedido(page);
    await llenarContacto(page, unico());
    await page.getByLabel("Código de promoción (opcional)").fill("NOEXISTE");
    await page.getByRole("button", { name: "Revisar pedido" }).click();
    await expect(dialogo(page, "Confirma tu pedido")).toContainText("Ese codigo no existe");
    vigilante.verificar();
  });

  test("el enlace de rastreo desconocido dice que no encontro el pedido; sucursal desconocida muestra error con Reintentar", async ({ page, vigilante }) => {
    vigilante.permitirRespuesta5xx(/\/storefront\//);
    await page.goto(`${RAIZ}/pedido/token-que-no-existe`);
    await expect(page.getByText("No encontramos ese pedido")).toBeVisible();
    // Una falla de red/servidor al cargar el menu: EstadoError con Reintentar y recupera (503 una sola vez desde el navegador).
    let fallo = true;
    await page.route(/\/storefront\/centro\/menu/, async (route) => {
      if (fallo) {
        fallo = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "No pudimos cargar el menú." }) });
      } else await route.continue();
    });
    await page.goto(`${RAIZ}/centro`);
    const alerta = page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Reintentar" }) });
    await expect(alerta).toBeVisible();
    await alerta.getByRole("button", { name: "Reintentar" }).click();
    await expect(page.getByRole("button", { name: "Agregar Horchata al carrito" })).toBeVisible();
    vigilante.verificar();
  });

  test("el aviso de privacidad y la pagina de sucursales no desbordan en ningun ancho", async ({ page, vigilante }) => {
    for (const ruta of [RAIZ, `${RAIZ}/centro`, `${RAIZ}/privacidad`]) {
      await page.goto(ruta);
      await expect(page.locator("h1").first()).toBeVisible();
      await afirmarSinScrollHorizontal(page);
    }
    vigilante.verificar();
  });
});
