// L-P3-09 -- autopiloto de licitaciones, lo que la persona ve y hace contra la API simulada:
//  1. el umbral del aviso de "nuevo match" en la configuracion de la organizacion (Staff): se guarda con UN PATCH, sobrevive a
//     recargar, un valor invalido no llama a la API y quien no es owner/admin no ve la tarjeta;
//  2. la campana pasa del conteo a la LISTA: cada convocatoria con match es un aviso propio (puntuacion, sin titulos ni montos), el
//     punto rojo se enciende al llegar y se apaga al leerlos, y "Resolver" lleva a esa convocatoria.
// Las reglas del servidor (quien avisa, el dedupe, el umbral) estan en las pruebas de API y en scripts/verify-licitaciones-autopiloto.
import { expect, test } from "../../helpers/fixtures.ts";
import { licitaciones } from "../../mock-api/fixtures/licitaciones.ts";

const RUTA_STAFF = `/licitaciones/${licitaciones.orgSlug}/staff`;

test.describe("licitaciones: umbral del aviso de nuevo match @humo", () => {
  test("el owner guarda el umbral con un solo PATCH, recargar lo conserva y vaciarlo vuelve a 'solo elegibles'", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(RUTA_STAFF);
    const campo = page.getByLabel("Puntuación mínima (0 a 100)");
    await expect(campo).toBeVisible();
    await expect(campo).toHaveValue("");
    await expect(page.getByText("Sin umbral: solo se avisan las convocatorias elegibles.")).toBeVisible();

    await mock.limpiarRegistro();
    await campo.fill("75");
    await campo.locator("xpath=ancestor::form").getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Umbral guardado: 75.")).toBeVisible();
    const patches = await mock.buscar({ metodo: "PATCH", ruta: "/admin/tenant-config" });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.cuerpo).toEqual({ new_match_min_score: 75 });

    // Visible al recargar (el servidor es la fuente de verdad).
    await page.reload();
    await expect(page.getByLabel("Puntuación mínima (0 a 100)")).toHaveValue("75");

    // Vaciar y guardar manda null.
    await mock.limpiarRegistro();
    await page.getByLabel("Puntuación mínima (0 a 100)").fill("");
    await page.getByLabel("Puntuación mínima (0 a 100)").locator("xpath=ancestor::form").getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Sin umbral: solo se avisan las convocatorias elegibles.")).toBeVisible();
    expect((await mock.buscar({ metodo: "PATCH", ruta: "/admin/tenant-config" }))[0]!.cuerpo).toEqual({ new_match_min_score: null });
    vigilante.verificar();
  });

  test("un valor fuera de rango no llama a la API y dice por que", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("licitaciones", "admin");
    await page.goto(RUTA_STAFF);
    await mock.limpiarRegistro();
    const campo = page.getByLabel("Puntuación mínima (0 a 100)");
    await campo.fill("150");
    await campo.locator("xpath=ancestor::form").getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "entre 0 y 100" })).toBeVisible();
    expect(await mock.escrituras()).toEqual([]);
  });

  test("quien no es owner/admin no ve la tarjeta del umbral", async ({ page, iniciarSesion }) => {
    await iniciarSesion("licitaciones", "staff");
    await page.goto(RUTA_STAFF);
    await expect(page.getByRole("heading", { name: "Staff", level: 1 })).toBeVisible();
    await expect(page.getByLabel("Puntuación mínima (0 a 100)")).toHaveCount(0);
  });
});

test.describe("licitaciones: la campana lista cada convocatoria con match @humo", () => {
  test("cada match es un aviso con su puntuacion, el punto rojo se apaga al leerlos y 'Resolver' lleva a la convocatoria", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    const campana = page.locator('a[aria-label^="Notificaciones"]:visible');
    const punto = campana.locator('[data-testid="campana-punto"]');
    await campana.click();
    await expect(page).toHaveURL(/\/notificaciones$/);
    const tarjetas = page.getByTestId("notificacion");
    await expect(tarjetas).toHaveCount(2); // semilla comun de la API simulada

    // El cron de descubrimiento emite un aviso POR convocatoria con match (las mejores 5): llegan como lista, no como un conteo.
    for (const [tenderId, puntuacion] of [["tnd-1", 92], ["tnd-2", 81]] as const) {
      await mock.emitirNotificacion({
        titulo: "Una convocatoria nueva coincide con el perfil de tu empresa",
        // el texto es el del catalogo: solo la puntuacion, ningun titulo ni monto
        cuerpo: `Puntuación de afinidad: ${puntuacion} de 100. Revísala y decide si participas.`,
        severidad: "info",
        categoria: "operacion",
        enlace: `/licitaciones/${licitaciones.orgSlug}/convocatorias/${tenderId}`,
      });
    }
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const matches = tarjetas.filter({ hasText: "coincide con el perfil de tu empresa" });
    await expect(matches).toHaveCount(2);
    await expect(matches.first()).toContainText("Puntuación de afinidad");
    await expect(punto).toBeVisible();

    // Resolver lleva a la convocatoria y marca el aviso como leido.
    await matches.first().getByRole("link", { name: "Resolver" }).click();
    await expect(page).toHaveURL(/\/licitaciones\/[^/]+\/convocatorias\/tnd-[12]$/);
    expect((await mock.buscar({ metodo: "POST", ruta: /\/notifications\/ntf-[^/]+\/read$/ })).length).toBe(1);

    // Marcar todas apaga el punto rojo.
    await campana.click();
    await page.getByRole("button", { name: "Marcar todas" }).click();
    await expect(punto).toHaveCount(0);
    await expect(campana).toHaveAttribute("data-no-leidas", "false");
    vigilante.verificar();
  });
});
