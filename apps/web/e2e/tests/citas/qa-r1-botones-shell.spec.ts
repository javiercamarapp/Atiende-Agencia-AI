// QA R1 (lente botones y paginas) de citas: shell. Selector de sucursal (estado que no debe cruzarse entre sucursales), 404 dentro
// del shell, barra superior, barra movil y hoja "Más", menu de cuenta, tema oscuro y lo que ve un rol staff en las paginas de dueno.
import type { Page } from "@playwright/test";
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarModo, afirmarSinScrollHorizontal } from "../../helpers/ds.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { barraMovil, enlacesMasMovil, esMovil, sidebar } from "../../helpers/navegacion.ts";
import { citasQa } from "../../mock-api/fixtures/citas-qa.ts";

const BASE = `/citas/${citasQa.orgSlug}`;
const NORTE = citasQa.sucursalNorte;

/** Siembra la segunda sucursal (la lista existe en cuanto el shell la pidio en el login) y recarga en `ruta`. */
async function conDosSucursales(page: Page, mock: { agregarAEstado(c: string, v: unknown): Promise<void> }, ruta: string): Promise<void> {
  await mock.agregarAEstado("citas.branches", NORTE);
  await page.goto(`${BASE}/${ruta}`);
  await afirmarPantallaSana(page, ruta);
}

/** El selector de sucursal visible en este viewport (Sidebar en escritorio, cabecera en movil). */
function selectorVisible(page: Page) {
  return page.locator("select#citas-sucursal-activa:visible");
}

test.describe("citas QA R1 botones: shell", () => {
  test("cambiar de sucursal en la Agenda recarga TODO con la otra sucursal: citas, proveedores, filtro y lista de espera", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await conDosSucursales(page, mock, "agenda");
    await expect(page.getByText("Ana Lilia Pech")).toBeVisible();
    await page.getByLabel("Filtrar por proveedor").selectOption("prv-2");
    await expect(page.getByText("Jorge Ek")).toBeVisible();

    await mock.limpiarRegistro();
    await selectorVisible(page).selectOption(NORTE.propertyId);
    await expect(page.getByText("Rosa Canul")).toBeVisible();
    await expect(page.getByText("Ana Lilia Pech")).toHaveCount(0);
    await expect(page.getByText("Jorge Ek")).toHaveCount(0);
    await expect(page.getByText("Nadie está esperando con estos filtros.")).toBeVisible();
    // El filtro de proveedor de la sucursal anterior no viaja a la nueva.
    await expect(page.getByLabel("Filtrar por proveedor")).toHaveValue("");
    await expect(page.getByLabel("Filtrar por proveedor").locator("option")).toHaveText(["Todos los proveedores", "Dra. Norma Uc"]);
    const pedidas = await mock.buscar({ metodo: "GET" });
    expect(pedidas.filter((r) => r.ruta.includes(citasQa.propertyId)), "tras cambiar, nada se pide a la sucursal anterior").toEqual([]);
    expect(pedidas.filter((r) => r.ruta.includes("provider_id=prv-2"))).toEqual([]);

    // La eleccion persiste al recargar.
    await page.reload();
    await expect(page.getByText("Rosa Canul")).toBeVisible();
    vigilante.verificar();
  });

  test("cambiar de sucursal en Clientes limpia la busqueda escrita", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await conDosSucursales(page, mock, "clientes");
    await page.getByLabel("Buscar cliente").fill("Ana");
    await selectorVisible(page).selectOption(NORTE.propertyId);
    await expect(page.getByLabel("Buscar cliente")).toHaveValue("");
    await expect(page.getByText("Rosa Canul")).toBeVisible();
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-08: el selector de sucursal se pinta dos veces con el mismo id (Sidebar y cabecera movil)", async ({ page, iniciarSesion, mock }) => {
    test.fail(!process.env.QA_SIN_FAIL, "QA-citas-R1-botones-08: CitasShell pasa el mismo nodo `branchSelector` como branchSelector y mobileSelector");
    await iniciarSesion("citas", "owner");
    await conDosSucursales(page, mock, "resumen");
    await expect(page.locator("#citas-sucursal-activa")).toHaveCount(1);
  });

  test("con dos sucursales el selector visible tiene nombre accesible y no desborda la pantalla", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await conDosSucursales(page, mock, "agenda");
    await expect(selectorVisible(page)).toBeVisible();
    // En movil hay dos <select> con el mismo id (defecto 08): el nombre se busca por la etiqueta visible al lado.
    if (!esMovil(page)) await expect(page.getByRole("combobox", { name: "Sucursal activa" })).toBeVisible();
    await afirmarSinScrollHorizontal(page);
    vigilante.verificar();
  });

  test("una ruta desconocida dentro del panel muestra el 404 del shell con la navegacion y vuelve a la agenda", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(`${BASE}/esta-pagina-no-existe`);
    await expect(page.getByText("Página no encontrada")).toBeVisible();
    if (esMovil(page)) await expect(barraMovil(page)).toBeVisible();
    else await expect(sidebar(page)).toBeVisible();
    await page.getByRole("link", { name: "Volver a la agenda" }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/agenda$`));
    vigilante.verificar();
  });

  test("QA-citas-R1-botones-09: en el 404 del shell el unico <h1> es el nombre de la consola, no 'Página no encontrada'", async ({ page, iniciarSesion }) => {
    test.fail(!process.env.QA_SIN_FAIL, "QA-citas-R1-botones-09: VerticalNoEncontrado no pinta <h1> y la barra hace de h1 con el titulo de la consola");
    await iniciarSesion("citas", "owner");
    await page.goto(`${BASE}/esta-pagina-no-existe`);
    await expect(page.getByText("Página no encontrada")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Página no encontrada");
  });

  test("la barra superior nombra la pagina destino tras navegar desde el Copiloto (se espera el render, no se lee al instante)", async ({ page, iniciarSesion, vigilante }) => {
    test.skip(esMovil(page), "la barra superior es de escritorio");
    await iniciarSesion("citas", "owner");
    const barra = page.getByTestId("barra-pagina-titulo");
    for (const [enlace, titulo] of [["Copiloto", "Copiloto"], ["Agenda", "Agenda"], ["Avisos", "Avisos"], ["Resumen", `Citas · ${citasQa.orgSlug}`]] as const) {
      await sidebar(page).getByRole("link", { name: enlace, exact: true }).click();
      await expect(barra).toHaveText(titulo);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    }
    vigilante.verificar();
  });

  test("barra movil: 4 destinos + Más; la hoja lista todas las secciones, se cierra con Escape y ninguna etiqueta se corta", async ({ page, iniciarSesion, vigilante }) => {
    test.skip(!esMovil(page), "barra inferior solo en movil");
    await iniciarSesion("citas", "owner");
    const barra = barraMovil(page);
    for (const nombre of ["Resumen", "Agenda", "Servicios", "Clientes"]) await expect(barra.getByRole("link", { name: nombre })).toBeVisible();
    const cortadas = await barra.locator("a, button").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
    expect(cortadas).toEqual([]);
    const enlaces = await enlacesMasMovil(page);
    const hrefs = enlaces.map((e) => e.href);
    for (const ruta of ["proveedores", "disponibilidad", "configuracion", "staff", "auditoria", "privacidad", "conversaciones", "agente-whatsapp", "mensajes-whatsapp", "avisos", "primeros-pasos", "copiloto"]) {
      expect(hrefs, `la hoja Más debe llevar a ${ruta}`).toContain(`${BASE}/${ruta}`);
    }
    await afirmarSinScrollHorizontal(page);
    vigilante.verificar();
  });

  test("cerrar sesion desde el menu de cuenta sale al login de citas", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("citas", "owner");
    if (esMovil(page)) {
      await page.getByRole("button", { name: "Abrir menú de cuenta" }).click();
      await page.getByRole("menuitem", { name: "Cerrar sesión" }).or(page.getByRole("button", { name: "Cerrar sesión" })).first().click();
    } else {
      await sidebar(page).getByRole("button", { name: /Cerrar sesión/ }).first().click();
    }
    await expect(page).toHaveURL(/\/citas\/login/);
    // Volver con el boton de atras no reabre el panel sin sesion.
    await page.goto(`${BASE}/agenda`);
    await expect(page).toHaveURL(/\/citas\/login/);
    vigilante.verificar();
  });

  test("tema oscuro: la agenda y sus tarjetas siguen el modo oscuro sin desbordar @oscuro", async ({ page, iniciarSesion, vigilante }, info) => {
    test.skip(!info.project.name.endsWith("oscuro"), "solo en los proyectos oscuros");
    await iniciarSesion("citas", "owner");
    await page.goto(`${BASE}/agenda`);
    await afirmarModo(page, "oscuro");
    const fondo = await page.locator("main section > div").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, b] = (fondo.match(/\d+(\.\d+)?/g) ?? ["255", "255", "255"]).map(Number) as [number, number, number];
    expect((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, `la tarjeta de cita en oscuro no debe ser clara (${fondo})`).toBeLessThan(0.4);
    await afirmarSinScrollHorizontal(page);
    vigilante.verificar();
  });

  test("rol staff: no ve el Copiloto y las paginas de dueno dicen con honestidad que no tiene permiso, sin errores", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("citas", "staff");
    if (!esMovil(page)) await expect(sidebar(page).getByRole("link", { name: "Copiloto" })).toHaveCount(0);
    for (const ruta of ["staff", "privacidad", "agente-whatsapp", "primeros-pasos", "auditoria"]) {
      await page.goto(`${BASE}/${ruta}`);
      await afirmarPantallaSana(page, ruta);
      await expect(page.locator("main").getByText(/rol|permiso|dueños|owner/i).first(), `${ruta}: debe explicar el permiso`).toBeVisible();
    }
    vigilante.verificar();
  });
});
