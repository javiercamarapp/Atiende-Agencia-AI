// QA adversarial ronda 2 (lente botones) -- matriz visual de lo que la matriz base no recorre: la ficha del cliente (Cliente 360), el 404 dentro
// del shell y los dialogos nuevos de Pedidos (Reglas del autopiloto, Cancelar con motivo, Historial del pedido, ticket de cocina), en los 4
// proyectos (claro/oscuro x escritorio/movil): tema aplicado, sin desborde horizontal, un solo <main>, a lo mucho un <h1>, y cada dialogo
// cabe en el ancho de la pantalla con su boton principal alcanzable.
import type { Locator, Page } from "@playwright/test";
import { afirmarModo } from "../../helpers/ds.ts";
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { BASE, ir } from "../../helpers/recorrido.ts";

const main = (page: Page) => page.locator("main#contenido-principal");

async function medirPagina(page: Page, contexto: string, oscuro: boolean): Promise<string[]> {
  await expect(page.getByText(/^Cargando/)).toHaveCount(0, { timeout: 15_000 });
  await afirmarPantallaSana(page, contexto);
  await afirmarModo(page, oscuro ? "oscuro" : "claro");
  const defectos: string[] = [];
  const h1 = await page.locator("h1").count();
  if (h1 > 1) defectos.push(`${contexto}: ${h1} <h1>`);
  if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) defectos.push(`${contexto}: desborde horizontal`);
  return defectos;
}

async function medirDialogo(page: Page, d: Locator, contexto: string, botonPrincipal: string | RegExp): Promise<string[]> {
  await expect(d).toBeVisible();
  const defectos: string[] = [];
  const caja = await d.boundingBox();
  const vw = page.viewportSize()!.width;
  if (caja && (caja.x < -1 || caja.x + caja.width > vw + 1)) defectos.push(`${contexto}: el dialogo se sale del ancho (${Math.round(caja.x)}..${Math.round(caja.x + caja.width)} de ${vw})`);
  const boton = d.getByRole("button", { name: botonPrincipal }).first();
  await boton.scrollIntoViewIfNeeded();
  if (!(await boton.isVisible())) defectos.push(`${contexto}: boton principal no visible`);
  const desbordeInterno = await d.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  if (desbordeInterno) defectos.push(`${contexto}: contenido del dialogo desborda a lo ancho`);
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();
  return defectos;
}

test.describe("restaurantes R2 botones: matriz visual de ficha, 404 y dialogos @oscuro @recorrido", () => {
  test("ficha del cliente, 404 del shell y dialogos de Pedidos se ven sanos en este proyecto", async ({ page, iniciarSesion, vigilante }, info) => {
    test.setTimeout(120_000);
    const oscuro = info.project.name.endsWith("oscuro");
    await iniciarSesion("restaurantes", "owner");
    const defectos: string[] = [];

    await ir(page, "/clientes/cli-1");
    await expect(main(page).getByRole("heading", { name: "Marisol Pech" })).toBeVisible();
    defectos.push(...(await medirPagina(page, "/clientes/cli-1", oscuro)));

    await page.goto(`${BASE}/no-existe-esta-ruta`);
    await expect(main(page)).toBeVisible();
    defectos.push(...(await medirPagina(page, "404 en el shell", oscuro)));

    await ir(page, "/pedidos");
    const tarjeta = main(page).locator("[class*=card]").filter({ hasText: "Marisol Pech" }).first();
    await expect(tarjeta).toBeVisible();
    defectos.push(...(await medirPagina(page, "/pedidos", oscuro)));
    await main(page).getByRole("button", { name: "Reglas del autopiloto" }).click();
    defectos.push(...(await medirDialogo(page, dialogo(page, "Reglas del autopiloto"), "Reglas del autopiloto", /Guardar/)));
    await tarjeta.getByRole("button", { name: "Marcar Cancelado" }).click();
    defectos.push(...(await medirDialogo(page, dialogo(page, "Cancelar pedido"), "Cancelar pedido", "Cancelar el pedido")));
    await tarjeta.getByRole("button", { name: "Historial", exact: true }).click();
    defectos.push(...(await medirDialogo(page, dialogo(page), "Historial del pedido", /Cerrar/)));
    await tarjeta.getByRole("button", { name: "Vista previa" }).click();
    defectos.push(...(await medirDialogo(page, dialogo(page), "Ticket de cocina", /Imprimir|Reimprimir/)));

    expect(defectos, "defectos visuales").toEqual([]);
    vigilante.verificar();
  });
});
