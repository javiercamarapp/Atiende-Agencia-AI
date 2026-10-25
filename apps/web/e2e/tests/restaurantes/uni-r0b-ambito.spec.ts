// UNI-R0b -- el ambito visual de restaurantes con ESTILOS COMPUTADOS en un navegador real: paleta del repo suelto (claro y oscuro), sidebar en la paleta
// de Likida, botones en pildora, overlay negro al 80 % sin desenfoque, titulo de modal de 18 px y rojo solido del boton destructivo; y que otra vertical
// (citas) NO cambia. Los colores se comparan contra una sonda (hsl(...) resuelto por el propio navegador), no contra cadenas copiadas a mano.
import type { Page } from "@playwright/test";
import { afirmarModo, afirmarSinScrollHorizontal } from "../../helpers/ds.ts";
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { BASE, ir } from "../../helpers/recorrido.ts";
import { citas } from "../../mock-api/fixtures/citas.ts";

const SEGUNDA = { propertyId: "00000000-0000-4000-8000-00000000a2b2", name: "Sucursal Norte", slug: "norte" };

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
    await page.locator("main#contenido-principal").getByRole("button", { name: "Cancelar pedido" }).first().click();
    const d = dialogo(page, "¿Cancelar este pedido?");
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
    await page.goto(`/citas/${citas.orgSlug}/servicios`);
    await expect(page.locator("main#contenido-principal")).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-ambito", /.*/);
    expect(await estilo(page, "body", "background-color")).toBe(await resolver(page, oscuro ? "hsl(240 10% 3.9%)" : "hsl(240 33% 98.8%)"));
    const boton = page.locator("button.ambito-boton").first(); // todo <Button> lleva la clase; sin ambito no debe tener efecto
    await expect(boton, "citas debe tener al menos un boton para comparar").toBeVisible();
    expect(await boton.evaluate((el) => getComputedStyle(el).borderRadius), "los botones de otras verticales no son pildora").not.toBe("9999px");
    expect(await boton.evaluate((el) => el.className), "sin clases del ambito fuera de restaurantes en la funcionalidad").not.toContain("ambito-ov");
    vigilante.verificar();
  });

  test("al salir de restaurantes (navegacion SPA y cierre de sesion) el ambito se quita de <html> sin recargar", async ({ page, iniciarSesion }, info) => {
    await iniciarSesion("restaurantes", "owner");
    await iniciarSesion("citas", "owner");
    await ir(page, "");
    await expect(page.locator("html")).toHaveAttribute("data-ambito", "restaurantes");
    await page.evaluate(() => { (window as unknown as { __sinRecarga: boolean }).__sinRecarga = true; });
    const spa = (ruta: string) => page.evaluate((r) => { history.pushState({}, "", r); window.dispatchEvent(new PopStateEvent("popstate")); }, ruta);
    // Restaurantes -> citas (history API + popstate: lo que hace react-router).
    await spa(`/citas/${citas.orgSlug}/resumen`);
    await expect(page.locator("main#contenido-principal")).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-ambito", /.*/);
    // Y de vuelta lo reaplica.
    await spa(BASE);
    await expect(page.locator("html")).toHaveAttribute("data-ambito", "restaurantes");
    // Cerrar sesion desde el sidebar (navegacion SPA al login) lo quita.
    if (!info.project.name.startsWith("movil")) {
      await page.getByRole("button", { name: "Cerrar sesión" }).first().click();
      await expect(page).toHaveURL(/\/restaurantes\/login/);
      await expect(page.locator("html")).not.toHaveAttribute("data-ambito", "restaurantes");
    }
    expect(await page.evaluate(() => (window as unknown as { __sinRecarga?: boolean }).__sinRecarga), "no hubo recarga completa").toBe(true);
  });

  test("el sidebar queda EXACTO: color heredado de Likida, selector de sucursal y su lista con la paleta base", async ({ page, iniciarSesion, mock, vigilante }, info) => {
    test.skip(info.project.name.startsWith("movil"), "el sidebar de escritorio no existe en 375 px");
    const oscuro = info.project.name.endsWith("oscuro");
    await iniciarSesion("restaurantes", "owner");
    await mock.agregarAEstado("rest.branches", SEGUNDA);
    await ir(page, "/pedidos");
    const aside = page.locator("aside[aria-label='Navegación principal']");
    expect(await aside.evaluate((el) => getComputedStyle(el).color)).toBe(await resolver(page, oscuro ? "hsl(240 4.8% 95.9%)" : "hsl(18 27.8% 7.1%)"));
    const selector = aside.locator("#restaurantes-sucursal-activa");
    await expect(selector).toBeVisible();
    // UNI-MARCO: el selector es el "hundido gris" del pie del sidebar (fondo canvas, no el blanco de tarjeta), 13 px y radio de rounded-xl.
    expect(await selector.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await resolver(page, oscuro ? "hsl(240 10% 6.1%)" : "hsl(240 9% 97.8%)"));
    expect(await selector.evaluate((el) => getComputedStyle(el).fontSize)).toBe("13px");
    expect(await selector.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("12px");
    await selector.click();
    const lista = page.getByRole("listbox");
    await expect(lista).toBeVisible();
    // Su lista (portal en <body>) usa la paleta base, no la navy del ambito.
    expect(await lista.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await resolver(page, oscuro ? "hsl(240 7% 8%)" : "hsl(0 0% 100%)"));
    await page.keyboard.press("Escape");
    vigilante.verificar();
  });

  test("sin regresiones de espaciado: Button respeta px/texto/radio de quien llama", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "");
    // La campana ya no va en el encabezado (orden del dueno): no queda popover que medir aqui; el centro se cubre en ui-r0-overlays.spec.tsx.
    await expect(page.getByTestId("barra-pagina").getByRole("button", { name: /^Notificaciones/ }), "sin campana en la barra").toHaveCount(0);
    // Botones reales con override de quien llama, en varias pantallas: el CSS del ambito no pisa su px-N / text-xs / rounded-lg.
    let verificados = 0;
    for (const sub of ["/clientes", "/pedidos", "/agente-voz", "/historial"]) {
      await ir(page, sub);
      await page.waitForTimeout(600);
      const resultado = await page.evaluate(() => {
        const fallos: string[] = [];
        let n = 0;
        const px = (v: string) => parseFloat(v);
        for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button.ambito-boton"))) {
          const cls = Array.from(b.classList);
          const cs = getComputedStyle(b);
          const mpx = cls.find((c) => /^px-\d/.test(c) && b.classList.contains("ambito-ov-px"));
          if (mpx) { n++; const esp = parseFloat(mpx.slice(3)) * 4; if (px(cs.paddingLeft) !== esp) fallos.push(`${mpx}: paddingLeft ${cs.paddingLeft}`); }
          const mt = cls.find((c) => /^text-(xs|sm|base)$/.test(c) && b.classList.contains("ambito-ov-texto"));
          if (mt) { n++; const esp = { "text-xs": 12, "text-sm": 14, "text-base": 16 }[mt]!; if (px(cs.fontSize) !== esp) fallos.push(`${mt}: fontSize ${cs.fontSize}`); }
          if (b.classList.contains("ambito-ov-radio") && cls.includes("rounded-lg")) { n++; if (cs.borderTopLeftRadius !== "16px") fallos.push(`rounded-lg: ${cs.borderTopLeftRadius}`); }
        }
        return { fallos, n };
      });
      expect(resultado.fallos, `overrides pisados en ${sub}`).toEqual([]);
      verificados += resultado.n;
    }
    expect(verificados, "debe haber botones reales con override para comprobar").toBeGreaterThan(0);
    vigilante.verificar();
  });

  test("peligro como el original: accion de fila en contorno rojo con tinte (no solido) y confirmacion destructiva en solido", async ({ page, iniciarSesion, vigilante }, info) => {
    const oscuro = info.project.name.endsWith("oscuro");
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "/pedidos");
    const fila = page.locator("main#contenido-principal").getByRole("button", { name: "Cancelar pedido" }).first();
    await expect(fila).toBeVisible();
    expect(await fila.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await resolver(page, oscuro ? "hsl(216 40% 13%)" : "hsl(0 0% 100%)"));
    expect(await fila.evaluate((el) => getComputedStyle(el).color)).toBe(await resolver(page, oscuro ? "hsl(352 85% 70%)" : "hsl(352 83% 41%)"));
    expect(await fila.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(await resolver(page, oscuro ? "hsl(352 85% 70% / 0.3)" : "hsl(352 83% 41% / 0.3)"));
    vigilante.verificar();
  });
});
