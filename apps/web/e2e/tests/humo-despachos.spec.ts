import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";
import { despachos } from "../mock-api/fixtures/despachos.ts";

test.describe("despachos @humo", () => {
  test("owner: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("despachos", "owner");
    expect(aterrizaje.startsWith(`/despachos/${despachos.orgSlug}`)).toBe(true);
    await afirmarPantallaSana(page, "panel");
    await recorrerSecciones(page, { minimo: 12 });
    vigilante.verificar();
  });
});
