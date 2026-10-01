// Aserciones del sistema de diseno sobre el shell compartido (VerticalShell): se ejercitan con citas porque su
// fixture es la mas completa; el shell es el mismo en las 6 verticales y en superadmin.
// Las pruebas marcadas @oscuro corren tambien en los proyectos escritorio-oscuro y movil-oscuro.
import { afirmarModo, afirmarSinScrollHorizontal, afirmarSkipLink, afirmarUnSoloMain } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { citas } from "../mock-api/fixtures/citas.ts";

const RESUMEN = `/citas/${citas.orgSlug}/resumen`;

test.describe("DS del shell @ds", () => {
  test("la bandera ?ds=v2 se retiro: el parametro no cambia nada y <html> no lleva data-theme", async ({ page, iniciarSesion }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(`${RESUMEN}?ds=v2`);
    await afirmarPantallaSana(page, "resumen con ?ds=v2");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
    // Nada se recuerda en localStorage: la siguiente navegacion sin parametro tampoco la enciende.
    await page.goto(RESUMEN);
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
    expect(await page.evaluate(() => window.localStorage.getItem("atiende-ds"))).toBeNull();
  });

  test("el shell ya no pinta migas de pan (retiradas con el marco nuevo, UNI-1)", async ({ page, iniciarSesion }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(RESUMEN);
    await afirmarPantallaSana(page, "resumen");
    await expect(page.getByTestId("vertical-migas")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Migas de pan" })).toHaveCount(0);
  });

  test("shell: un solo <main>, skip link, foco y sin desborde horizontal @oscuro", async ({ page, iniciarSesion, vigilante }, info) => {
    await iniciarSesion("citas", "owner");
    await page.goto(RESUMEN);
    await afirmarUnSoloMain(page);
    await afirmarSkipLink(page);
    await afirmarSinScrollHorizontal(page);
    // Los proyectos "-oscuro" siguen al sistema (colorScheme dark); el shell monta ThemeSelector y aplica `html.dark`.
    await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
    vigilante.verificar();
  });

  // BUG-E2E-002 (resuelto en UNI-4): la barra superior del shell pinta el nombre de la pagina en un <p>; el <h1> es solo de la pagina.
  // Tambien en movil (UNI-1): la barra de escritorio esta oculta, pero el nombre de la pagina se ve en la cabecera movil.
  test("cada pantalla tiene un solo <h1> (BUG-E2E-002)", async ({ page, iniciarSesion }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(RESUMEN);
    await expect(page.getByRole("heading", { name: "Resumen", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });
});
