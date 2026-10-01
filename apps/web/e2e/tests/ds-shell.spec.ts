// Aserciones del sistema de diseno sobre el shell compartido (VerticalShell): se ejercitan con citas porque su
// fixture es la mas completa; el shell es el mismo en las 6 verticales y en superadmin.
// Las pruebas marcadas @oscuro corren tambien en los proyectos escritorio-oscuro y movil-oscuro.
import { afirmarModo, afirmarSinScrollHorizontal, afirmarSkipLink, afirmarTemaDs, afirmarUnSoloMain, conDs } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil } from "../helpers/navegacion.ts";
import { citas } from "../mock-api/fixtures/citas.ts";

const RESUMEN = `/citas/${citas.orgSlug}/resumen`;

test.describe("DS del shell @ds", () => {
  test("?ds=v2 enciende la bandera y se recuerda; ?ds=off la apaga", async ({ page, iniciarSesion }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(RESUMEN);
    await afirmarTemaDs(page, "off");

    await page.goto(conDs(RESUMEN, "v2"));
    await afirmarTemaDs(page, "v2");
    // Se recuerda en localStorage: la siguiente navegacion sin parametro conserva v2.
    await page.goto(RESUMEN);
    await afirmarTemaDs(page, "v2");
    await afirmarPantallaSana(page, "resumen con ds=v2");

    await page.goto(conDs(RESUMEN, "off"));
    await afirmarTemaDs(page, "off");
    await page.goto(RESUMEN);
    await afirmarTemaDs(page, "off");
  });

  test("migas de pan: solo existen visibles con ?ds=v2 en escritorio", async ({ page, iniciarSesion }) => {
    test.skip(esMovil(page), "las migas son de escritorio");
    await iniciarSesion("citas", "owner");
    await page.goto(RESUMEN);
    await expect(page.getByTestId("vertical-migas")).toBeHidden();
    await page.goto(conDs(RESUMEN, "v2"));
    const migas = page.getByRole("navigation", { name: "Migas de pan" });
    await expect(migas).toBeVisible();
    await expect(migas.locator("[aria-current='page']")).toHaveText("Resumen");
  });

  for (const ds of ["off", "v2"] as const) {
    test(`shell con ds=${ds}: un solo <main>, skip link, foco y sin desborde horizontal @oscuro`, async ({ page, iniciarSesion, vigilante }, info) => {
      await iniciarSesion("citas", "owner");
      await page.goto(conDs(RESUMEN, ds));
      await afirmarTemaDs(page, ds);
      await afirmarUnSoloMain(page);
      await afirmarSkipLink(page);
      await afirmarSinScrollHorizontal(page);
      // Los proyectos "-oscuro" siguen al sistema (colorScheme dark); el shell monta ThemeSelector y aplica `html.dark`.
      await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
      vigilante.verificar();
    });
  }

  // BUG-E2E-002: el DashboardHeader del shell (escritorio) y la pagina pintan, cada uno, un <h1>. test.fail() lo documenta.
  test("cada pantalla tiene un solo <h1> (BUG-E2E-002, defecto conocido)", async ({ page, iniciarSesion }) => {
    test.skip(esMovil(page), "en movil el DashboardHeader no se muestra");
    test.fail(true, "BUG-E2E-002: shell y pagina pintan un <h1> cada uno; quitar test.fail al unificar la jerarquia de encabezados");
    await iniciarSesion("citas", "owner");
    await page.goto(RESUMEN);
    await expect(page.getByRole("heading", { name: "Resumen", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });
});
