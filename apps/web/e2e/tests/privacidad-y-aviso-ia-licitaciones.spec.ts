// L-20 / L-33 de punta a punta contra la API simulada: (1) owner/admin entra a Privacidad desde el menu y ve la pantalla real
// de la organizacion; un rol sin permiso no ve la entrada y la URL directa da estado denegado; (2) el aviso de uso de IA
// aparece en requisitos, propuesta tecnica y junta cuando la API devuelve contenido de IA, y no aparece cuando todo vino de
// reglas o de captura manual. Corre en claro y movil; las pruebas @oscuro tambien en oscuro.
import { afirmarModo, afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { irASeccion, seccionesDelPanel } from "../helpers/navegacion.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";

const BASE = `/licitaciones/${licitaciones.orgSlug}`;
const AVISO = { name: "Aviso de uso de inteligencia artificial" };

test.describe("licitaciones: privacidad de la organizacion @humo @oscuro", () => {
  for (const rol of ["owner", "admin"] as const) {
    test(`${rol}: abre Privacidad desde el menu y ve las solicitudes ARCO y la retencion`, async ({ page, iniciarSesion, mock, vigilante }) => {
      await iniciarSesion("licitaciones", rol);
      await page.goto(`${BASE}/panel`);
      await irASeccion(page, { texto: "Privacidad", href: `${BASE}/privacidad` });
      await expect(page).toHaveURL(`${BASE}/privacidad`);
      await expect(page.getByRole("heading", { name: "Privacidad de la organización" })).toBeVisible();
      await expect(page.getByText("AAAAAAAA")).toBeVisible();
      await expect(page.getByText("Licitaciones todavía no registra solicitudes ARCO propias")).toBeVisible();
      await afirmarPantallaSana(page, "privacidad");
      await afirmarSinScrollHorizontal(page);
      await afirmarModo(page, test.info().project.name.endsWith("oscuro") ? "oscuro" : "claro");
      expect((await mock.buscar({ metodo: "GET", ruta: "/v1/privacidad/resumen" })).length).toBeGreaterThan(0);
      vigilante.verificar();
    });
  }

  test("staff: no ve la entrada y la URL directa muestra el estado denegado sin llamar a la API", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "staff");
    await page.goto(`${BASE}/panel`);
    expect((await seccionesDelPanel(page)).map((e) => e.href)).not.toContain(`${BASE}/privacidad`);
    await page.goto(`${BASE}/privacidad`);
    await expect(page.getByText("Solo el owner o un admin de la organización puede administrar la privacidad.")).toBeVisible();
    expect(await mock.buscar({ metodo: "GET", ruta: "/v1/privacidad/resumen" })).toHaveLength(0);
    vigilante.verificar();
  });
});

test.describe("licitaciones: aviso de uso de IA @humo @oscuro", () => {
  test("requisitos: con extraccion por IA muestra el aviso; solo por reglas no", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${BASE}/convocatorias/tnd-1/requisitos`);
    await expect(page.getByRole("note", AVISO)).toBeVisible();
    await expect(page.getByRole("note", AVISO)).toContainText("1 requisito fue extraído de las bases con inteligencia artificial");
    await afirmarSinScrollHorizontal(page);
    await afirmarModo(page, test.info().project.name.endsWith("oscuro") ? "oscuro" : "claro");

    await page.goto(`${BASE}/convocatorias/tnd-2/requisitos`);
    await expect(page.getByText("Presentar acta constitutiva vigente.")).toBeVisible();
    await expect(page.getByRole("note", AVISO)).toHaveCount(0);
    vigilante.verificar();
  });

  test("propuesta tecnica: avisa si algun requisito vino de IA y aclara que las secciones no se generan con IA", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${BASE}/convocatorias/tnd-1/propuesta-tecnica`);
    await expect(page.getByRole("note", AVISO)).toBeVisible();
    await expect(page.getByRole("note", AVISO)).toContainText("sin generar texto con IA");
    await page.goto(`${BASE}/convocatorias/tnd-2/propuesta-tecnica`);
    await expect(page.getByRole("heading", { name: "Propuesta técnica", exact: true })).toBeVisible();
    await expect(page.getByRole("note", AVISO)).toHaveCount(0);
    vigilante.verificar();
  });

  test("junta de aclaraciones: aviso solo con preguntas del asistente", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${BASE}/convocatorias/tnd-1/sala-guerra`);
    await page.getByRole("tab", { name: "Junta de aclaraciones" }).click();
    await expect(page.getByText("Borrador del asistente", { exact: true })).toBeVisible();
    await expect(page.getByRole("note", AVISO)).toBeVisible();

    await page.goto(`${BASE}/convocatorias/tnd-2/sala-guerra`);
    await page.getByRole("tab", { name: "Junta de aclaraciones" }).click();
    await expect(page.getByText("Se aceptan contratos estatales como experiencia comprobable? (q-1)")).toBeVisible();
    await expect(page.getByRole("note", AVISO)).toHaveCount(0);
    vigilante.verificar();
  });
});
