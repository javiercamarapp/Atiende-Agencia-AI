import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";

test.describe("licitaciones @humo", () => {
  test("owner: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("licitaciones", "owner");
    expect(aterrizaje.startsWith(`/licitaciones/${licitaciones.orgSlug}`)).toBe(true);
    await afirmarPantallaSana(page, "panel");
    await recorrerSecciones(page, { minimo: 9 });
    vigilante.verificar();
  });
});
