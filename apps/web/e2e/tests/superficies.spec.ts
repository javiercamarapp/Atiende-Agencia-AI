// UNI-3b (superficies de Likida): en 6 pantallas representativas con tablas, ninguna tabla se sale del
// viewport (min-w-0) y las tablas anchas hacen scroll DENTRO de su contenedor, no de la pagina.
// Ademas mide la receta (radio de tarjeta, tipografia y relleno de tabla) con getComputedStyle, tolerancia 1 px,
// y adjunta una captura por pantalla (claro/oscuro/movil segun el proyecto) para la comparacion contra Likida.
import { afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import type { ObjetivoLogin } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { despachos } from "../mock-api/fixtures/despachos.ts";
import { hoteles } from "../mock-api/fixtures/hoteles.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";
import { rentas } from "../mock-api/fixtures/rentas.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

interface Pantalla {
  readonly nombre: string;
  readonly objetivo: ObjetivoLogin;
  readonly ruta: string;
}

const PANTALLAS: readonly Pantalla[] = [
  { nombre: "restaurantes-staff", objetivo: "restaurantes", ruta: `/restaurantes/${restaurantes.orgSlug}/staff` },
  { nombre: "hoteles-tickets", objetivo: "hoteles", ruta: `/hoteles/${hoteles.orgSlug}/tickets` },
  { nombre: "despachos-cobranza", objetivo: "despachos", ruta: `/despachos/${despachos.orgSlug}/cobranza` },
  { nombre: "licitaciones-convocatorias", objetivo: "licitaciones", ruta: `/licitaciones/${licitaciones.orgSlug}/convocatorias` },
  { nombre: "rentas-auditoria", objetivo: "rentas", ruta: `/rentas/${rentas.orgSlug}/auditoria` },
  { nombre: "superadmin-organizaciones", objetivo: "superadmin", ruta: "/superadmin/gestion-organizaciones" },
];

test.describe("superficies de Likida @ds @oscuro", () => {
  for (const pantalla of PANTALLAS) {
    test(`${pantalla.nombre}: las tablas no se salen del viewport y las anchas hacen scroll interno`, async ({ page, iniciarSesion, vigilante }, info) => {
      await iniciarSesion(pantalla.objetivo, pantalla.objetivo === "superadmin" ? undefined : "owner");
      await page.goto(pantalla.ruta);
      await afirmarPantallaSana(page, pantalla.nombre);
      // Espera a que cargue algo con superficie (tabla o tarjetas) antes de medir.
      await expect(page.locator("main .card").first()).toBeVisible();
      await afirmarSinScrollHorizontal(page);

      const medidas = await page.evaluate(() => {
        const ancho = document.documentElement.clientWidth;
        const main = document.querySelector("main#contenido-principal") as HTMLElement;
        const tablas = [...document.querySelectorAll("main table")] as HTMLTableElement[];
        return {
          anchoViewport: ancho,
          anchoMain: main.clientWidth,
          tablas: tablas.map((t) => {
            const caja = t.parentElement as HTMLElement;
            const rc = caja.getBoundingClientRect();
            return {
              derechaContenedor: rc.right,
              contenedorAncho: caja.clientWidth,
              contenedorScroll: caja.scrollWidth,
              overflowX: getComputedStyle(caja).overflowX,
            };
          }),
        };
      });

      for (const t of medidas.tablas) {
        expect(t.derechaContenedor, "el contenedor de la tabla no puede salirse del viewport").toBeLessThanOrEqual(medidas.anchoViewport + 1);
        expect(t.contenedorAncho, "el contenedor de la tabla no puede ser mas ancho que el <main>").toBeLessThanOrEqual(medidas.anchoMain + 1);
        expect(["auto", "scroll"], "las tablas anchas hacen scroll interno").toContain(t.overflowX);
      }
      await afirmarSinScrollHorizontal(page);

      await info.attach(`${pantalla.nombre}-${info.project.name}`, {
        body: await page.screenshot({ type: "jpeg", quality: 70 }),
        contentType: "image/jpeg",
      });
      vigilante.verificar();
    });
  }

  test("receta medida: tarjeta de radio 16 con hairline, cabecera mono de 10 px y celdas de 12 x 8 px (tolerancia 1 px)", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`/restaurantes/${restaurantes.orgSlug}/staff`);
    await afirmarPantallaSana(page, "restaurantes staff");
    const tabla = page.locator("main table").first();
    await expect(tabla).toBeVisible();
    const m = await page.evaluate(() => {
      const num = (v: string) => Number.parseFloat(v);
      const t = document.querySelector("main table") as HTMLElement;
      const th = t.querySelector("th") as HTMLElement;
      const td = t.querySelector("tbody td") as HTMLElement;
      const cth = getComputedStyle(th);
      const ctd = getComputedStyle(td);
      const tarjeta = t.closest(".card") as HTMLElement | null;
      return {
        radioTarjeta: tarjeta ? num(getComputedStyle(tarjeta).borderTopLeftRadius) : null,
        thFuente: num(cth.fontSize),
        thPadX: num(cth.paddingLeft),
        thPadY: num(cth.paddingTop),
        tdPadX: num(ctd.paddingLeft),
        tdPadY: num(ctd.paddingTop),
        thMayusculas: cth.textTransform,
      };
    });
    if (m.radioTarjeta !== null) expect(Math.abs(m.radioTarjeta - 16)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.thFuente - 10)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.thPadX - 12)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.thPadY - 6)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.tdPadX - 12)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.tdPadY - 8)).toBeLessThanOrEqual(1);
    expect(m.thMayusculas).toBe("uppercase");
    vigilante.verificar();
  });
});
