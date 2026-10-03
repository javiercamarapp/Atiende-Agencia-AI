// UNI-RES-licitaciones: Resumen de licitaciones de punta a punta contra la API simulada (e2e/mock-api/fixtures/licitaciones.ts):
// saludo, destacado "Convocatorias abiertas", KPIs con las cifras sembradas, orquestacion de agentes, ultima corrida real de la
// ingesta y "Sin corridas registradas." para el resto, un solo h1, sin desborde horizontal y barra inferior en movil. Las pruebas
// @oscuro corren tambien en los proyectos oscuros. Con CAPTURAS_RESUMEN_DIR guarda capturas (nunca en CI).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { barraMovil, esMovil } from "../helpers/navegacion.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";

const RUTA = `/licitaciones/${licitaciones.orgSlug}/panel`;

test.describe("resumen de licitaciones @resumen", () => {
  test("owner: saludo, destacado, KPIs y agentes con lo que devuelve la API @oscuro", async ({ page, iniciarSesion, mock, vigilante }, info) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(RUTA);
    await afirmarPantallaSana(page, "resumen licitaciones");

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/^(Buenos días|Buenas tardes|Buenas noches), /);
    await expect(page.getByTestId("odometro")).toContainText("Convocatorias abiertas");
    const kpi = (nombre: string) => page.getByRole("link", { name: new RegExp(nombre) }).first();
    await expect(kpi("Recordatorios de plazo")).toContainText(/Recordatorios de plazo\s*1(?!\d)/);
    await expect(kpi("Firmantes autorizados")).toContainText(/Firmantes autorizados\s*1(?!\d)/);
    await expect(kpi("Fuentes obsoletas")).toContainText("1 de 2");
    await expect(page.getByRole("region", { name: "Orquestación de agentes" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Descubrimiento e ingesta/ })).toContainText("1 fuente obsoleta de 2");
    const corrida = page.getByRole("region", { name: "Agentes — última corrida" });
    await expect(corrida).toContainText("Ingesta · CompraNet");
    await expect(corrida).toContainText("24 de 24 resultados");
    await expect(corrida).toContainText("Listado SAT 2026-09");
    await expect(corrida).toContainText("Último aviso generado");
    await expect(corrida.getByText("Sin corridas registradas.").first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Ver convocatorias/ })).toHaveAttribute("href", `/licitaciones/${licitaciones.orgSlug}/convocatorias`);
    await afirmarSinScrollHorizontal(page);
    await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
    expect((await mock.buscar({ metodo: "GET", ruta: /\/sources\/runs/ })).length).toBeGreaterThan(0);
    vigilante.verificar();

    const destino = process.env["CAPTURAS_RESUMEN_DIR"];
    if (destino) {
      mkdirSync(destino, { recursive: true });
      await page.screenshot({ path: join(destino, `${info.project.name}.png`), fullPage: true });
    }
  });

  test("movil: la barra inferior sigue visible y el contenido no queda tapado", async ({ page, iniciarSesion, vigilante }) => {
    test.skip(!esMovil(page), "la barra inferior es solo de movil");
    await iniciarSesion("licitaciones", "owner");
    await page.goto(RUTA);
    await afirmarPantallaSana(page, "resumen licitaciones movil");
    await expect(barraMovil(page)).toBeVisible();
    await afirmarSinScrollHorizontal(page);
    vigilante.verificar();
  });
});
