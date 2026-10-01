import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";
import { rentas } from "../mock-api/fixtures/rentas.ts";

test.describe("rentas @humo", () => {
  test("owner: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("rentas", "owner");
    expect(aterrizaje.startsWith(`/rentas/${rentas.orgSlug}`)).toBe(true);
    await afirmarPantallaSana(page, "panel");
    await recorrerSecciones(page, { minimo: 8 });
    vigilante.verificar();
  });
});
