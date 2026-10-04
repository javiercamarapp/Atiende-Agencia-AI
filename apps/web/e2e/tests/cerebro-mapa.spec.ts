// SA-L-42/43: el mapa del Cerebro de ventas y la ficha del prospecto, de punta a punta en navegador real (API simulada con una cartera
// ficticia). Recorrido pais -> estado -> calles -> ficha, color por vertical y su filtro, camara libre, filtros y exportacion con rastro, supresion y
// base de licitud, y las animaciones con prefers-reduced-motion activado y desactivado. Las pruebas @oscuro corren tambien en claro/oscuro y movil;
// los PNG solo se escriben si CAPTURAS_CEREBRO_DIR apunta a una carpeta (CI no genera nada).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil } from "../helpers/navegacion.ts";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN49OQFAAVaAq809SKAAAAAAElFTkSuQmCC", "base64");
const VERTICALES = ["restaurantes", "hoteles", "rentas", "licitaciones", "despachos", "citas"];
/** Prospectos con coordenadas por vertical en la cartera ficticia (fixtures/cerebro.ts). */
const LUCES_POR_VERTICAL: Record<string, number> = { restaurantes: 4, hoteles: 3, rentas: 2, licitaciones: 2, despachos: 2, citas: 2 };
const TOTAL_LUCES = 15;

async function sinTeselasReales(page: Page): Promise<void> {
  // El nivel calle pide teselas de OpenStreetMap: en la prueba se sirven locales (determinista, sin red).
  await page.route("https://tile.openstreetmap.org/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 }));
}

async function abrirMapa(page: Page, iniciarSesion: (o: "superadmin") => Promise<string>): Promise<void> {
  await sinTeselasReales(page);
  await iniciarSesion("superadmin");
  await page.goto("/superadmin/mapa-prospectos");
  await afirmarPantallaSana(page, "mapa de prospectos");
  await expect(page.locator("circle.cerebro-luz").first()).toBeVisible();
}

const luces = (page: Page): Locator => page.locator("circle.cerebro-luz");
const leyenda = (page: Page): Locator => page.getByRole("group", { name: "Verticales (leyenda y filtro)" });
const mapaSvg = (page: Page): Locator => page.getByRole("img", { name: "Mapa de México con la cartera de prospectos" });
const camara = (page: Page): Locator => mapaSvg(page).locator("> g");
const escala = async (page: Page): Promise<number> => {
  const t = await camara(page).evaluate((g) => (g as SVGGElement).style.transform);
  return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? "1");
};
async function capturar(page: Page, info: { project: { name: string } }, nombre: string): Promise<void> {
  const destino = process.env["CAPTURAS_CEREBRO_DIR"];
  if (!destino) return;
  mkdirSync(destino, { recursive: true });
  await page.evaluate(() => document.querySelector("main")?.scrollTo(0, 0));
  await page.screenshot({ path: join(destino, `${info.project.name}-${nombre}.png`), fullPage: false });
}

test.describe("Cerebro de ventas: mapa y ficha @cerebro", () => {
  test("pais -> estado -> calles -> ficha, con el color de cada vertical @oscuro", async ({ page, iniciarSesion, vigilante }, info) => {
    await abrirMapa(page, iniciarSesion);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mapa de prospectos");
    await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
    await afirmarSinScrollHorizontal(page);

    // PAIS: una luz por prospecto con coordenadas; el color de cada luz es el de su vertical y las 6 son distintas.
    await expect(luces(page)).toHaveCount(TOTAL_LUCES);
    const rellenos = new Set<string>();
    for (const v of VERTICALES) {
      const luz = page.locator(`circle.cerebro-luz[data-vertical="${v}"]`);
      await expect(luz).toHaveCount(LUCES_POR_VERTICAL[v]!);
      rellenos.add(await luz.first().evaluate((c) => getComputedStyle(c).fill));
    }
    expect(rellenos.size, "las 6 verticales tienen 6 colores distintos").toBe(6);
    // La leyenda muestra las 6 verticales con su conteo.
    for (const v of VERTICALES) await expect(leyenda(page).getByRole("button", { name: new RegExp(`^${v === "rentas" ? "Rentas vacacionales" : v[0]!.toUpperCase() + v.slice(1)} \\d+$`) })).toBeVisible();
    await capturar(page, info, "1-pais");

    // ESTADO: clic = vuelo (la camara se acerca) y panel con las tarjetas del estado.
    const antes = await escala(page);
    await page.locator('path[data-estado="MX-YUC"]').dispatchEvent("click");
    const panel = page.getByTestId("cerebro-panel-estado");
    await expect(panel.getByTestId("cerebro-tarjeta").first()).toBeVisible();
    await expect.poll(() => escala(page)).toBeGreaterThan(antes * 2);
    await expect(panel.getByTestId("cerebro-tarjeta")).toHaveCount(5);
    const tarjeta = panel.getByTestId("cerebro-tarjeta").filter({ hasText: "Taquería Doña Ficticia" });
    await expect(tarjeta).toContainText("Restaurantes · Taquería · Nuevo");
    await expect(tarjeta.getByTestId("cerebro-whatsapp")).toHaveAttribute("href", /^https:\/\/wa\.me\/529995550101\?text=Hola%20Lupe/);
    await capturar(page, info, "2-estado");

    // CALLES: Leaflet con los pines/racimos del estado.
    await page.getByRole("button", { name: /Calles/ }).click();
    await expect(page.getByTestId("cerebro-calles")).toBeVisible();
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await expect(page.locator(".cerebro-calle-pin, .cerebro-racimo").first()).toBeVisible();
    await capturar(page, info, "3-calles");
    await page.getByTestId("cerebro-calles").getByRole("button", { name: /Volver al país/ }).click();
    await expect(page.getByTestId("cerebro-calles")).toHaveCount(0);

    // FICHA: el enlace de la tarjeta abre la ficha del prospecto.
    await panel.getByTestId("cerebro-tarjeta").filter({ hasText: "Taquería Doña Ficticia" }).getByRole("link", { name: "Taquería Doña Ficticia" }).click();
    await expect(page).toHaveURL(/\/superadmin\/mapa-prospectos\/cp-01$/);
    await expect(page.getByTestId("ficha-prospecto")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Taquería Doña Ficticia");
    await expect(page.getByText("Persona de contacto")).toBeVisible();
    await expect(page.getByText("Lupe Pérez").first()).toBeVisible();
    const wa = page.getByTestId("ficha-mensaje-whatsapp");
    await expect(wa).toContainText("Hola Lupe, vi que Taquería Doña Ficticia recibe pedidos por WhatsApp");
    await expect(wa.getByRole("link", { name: /Enviar WhatsApp/ })).toHaveAttribute("href", /wa\.me\/529995550101/);
    await expect(page.getByText("Sin calificar", { exact: false })).toHaveCount(0);
    await afirmarSinScrollHorizontal(page);
    await capturar(page, info, "4-ficha");
    await page.getByRole("link", { name: /Volver al mapa de prospectos/ }).click();
    await expect(page).toHaveURL(/\/superadmin\/mapa-prospectos$/);
    vigilante.verificar();
  });

  test("la leyenda filtra por vertical (clic agrega, otro clic quita) y los KPIs siguen al filtro", async ({ page, iniciarSesion, vigilante }) => {
    await abrirMapa(page, iniciarSesion);
    await expect(page.getByTestId("cerebro-kpi-prospectos")).toHaveText("16");
    await leyenda(page).getByRole("button", { name: /^Hoteles \d+$/ }).click();
    await expect(luces(page)).toHaveCount(LUCES_POR_VERTICAL["hoteles"]!);
    await expect(page.locator('circle.cerebro-luz:not([data-vertical="hoteles"])')).toHaveCount(0);
    await expect(page.getByTestId("cerebro-kpi-prospectos")).toHaveText("3");
    await leyenda(page).getByRole("button", { name: /^Citas \d+$/ }).click();
    await expect(luces(page)).toHaveCount(LUCES_POR_VERTICAL["hoteles"]! + LUCES_POR_VERTICAL["citas"]!);
    await leyenda(page).getByRole("button", { name: /^Hoteles \d+$/ }).click();
    await expect(luces(page)).toHaveCount(LUCES_POR_VERTICAL["citas"]!);
    await leyenda(page).getByRole("button", { name: "Todas" }).click();
    await expect(luces(page)).toHaveCount(TOTAL_LUCES);
    // El conteo de la leyenda no cambia al elegir una vertical (cuenta con los demas filtros, no con el de vertical).
    await expect(leyenda(page).getByRole("button", { name: /^Hoteles 3$/ })).toBeVisible();
    vigilante.verificar();
  });

  test("camara libre: la rueda acerca, el clic en el mar y el boton de casa vuelven al pais", async ({ page, iniciarSesion, vigilante }) => {
    test.skip(esMovil(page), "la rueda del raton no existe en movil");
    await abrirMapa(page, iniciarSesion);
    expect(await escala(page)).toBe(1);
    const caja = (await mapaSvg(page).boundingBox())!;
    await page.mouse.move(caja.x + caja.width / 2, caja.y + caja.height / 2);
    await page.mouse.wheel(0, -600);
    await expect.poll(() => escala(page)).toBeGreaterThan(1.5);
    // Con zoom aparece el boton de casa: vuelve al pais completo.
    await page.getByRole("button", { name: "Volver al país" }).click();
    await expect.poll(() => escala(page)).toBe(1);
    await expect(page.getByRole("button", { name: "Volver al país" })).toHaveCount(0);
    vigilante.verificar();
  });

  test("filtros: urgencia, busqueda, limpiar; el score sin calificar no pasa un minimo", async ({ page, iniciarSesion, vigilante }, info) => {
    await abrirMapa(page, iniciarSesion);
    await page.getByRole("button", { name: /^Filtros/ }).click();
    const panel = page.getByTestId("cerebro-filtros");
    await expect(panel).toBeVisible();
    await capturar(page, info, "5-filtros");
    await panel.getByRole("button", { name: "≥70%" }).first().click();
    // El KPI cuenta animado (600 ms) hasta el valor final: se espera a que se asiente.
    await expect(page.getByTestId("cerebro-kpi-prospectos")).not.toHaveText("16");
    await expect(page.getByTestId("cerebro-kpi-prospectos")).toHaveText("4");
    // Los 4 sin calificar (cp-06, cp-10 con score parcial no cuentan; cp-06 y cp-15 sin score) jamas pasan un minimo.
    await expect(page.getByRole("button", { name: /^Filtros · 1$/ })).toBeVisible();
    await panel.getByLabel("Buscar prospecto").fill("clinica");
    await expect(page.getByTestId("cerebro-kpi-prospectos")).toHaveText("1");
    await panel.getByRole("button", { name: "Limpiar todo" }).click();
    await expect(page.getByTestId("cerebro-kpi-prospectos")).toHaveText("16");
    // El panel se cierra al hacer clic fuera.
    await page.mouse.click(5, 5);
    await expect(panel).toHaveCount(0);
    vigilante.verificar();
  });

  test("exportar CSV: deja el rastro ANTES de armar el archivo y nunca manda datos de prospectos ni el texto buscado", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirMapa(page, iniciarSesion);
    await page.getByRole("button", { name: /^Filtros/ }).click();
    await page.getByTestId("cerebro-filtros").getByLabel("Buscar prospecto").fill("ficti");
    const descarga = page.waitForEvent("download");
    await page.getByRole("button", { name: /Exportar CSV \(16\)/ }).click();
    const archivo = await descarga;
    expect(archivo.suggestedFilename()).toMatch(/^cerebro-prospectos-\d{4}-\d{2}-\d{2}\.csv$/);
    const ruta = await archivo.path();
    const csv = readFileSync(ruta, "utf8");
    expect(csv.startsWith("﻿empresa,vertical,subtipo,etapa")).toBe(true);
    expect(csv.split("\n")).toHaveLength(17);
    const registro = await mock.buscar({ metodo: "POST", ruta: "/superadmin/cerebro/exportaciones" });
    expect(registro).toHaveLength(1);
    const cuerpo = registro[0]!.cuerpo as { total: number; filtros: Record<string, unknown> };
    expect(cuerpo.total).toBe(16);
    expect(cuerpo.filtros["conBusqueda"]).toBe(true);
    expect(JSON.stringify(cuerpo)).not.toMatch(/ficticia|example\.test|555/i);
    vigilante.verificar();
  });

  test("si el rastro NO se puede registrar, el archivo NO se exporta y se avisa", async ({ page, iniciarSesion, mock, vigilante }) => {
    vigilante.permitirRespuesta5xx(/\/superadmin\/cerebro\/exportaciones/);
    await abrirMapa(page, iniciarSesion);
    await mock.inyectarFalla({ metodo: "POST", ruta: "/superadmin/cerebro/exportaciones", status: 500, cuerpo: { message: "falla de bitácora" } });
    let descargo = false;
    page.on("download", () => {
      descargo = true;
    });
    await page.getByRole("button", { name: /^Filtros/ }).click();
    await page.getByRole("button", { name: /Exportar CSV/ }).click();
    await expect(page.getByText(/No se exportó: no se pudo registrar la exportación/)).toBeVisible();
    expect(descargo).toBe(false);
    vigilante.verificar();
  });

  test("sin bitacora en el despliegue (registrada:false) el archivo NO se exporta: falla cerrado y se explica", async ({ page, iniciarSesion, mock, vigilante }) => {
    await abrirMapa(page, iniciarSesion);
    await mock.inyectarFalla({ metodo: "POST", ruta: "/superadmin/cerebro/exportaciones", status: 200, cuerpo: { registrada: false } });
    let descargo = false;
    page.on("download", () => {
      descargo = true;
    });
    await page.getByRole("button", { name: /^Filtros/ }).click();
    await page.getByRole("button", { name: /Exportar CSV/ }).click();
    await expect(page.getByText(/Exportación no disponible aún: requiere la bitácora de exportaciones/)).toBeVisible();
    expect(descargo).toBe(false);
    vigilante.verificar();
  });

  test("supresion y base de licitud: el boton no existe y la tarjeta dice por que", async ({ page, iniciarSesion, vigilante }) => {
    await abrirMapa(page, iniciarSesion);
    // Jalisco: cp-11 tiene el telefono en la lista de supresion; cp-08 si es contactable.
    await page.locator('path[data-estado="MX-JAL"]').dispatchEvent("click");
    const panel = page.getByTestId("cerebro-panel-estado");
    const suprimido = panel.getByTestId("cerebro-tarjeta").filter({ hasText: "Despacho Contable Ficticio" });
    await expect(suprimido.getByTestId("cerebro-whatsapp")).toHaveCount(0);
    await expect(suprimido.getByTestId("cerebro-whatsapp-bloqueado")).toHaveAttribute("title", /lista de supresión/);
    // El correo de ESE prospecto no esta suprimido (solo el telefono): conserva su mailto. El telefono suprimido es texto plano, sin tel:.
    await expect(suprimido.getByTestId("cerebro-correo")).toHaveAttribute("href", /^mailto:diana@example\.test\?body=/);
    await expect(suprimido.locator('a[href^="tel:"]')).toHaveCount(0);
    await expect(suprimido.getByTestId("cerebro-dato-sin-enlace")).toHaveCount(1);
    await expect(panel.getByTestId("cerebro-tarjeta").filter({ hasText: "Villas del Mar" }).locator('a[href^="tel:"]')).toHaveCount(1);
    await expect(panel.getByTestId("cerebro-tarjeta").filter({ hasText: "Villas del Mar" }).getByTestId("cerebro-whatsapp")).toBeVisible();
    // Contacto legado (Guanajuato): sin base de licitud no se contacta; la ficha lo explica.
    await page.goto("/superadmin/mapa-prospectos/cp-10");
    await expect(page.getByText("Sin base de licitud registrada").first()).toBeVisible();
    await expect(page.getByTestId("ficha-mensaje-whatsapp")).toContainText("Sin teléfono");
    // Un prospecto sin score: la barra dice "sin calificar" y la explicacion cita lo que falta; nunca 0%.
    await page.goto("/superadmin/mapa-prospectos/cp-15");
    await expect(page.getByText("sin calificar").first()).toBeVisible();
    await expect(page.getByText(/SEÑAL INSUFICIENTE/)).toBeVisible();
    await expect(page.getByText("0%", { exact: true })).toHaveCount(0);
    // Un prospecto que no existe: estado vacio honesto, no una pagina rota.
    await page.goto("/superadmin/mapa-prospectos/no-existe");
    await expect(page.getByText("El prospecto no existe")).toBeVisible();
    vigilante.verificar();
  });

  test("el mapa y la ficha de un prospecto con base sin migrar dicen 'no disponible aun'", async ({ page, iniciarSesion, mock, vigilante }) => {
    await mock.inyectarFalla({ metodo: "GET", ruta: "/superadmin/cerebro/prospectos", status: 200, cuerpo: { disponible: false, mensaje: "Requiere aplicar la migración 0051_cerebro_ventas_base.", prospectos: [], taxonomias: [] } });
    await iniciarSesion("superadmin");
    await page.goto("/superadmin/mapa-prospectos");
    await afirmarPantallaSana(page, "mapa sin migrar");
    await expect(page.getByText(/El mapa no está disponible aún: requiere la migración 0051/)).toBeVisible();
    await expect(luces(page)).toHaveCount(0);
    vigilante.verificar();
  });

  test("la barra del shell nombra la pagina y el menu enlaza el mapa", async ({ page, iniciarSesion, vigilante }) => {
    await sinTeselasReales(page);
    await iniciarSesion("superadmin");
    await page.goto("/superadmin/mapa-prospectos");
    await afirmarPantallaSana(page, "mapa de prospectos");
    if (!esMovil(page)) {
      await expect(page.getByTestId("barra-pagina-titulo")).toHaveText("Mapa de prospectos");
      await expect(page.getByRole("complementary", { name: "Navegación principal" }).getByRole("link", { name: "Mapa de prospectos" })).toBeVisible();
    }
    vigilante.verificar();
  });
});

test.describe("Cerebro de ventas: con prefers-reduced-motion DESACTIVADO (animaciones activas)", () => {
  test.use({ reducedMotion: "no-preference" });
  test("los estados entran animados, las luces urgentes pulsan y la camara vuela con transicion", async ({ page, iniciarSesion, vigilante }) => {
    await abrirMapa(page, iniciarSesion);
    await expect(page.locator("path.cerebro-estado-entra").first()).toBeVisible({ timeout: 10_000 });
    expect(await page.locator("path.cerebro-estado-entra").count()).toBe(32);
    expect(await page.locator("circle.cerebro-pin-pulso").count()).toBeGreaterThan(0);
    await page.locator('path[data-estado="MX-YUC"]').dispatchEvent("click");
    const transicion = await camara(page).evaluate((g) => (g as SVGGElement).style.transition);
    expect(transicion).toContain("750ms");
    vigilante.verificar();
  });
});

test.describe("Cerebro de ventas: con prefers-reduced-motion ACTIVADO (sin movimiento)", () => {
  test.use({ reducedMotion: "reduce" });
  test("nada se anima: sin entrada de estados, sin pulso, sin transicion de camara, y el recorrido sigue funcionando", async ({ page, iniciarSesion, vigilante }) => {
    await abrirMapa(page, iniciarSesion);
    expect(await page.locator("path.cerebro-estado-entra").count()).toBe(0);
    expect(await page.locator("circle.cerebro-pin-pulso").count()).toBe(0);
    await page.locator('path[data-estado="MX-YUC"]').dispatchEvent("click");
    await expect(page.getByTestId("cerebro-panel-estado").getByTestId("cerebro-tarjeta").first()).toBeVisible();
    const transicion = await camara(page).evaluate((g) => (g as SVGGElement).style.transition);
    expect(transicion).toBe("none");
    expect(await escala(page)).toBeGreaterThan(2);
    // Sin movimiento los KPIs muestran el valor final de una vez y el panel no se anima.
    const animaciones = await page.getByTestId("cerebro-zona").evaluate((z) => z.getAnimations({ subtree: true }).filter((a) => a.playState === "running" && (a as CSSAnimation).animationName).length);
    expect(animaciones).toBe(0);
    await page.getByRole("button", { name: /Calles/ }).click();
    await expect(page.getByTestId("cerebro-calles")).toBeVisible();
    vigilante.verificar();
  });
});
