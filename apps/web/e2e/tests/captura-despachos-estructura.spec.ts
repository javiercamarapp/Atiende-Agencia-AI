// Estructura y formularios de despachos (UNI-C-despachos.1/.2): en cada pantalla revisada hay UN solo <h1> (el del PageHeader), el contenido
// ocupa todo el ancho y la pagina no desborda en horizontal (390 px incluido). Las pruebas marcadas @oscuro corren en los 4 proyectos
// (escritorio/movil, claro/oscuro). El JPG solo se escribe si CAPTURAS_DESPACHOS_DIR apunta a una carpeta (p. ej.
// docs/diseno-uni-c-despachos/despues), asi CI no genera nada.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { despachos } from "../mock-api/fixtures/despachos.ts";

const PANTALLAS: ReadonlyArray<{ readonly ruta: string; readonly titulo: RegExp }> = [
  { ruta: "cartera", titulo: /Cartera de clientes/ },
  { ruta: "cfdi", titulo: /^CFDI$/ },
  { ruta: "vencimientos", titulo: /Vencimientos fiscales/ },
  { ruta: "cobranza", titulo: /^Cobranza$/ },
  { ruta: "libro-contable", titulo: /Libro contable/ },
  { ruta: "portal-cliente", titulo: /Portal del cliente/ },
  { ruta: "staff", titulo: /^Equipo$/ },
  { ruta: "configuracion", titulo: /^Configuración$/ },
];

test.describe("estructura de despachos @captura", () => {
  for (const pantalla of PANTALLAS) {
    test(`${pantalla.ruta}: un solo h1, sin desborde horizontal y captura @oscuro`, async ({ page, iniciarSesion, vigilante }, info) => {
      await iniciarSesion("despachos", "admin");
      await page.goto(`/despachos/${despachos.orgSlug}/${pantalla.ruta}`);
      await afirmarPantallaSana(page, pantalla.ruta);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(pantalla.titulo);
      await afirmarSinScrollHorizontal(page);
      await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
      vigilante.verificar();

      const destino = process.env["CAPTURAS_DESPACHOS_DIR"];
      if (destino) {
        mkdirSync(destino, { recursive: true });
        await page.screenshot({ path: join(destino, `${pantalla.ruta}-${info.project.name}.jpg`), type: "jpeg", quality: 70, fullPage: true });
      }
    });
  }
});
