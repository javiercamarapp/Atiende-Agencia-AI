// Capturas de Pedidos de restaurantes para la aceptacion de UNI-R1 (paridad con el repo suelto): lista con mapa, enviadas (Demorado), programadas,
// vacio, detalle y dialogos, en claro/oscuro y movil 375 px (las pruebas @oscuro corren en los 4 proyectos). Las comprobaciones (modo, un solo h1,
// sin desborde horizontal, mapa cargado, sin errores de consola) corren siempre; el PNG solo se escribe si CAPTURAS_RESTAURANTES_DIR apunta a una
// carpeta (CI no genera nada). Las teselas de OpenStreetMap se sirven locales desde helpers/fixtures.ts (determinista, sin red); con
// CAPTURAS_TESELAS_REALES=1 se piden las reales (solo para generar imagenes de comparacion con el original, unas pocas peticiones).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { dialogo } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { ir } from "../helpers/recorrido.ts";
import { propiedadDe } from "../mock-api/personas.ts";

const PROP = propiedadDe("restaurantes");
const main = (page: Page) => page.locator("main#contenido-principal");

async function foto(page: Page, nombre: string, proyecto: string): Promise<void> {
  const destino = process.env["CAPTURAS_RESTAURANTES_DIR"];
  if (!destino) return;
  mkdirSync(destino, { recursive: true });
  await page.evaluate(() => document.querySelector("main")?.scrollTo(0, 0));
  await page.waitForTimeout(400); // asienta animaciones de entrada y teselas
  await page.screenshot({ path: join(destino, `${nombre}-${proyecto}.png`), fullPage: true });
}

async function sana(page: Page, contexto: string, oscuro: boolean): Promise<void> {
  await afirmarPantallaSana(page, contexto);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await afirmarSinScrollHorizontal(page);
  await afirmarModo(page, oscuro ? "oscuro" : "claro");
}

const enCamino = {
  id: "ord-3001",
  orderNumber: 1005,
  propertyId: PROP.id,
  branch: PROP.nombre,
  customerId: "cli-4",
  customerName: "Pedro Chan",
  customerPhone: "+529995550104",
  customerAddress: "Calle 45 #210, Garcia Gineres",
  total: 190,
  status: "en_camino",
  items: [{ id: "p-3", name: "Cochinita pibil (torta)", price: 95, quantity: 2 }],
  source: "whatsapp",
  notes: null,
  paymentMethod: "efectivo",
  createdAt: new Date(Date.now() - 50 * 60_000).toISOString(),
  assignedRepartidorId: "usr-2",
  estimatedDeliveryAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  incidentNote: null,
  canal: "domicilio",
  propina: null,
  horaRecogida: null,
  deliveredAt: null,
};

test.describe("captura de Pedidos de restaurantes @captura", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("Recibidas: lista a la izquierda y mapa «Entrega en curso» con el pedido seleccionado @oscuro", async ({ page, vigilante }, info) => {
    const oscuro = info.project.name.endsWith("oscuro");
    await ir(page, "/pedidos");
    await expect(main(page).getByText("Marisol Pech").first()).toBeVisible();
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await expect(page.locator(".pedido-pin")).toHaveCount(3);
    await expect(main(page).getByText("Simulado")).toBeVisible();
    await expect(main(page).getByRole("tab", { name: "Órdenes recibidas" })).toHaveAttribute("aria-selected", "true");
    await expect(main(page).getByTestId("total-pedidos")).toHaveText("2 en total");
    await sana(page, "pedidos recibidas", oscuro);
    vigilante.verificar();
    await foto(page, "pedidos-recibidas-mapa", info.project.name);
  });

  test("Recibidas: Asignar repartidor abre el selector con «Confirmar envío» @oscuro", async ({ page }, info) => {
    await ir(page, "/pedidos");
    const fila = main(page).locator('[data-testid^="pedido-"]').filter({ hasText: "Jorge Canul" }).first();
    await expect(fila).toBeVisible();
    // Jorge es para recoger (sin repartidor): el despacho se muestra con el pedido a domicilio ya en preparando.
    const marisol = main(page).locator('[data-testid^="pedido-"]').filter({ hasText: "Marisol Pech" }).first();
    await marisol.getByRole("button", { name: "Marcar Preparando" }).click();
    await marisol.getByRole("button", { name: "Asignar repartidor" }).click();
    await expect(marisol.getByRole("button", { name: "Confirmar envío" })).toBeVisible();
    await sana(page, "asignar repartidor", info.project.name.endsWith("oscuro"));
    await foto(page, "pedidos-asignar-repartidor", info.project.name);
  });

  test("Enviadas: repartidor, hora y «Demorado — debía llegar» @oscuro", async ({ page, mock, vigilante }, info) => {
    await ir(page, "/pedidos");
    await expect(main(page).getByText("Marisol Pech").first()).toBeVisible();
    await mock.agregarAEstado("rest.ordenes", enCamino);
    await main(page).getByRole("tab", { name: "Órdenes enviadas" }).click();
    await expect(main(page).getByText("Pedro Chan").first()).toBeVisible();
    await expect(main(page).getByText(/Demorado — debía llegar/)).toBeVisible();
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await expect(main(page).getByText("posición simulada en tránsito")).toBeVisible();
    await sana(page, "pedidos enviadas", info.project.name.endsWith("oscuro"));
    vigilante.verificar();
    await foto(page, "pedidos-enviadas", info.project.name);
  });

  test("Programadas: pantalla completa con la hora y «en X» @oscuro", async ({ page, vigilante }, info) => {
    await ir(page, "/pedidos");
    await main(page).getByRole("tab", { name: "Órdenes programadas" }).click();
    await expect(main(page).getByText("Se promueven a Recibidas automáticamente 30 min antes de su hora")).toBeVisible();
    await expect(main(page).getByText("Lucia Xool")).toBeVisible();
    await expect(page.locator(".leaflet-container")).toHaveCount(0);
    await sana(page, "pedidos programadas", info.project.name.endsWith("oscuro"));
    vigilante.verificar();
    await foto(page, "pedidos-programadas", info.project.name);
  });

  test("Vacio: «No hay pedidos en este filtro» con el icono tenue @oscuro", async ({ page }, info) => {
    await ir(page, "/pedidos");
    await main(page).getByRole("button", { name: "No recogido", exact: true }).click();
    await expect(main(page).getByText("No hay pedidos en este filtro")).toBeVisible();
    await expect(main(page).getByTestId("total-pedidos")).toHaveText("0 en total");
    await sana(page, "pedidos vacio", info.project.name.endsWith("oscuro"));
    await foto(page, "pedidos-vacio", info.project.name);
  });

  test("Detalle a pagina completa (clic en una fila) y «Volver» @oscuro", async ({ page, vigilante }, info) => {
    await ir(page, "/pedidos");
    await main(page).getByRole("button", { name: "Abrir el pedido de Marisol Pech" }).click();
    const detalle = main(page).getByTestId("pedido-detalle");
    await expect(detalle.getByRole("heading", { name: "Venta 1001" })).toBeVisible();
    await expect(detalle.getByText("Tacos al pastor (orden)")).toBeVisible();
    await expect(detalle.getByText("Pedidos recientes")).toBeVisible();
    await expect(detalle.getByTestId("detalle-total")).toHaveText("$286.00");
    await sana(page, "detalle de pedido", info.project.name.endsWith("oscuro"));
    vigilante.verificar();
    await foto(page, "pedido-detalle", info.project.name);
    await detalle.getByRole("button", { name: "Volver" }).click();
    await expect(main(page).getByTestId("mapa-entrega")).toBeVisible();
  });

  test("Dialogos: Reportar incidencia (nota obligatoria) y «¿Cancelar este pedido?» @oscuro", async ({ page, mock, vigilante }, info) => {
    const oscuro = info.project.name.endsWith("oscuro");
    await ir(page, "/pedidos");
    const fila = main(page).locator('[data-testid^="pedido-"]').filter({ hasText: "Marisol Pech" }).first();
    await mock.limpiarRegistro();
    await fila.getByRole("button", { name: "Incidencia" }).click();
    const incidencia = dialogo(page, "Reportar incidencia");
    await expect(incidencia).toBeVisible();
    await incidencia.getByRole("button", { name: "Reportar incidencia" }).click();
    await expect(incidencia.getByText("Escribe qué pasó antes de reportar la incidencia.")).toBeVisible();
    expect(await mock.buscar({ metodo: "PATCH", ruta: "/status" })).toHaveLength(0);
    await foto(page, "pedidos-dialogo-incidencia", info.project.name);
    await page.keyboard.press("Escape");
    await expect(incidencia).toBeHidden();

    await fila.getByRole("button", { name: "Cancelar pedido" }).click();
    const cancelar = dialogo(page, "¿Cancelar este pedido?");
    await expect(cancelar).toBeVisible();
    await expect(cancelar.getByRole("button", { name: "Sí, cancelar pedido" })).toBeDisabled();
    // Con un dialogo modal el resto de la pagina queda oculto a la accesibilidad (sin h1): se mide solo desborde y tema.
    await afirmarSinScrollHorizontal(page);
    await afirmarModo(page, oscuro ? "oscuro" : "claro");
    await foto(page, "pedidos-dialogo-cancelar", info.project.name);
    vigilante.verificar();
  });
});
