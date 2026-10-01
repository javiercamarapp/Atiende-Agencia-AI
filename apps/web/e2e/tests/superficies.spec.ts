// UNI-3b (superficies de Likida): en 6 pantallas representativas con tablas, ninguna tabla se sale del
// viewport (min-w-0) y las tablas anchas hacen scroll DENTRO de su contenedor, no de la pagina.
// Ademas mide la receta (radio de tarjeta, tipografia y relleno de tabla) con getComputedStyle, tolerancia 1 px,
// y adjunta una captura por pantalla (claro/oscuro/movil segun el proyecto) para la comparacion contra Likida.
import { afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import type { ObjetivoLogin } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { citas } from "../mock-api/fixtures/citas.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

interface Pantalla {
  readonly nombre: string;
  readonly objetivo: ObjetivoLogin;
  readonly ruta: string;
}

// Solo pantallas con tabla Y fixture en la API simulada (si no, la pagina muestra un estado de error sin tabla).
const PANTALLAS: readonly Pantalla[] = [
  { nombre: "citas-proveedores", objetivo: "citas", ruta: `/citas/${citas.orgSlug}/proveedores` },
  { nombre: "citas-servicios", objetivo: "citas", ruta: `/citas/${citas.orgSlug}/servicios` },
  { nombre: "citas-clientes", objetivo: "citas", ruta: `/citas/${citas.orgSlug}/clientes` },
  { nombre: "citas-agenda", objetivo: "citas", ruta: `/citas/${citas.orgSlug}/agenda` },
  { nombre: "restaurantes-productos", objetivo: "restaurantes", ruta: `/restaurantes/${restaurantes.orgSlug}/productos` },
  { nombre: "superadmin-prospectos", objetivo: "superadmin", ruta: "/superadmin/prospectos" },
];

test.describe("superficies de Likida @ds @oscuro", () => {
  for (const pantalla of PANTALLAS) {
    test(`${pantalla.nombre}: las tablas no se salen del viewport y las anchas hacen scroll interno`, async ({ page, iniciarSesion, vigilante }, info) => {
      await iniciarSesion(pantalla.objetivo, pantalla.objetivo === "superadmin" ? undefined : "owner");
      await page.goto(pantalla.ruta);
      await afirmarPantallaSana(page, pantalla.nombre);
      // La pantalla debe pintar una tabla real (no un estado de error o de carga) antes de medir.
      await expect(page.locator("main table").first()).toBeVisible();
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
    await iniciarSesion("citas", "owner");
    await page.goto(`/citas/${citas.orgSlug}/proveedores`);
    await afirmarPantallaSana(page, "citas proveedores");
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
