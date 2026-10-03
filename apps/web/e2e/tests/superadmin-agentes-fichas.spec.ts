// SA-L-09 y SA-L-10: navegacion de la seccion AGENTES del superadmin (fichas de agente y Model Ops) en claro, oscuro y movil (las pruebas
// marcadas @oscuro corren en los 4 proyectos). Contra la API simulada: nunca la base ni Vercel reales. Son pantallas de solo lectura:
// ningun control escribe (el mock registra cada peticion).
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";

const FICHAS = [
  { ruta: "/superadmin/agente-extractor", titulo: "Agente extractor", visible: ["Documentos extraídos", "Sin verdad de terreno todavía", "Costo por modelo"] },
  { ruta: "/superadmin/agente-conciliacion", titulo: "Agente de conciliación", visible: ["Movimientos conciliados", "20 motor · 6 IA aprobada · 4 manual"] },
  { ruta: "/superadmin/agente-whatsapp", titulo: "Agente de WhatsApp y voz", visible: ["Minutos de voz", "Tasa de escalamiento", "Desglose por vertical"] },
] as const;

test.describe("fichas de agente y Model Ops @captura", () => {
  for (const f of FICHAS) {
    test(`${f.titulo}: un solo h1, cifras reales, sin desborde y modo correcto @oscuro`, async ({ page, iniciarSesion, mock, vigilante }, info) => {
      await iniciarSesion("superadmin");
      await page.goto(f.ruta);
      await afirmarPantallaSana(page, f.titulo);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(f.titulo);
      for (const texto of f.visible) await expect(page.getByText(texto, { exact: false }).first()).toBeVisible();
      await afirmarSinScrollHorizontal(page);
      await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
      expect(await mock.buscar({ metodo: "GET", ruta: `/superadmin/agentes/${f.ruta.split("/").pop()!.replace("agente-", "")}` })).not.toHaveLength(0);
      vigilante.verificar();
    });
  }

  test("Model Ops: una fila por rol, circuit breaker 'no legible', nota de solo lectura y sin desborde @oscuro", async ({ page, iniciarSesion, vigilante }, info) => {
    await iniciarSesion("superadmin");
    await page.goto("/superadmin/model-ops");
    await afirmarPantallaSana(page, "model ops");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Model Ops");
    await expect(page.getByText("restaurantes:whatsapp_agent").first()).toBeVisible();
    await expect(page.getByText("no legible").first()).toBeVisible();
    await expect(page.getByText(/no versiona prompts ni cambia modelos/)).toBeVisible();
    await afirmarSinScrollHorizontal(page);
    await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
    vigilante.verificar();
  });

  test("el Resumen enlaza a las tres fichas y la navegacion llega a cada una; ninguna escribe", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("superadmin");
    for (const f of FICHAS) {
      await page.goto("/superadmin");
      const enlace = page.locator(`main#contenido-principal a[href="${f.ruta}"]`);
      await expect(enlace).toBeVisible();
      await enlace.click();
      await expect(page).toHaveURL(new RegExp(`${f.ruta}$`));
      await afirmarPantallaSana(page, f.titulo);
    }
    expect(await mock.escrituras()).toHaveLength(0);
    vigilante.verificar();
  });
});
