// Listados de despachos migrados a DataTable (UNI-C-despachos.3): tabla en escritorio, tarjetas en movil (sin scroll horizontal de
// pagina a 375 px) y modo claro/oscuro correcto. Las pruebas marcadas @oscuro corren en los 4 proyectos. El PNG solo se escribe si
// CAPTURAS_DATATABLE_DIR apunta a una carpeta (p. ej. docs/diseno-uni-c-despachos), asi CI no genera nada.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { despachos } from "../mock-api/fixtures/despachos.ts";

const LISTADOS = [
  { ruta: "cobranza", nombre: "cobranza", tabla: "Cuentas por cobrar", texto: "Abarrotes del Sureste SA de CV" },
  { ruta: "vencimientos", nombre: "vencimientos", tabla: "Vencimientos fiscales", texto: "Regla 4.5.1 RMF" },
  { ruta: "staff", nombre: "staff", tabla: "Staff activo", texto: "Ana Contadora" },
] as const;

test.describe("listados de despachos con DataTable @captura", () => {
  for (const l of LISTADOS) {
    test(`${l.nombre}: DataTable con datos, sin desborde horizontal y captura por proyecto @oscuro`, async ({ page, iniciarSesion, vigilante }, info) => {
      await iniciarSesion("despachos", "admin");
      await page.goto(`/despachos/${despachos.orgSlug}/${l.ruta}`);
      await afirmarPantallaSana(page, l.nombre);
      await expect(page.getByText(l.texto).first()).toBeVisible();
      const movil = info.project.name.startsWith("movil");
      // Escritorio: <table> con nombre accesible. Movil: tarjetas (sin <table>), nunca scroll horizontal de la pagina.
      if (movil) await expect(page.getByRole("table", { name: l.tabla })).toHaveCount(0);
      else await expect(page.getByRole("table", { name: l.tabla })).toBeVisible();
      await afirmarSinScrollHorizontal(page);
      await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
      vigilante.verificar();

      const destino = process.env["CAPTURAS_DATATABLE_DIR"];
      if (destino) {
        mkdirSync(destino, { recursive: true });
        await page.screenshot({ path: join(destino, `${l.nombre}-${info.project.name}.png`), fullPage: true });
      }
    });
  }
});
