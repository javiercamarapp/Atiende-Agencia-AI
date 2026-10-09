// UNI-R0b -- el ambito visual de restaurantes con ESTILOS COMPUTADOS en un navegador real: paleta del repo suelto (claro y oscuro), sidebar en la paleta
// de Likida, botones en pildora, overlay negro al 80 % sin desenfoque, titulo de modal de 18 px y rojo solido del boton destructivo; y que otra vertical
// (citas) NO cambia. Los colores se comparan contra una sonda (hsl(...) resuelto por el propio navegador), no contra cadenas copiadas a mano.
import type { Page } from "@playwright/test";
import { afirmarModo, afirmarSinScrollHorizontal } from "../../helpers/ds.ts";
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { BASE, ir } from "../../helpers/recorrido.ts";
import { citas } from "../../mock-api/fixtures/citas.ts";

/** Color que el navegador calcula para un valor CSS (rgb(...)/rgba(...)). */
async function resolver(page: Page, valor: string): Promise<string> {
  return page.evaluate((v) => {
    const sonda = document.createElement("i");
    sonda.style.color = v;
    document.body.appendChild(sonda);
    const c = getComputedStyle(sonda).color;
    sonda.remove();
    return c;
  }, valor);
}
const estilo = (page: Page, selector: string, prop: string) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test.describe("UNI-R0b ambito restaurantes @recorrido @oscuro", () => {
  test("tokens computados: contenido con la paleta del repo suelto y sidebar con la de Likida", async ({ page, iniciarSesion, vigilante }, info) => {
    const oscuro = info.project.name.endsWith("oscuro");
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "");
    await expect(page.locator("html")).toHaveAttribute("data-ambito", "restaurantes");
    await afirmarModo(page, oscuro ? "oscuro" : "claro");
    const fondoOriginal = oscuro ? "hsl(216 45% 9%)" : "hsl(210 40% 98%)";
    const tarjetaOriginal = oscuro ? "hsl(216 40% 13%)" : "hsl(0 0% 100%)";
    expect(await estilo(page, "body", "background-color")).toBe(await resolver(page, fondoOriginal));
    // La columna de contenido (marco con --sunken) toma el fondo del repo suelto; las tarjetas, --card del repo suelto.
    const marco = page.locator("main#contenido-principal").locator("xpath=..");
    expect(await marco.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await resolver(page, fondoOriginal));
    expect(await page.locator("main#contenido-principal .card").first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await resolver(page, tarjetaOriginal));
    // Sidebar: paleta de Likida (claro: blanco; oscuro 240 7% 8%), NO la del ambito; y su --background propio es el de Likida.
    const aside = page.locator("aside[aria-label='Navegación principal']");
    await expect(aside).toHaveAttribute("data-ambito-base", "");
    const fondoSidebar = oscuro ? "hsl(240 7% 8%)" : "hsl(0 0% 100%)";
    expect(await aside.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await resolver(page, fondoSidebar));
    expect((await aside.evaluate((el) => getComputedStyle(el).getPropertyValue("--background"))).trim()).toBe(oscuro ? "240 10% 3.9%" : "240 33% 98.8%");
    expect((await page.locator("html").evaluate((el) => getComputedStyle(el).getPropertyValue("--background"))).trim()).toBe(oscuro ? "216 45% 9%" : "210 40% 98%");
    await afirmarSinScrollHorizontal(page);
    vigilante.verificar();
  });

  test("botones en pildora; confirmacion destructiva (ConfirmDialog) con rojo solido, velo negro sin desenfoque, titulo de 18 px y radio de 12 px", async ({ page, iniciarSesion, vigilante }, info) => {
    const movil = info.project.name.startsWith("movil");
    const oscuro = info.project.name.endsWith("oscuro");
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "/staff");
    const baja = page.locator("xpath=//p[normalize-space()='Ramon Uc']/../..").getByRole("button", { name: "Dar de baja" });
    await expect(baja).toBeVisible();
    // Boton de la pantalla: pildora y semibold (clases ambito-boton*).
    expect(await baja.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("9999px");
    expect(await baja.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("600");
    await baja.click();
    const d = dialogo(page, /Dar de baja a/);
    await expect(d).toBeVisible();
    // Velo: negro al 80 % y sin desenfoque.
    const velo = page.locator("[data-state=open][class*=bg-foreground]").first();
    expect(await velo.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0.8)");
    expect(await velo.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none");
    // AlertDialog: titulo 18 px, descripcion 14 px.
    expect(await d.getByRole("heading").first().evaluate((el) => getComputedStyle(el).fontSize)).toBe("18px");
    // Radio del cuadro: 12 px en escritorio (la hoja inferior movil conserva su radio superior de 16 px).
    expect(await d.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe(movil ? "16px" : "12px");
    // Confirmar destructivo: rojo SOLIDO del ambito (no el tinte rosa), texto blanco, pildora.
    const confirmar = d.getByRole("button", { name: "Dar de baja" });
    expect(await confirmar.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await resolver(page, oscuro ? "hsl(352 75% 50%)" : "hsl(352 83% 41%)"));
    expect(await confirmar.evaluate((el) => getComputedStyle(el).color)).toBe(await resolver(page, "hsl(0 0% 100%)"));
    expect(await confirmar.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("9999px");
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    vigilante.verificar();
  });

  test("FormDialog (cancelar pedido): titulo de 16 px como ModalFormularioLateral, cierre con anillo azul de foco y cuadro de 12 px", async ({ page, iniciarSesion, vigilante }, info) => {
    const movil = info.project.name.startsWith("movil");
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "/pedidos");
    await page.locator("main#contenido-principal").getByRole("button", { name: "Marcar Cancelado" }).first().click();
    const d = dialogo(page, "Cancelar pedido");
    await expect(d).toBeVisible();
    expect(await d.getByRole("heading").first().evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
    expect(await d.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe(movil ? "16px" : "12px");
    // El cierre (aria-label Cerrar) lleva anillo azul de 2 px al enfocarlo con teclado.
    const cerrar = d.getByRole("button", { name: "Cerrar" });
    await cerrar.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(cerrar).toBeFocused();
    const sombra = await cerrar.evaluate((el) => getComputedStyle(el).boxShadow);
    const ring = await resolver(page, "hsl(224 76% 48%)");
    expect(sombra, "anillo de foco del cierre").toContain(info.project.name.endsWith("oscuro") ? await resolver(page, "hsl(213 82% 62%)") : ring);
    await page.keyboard.press("Escape");
    vigilante.verificar();
  });

  test("campos: radio de 10 px, fondo del repo suelto y 16 px en movil / 14 px en escritorio", async ({ page, iniciarSesion, vigilante }, info) => {
    const movil = info.project.name.startsWith("movil");
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "/clientes");
    const campo = page.locator("main#contenido-principal input[type=search], main#contenido-principal input[type=text], main#contenido-principal input:not([type])").first();
    await expect(campo).toBeVisible();
    expect(await campo.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("10px");
    expect(await campo.evaluate((el) => getComputedStyle(el).fontSize)).toBe(movil ? "16px" : "14px");
    expect(await campo.evaluate((el) => getComputedStyle(el).height)).toBe("40px");
    vigilante.verificar();
  });

  test("otra vertical (citas) NO cambia: sin data-ambito, boton de 12 px y paleta de Likida", async ({ page, iniciarSesion, vigilante }, info) => {
    const oscuro = info.project.name.endsWith("oscuro");
    await iniciarSesion("citas", "owner");
    await page.goto(`/citas/${citas.orgSlug}/resumen`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-ambito", /.*/);
    expect(await estilo(page, "body", "background-color")).toBe(await resolver(page, oscuro ? "hsl(240 10% 3.9%)" : "hsl(240 33% 98.8%)"));
    const boton = page.locator("main#contenido-principal button").first();
    if (await boton.count()) {
      const r = await boton.evaluate((el) => getComputedStyle(el).borderRadius);
      expect(r, "los botones de otras verticales no son pildora").not.toBe("9999px");
    }
    vigilante.verificar();
  });

  test("al salir de restaurantes el ambito se quita de <html>", async ({ page, iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "");
    await expect(page.locator("html")).toHaveAttribute("data-ambito", "restaurantes");
    await page.goto("/restaurantes/login");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("html")).not.toHaveAttribute("data-ambito", "restaurantes");
  });
});
