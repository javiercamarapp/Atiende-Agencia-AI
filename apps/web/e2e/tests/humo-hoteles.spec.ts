import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";
import { hoteles } from "../mock-api/fixtures/hoteles.ts";

test.describe("hoteles @humo", () => {
  test("owner: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("hoteles", "owner");
    expect(aterrizaje.startsWith(`/hoteles/${hoteles.orgSlug}`)).toBe(true);
    await afirmarPantallaSana(page, "panel");
    await recorrerSecciones(page, { minimo: 12 });
    vigilante.verificar();
  });
});
