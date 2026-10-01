// Humo de restaurantes: login -> shell -> todas las secciones del menu sin errores -> dialogo destructivo.
// Es la PLANTILLA de los recorridos completos (ver docs/QA-E2E.md).
import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { afirmarSkipLink } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

test.describe("restaurantes @humo", () => {
  test("owner: entra, recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("restaurantes", "owner");
    expect(aterrizaje).toBe(`/restaurantes/${restaurantes.orgSlug}`);
    await afirmarPantallaSana(page, "panel");
    await afirmarSkipLink(page);

    // owner ve Operacion, Catalogo, Equipo y Cuenta: 15 destinos como minimo.
    const { secciones } = await recorrerSecciones(page, { minimo: 12 });
    expect(secciones.some((s) => s.href.endsWith("/staff"))).toBe(true);
    vigilante.verificar();
  });

  test("staff: el menu no ofrece Staff ni Auditoria", async ({ page, iniciarSesion }) => {
    await iniciarSesion("restaurantes", "staff");
    const { secciones } = await recorrerSecciones(page, { minimo: 8 });
    expect(secciones.some((s) => s.href.endsWith("/staff") || s.href.endsWith("/auditoria"))).toBe(false);
  });

  test("dar de baja: Cancelar y Escape no escriben; confirmar hace un DELETE", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`/restaurantes/${restaurantes.orgSlug}/staff`);
    const fila = page.getByText("Lucia Xool").first();
    await expect(fila).toBeVisible();
    // Las tarjetas de staff comparten el texto del boton: se acota a la fila de Lucia (la propia fila del owner esta deshabilitada).
    const baja = page.locator("xpath=//p[normalize-space()='Lucia Xool']/../..").getByRole("button", { name: "Dar de baja" });
    await expect(baja).toBeVisible();

    await afirmarCancelarNoEscribe(page, mock, baja, { nombre: /Dar de baja a/, verificarFoco: false });

    // Confirmar si dispara exactamente una escritura DELETE.
    await baja.click();
    await page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: "Dar de baja" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "DELETE", ruta: "/staff/miembros/" })).length).toBe(1);
    vigilante.verificar();
  });

  // BUG-E2E-001: el AlertDialog de useConfirm no tiene <Trigger>, asi que Radix no sabe a donde devolver el foco y este
  // cae en <body> al cerrar. test.fail() lo documenta y avisa (falla si "pasa") cuando se corrija en packages/ui.
  test("el foco vuelve al boton que abrio el confirm (BUG-E2E-001, defecto conocido)", async ({ page, iniciarSesion, mock }) => {
    test.fail(true, "BUG-E2E-001: useConfirm pierde el foco al cerrar; quitar test.fail al corregir packages/ui/src/components/ConfirmDialog.tsx");
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`/restaurantes/${restaurantes.orgSlug}/staff`);
    const baja = page.locator("xpath=//p[normalize-space()='Lucia Xool']/../..").getByRole("button", { name: "Dar de baja" });
    await expect(baja).toBeVisible();
    await afirmarCancelarNoEscribe(page, mock, baja, { nombre: /Dar de baja a/ });
  });
});
