// paridad3 L-P3-14/16 -- de punta a punta contra la API simulada: pestana Versiones (historial con diff y fuentes enlazadas con sus conflictos),
// bandeja de Expedientes (paginada en el servidor) y Staff (quitar un miembro con confirmacion; Cancelar y Escape no escriben).
import { afirmarCancelarNoEscribe, dialogo } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";

const BASE = `/licitaciones/${licitaciones.orgSlug}`;

function expedientes(n: number, status: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `tnd-exp-${status}-${String(i).padStart(3, "0")}`,
    organizationId: "org-e2e",
    title: `Expediente ${status} ${i}`,
    submissionDeadline: "2026-11-20T17:00:00.000Z",
    updatedAt: `2026-09-${String((i % 27) + 1).padStart(2, "0")}T12:00:00.000Z`,
    source: "compranet",
    externalId: `EXP-${status}-${i}`,
    contractingBody: "IMSS",
    cpvCodes: [],
    budgetAmount: null,
    currency: "MXN",
    state: null,
    procedureTypeRaw: null,
    status,
  }));
}

test.describe("licitaciones: versiones, expedientes y staff @humo", () => {
  test("la pestana Versiones muestra el diff de cada version y la fuente enlazada con su conflicto", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${BASE}/convocatorias/tnd-1`);
    await page.getByRole("tab", { name: "Versiones" }).click();
    await expect(page.getByText("Versión 2")).toBeVisible();
    await expect(page.getByText("Presentar acta constitutiva vigente")).toBeVisible();
    await expect(page.getByText("Secciones de la propuesta marcadas para revisión por este cambio: legal.")).toBeVisible();
    await expect(page.getByText("cdmx_ocds difiere en:")).toBeVisible();
    await expect(page.getByText("Versión inicial")).toBeVisible();
    vigilante.verificar();
  });

  test("Expedientes: 30 en Go y 1 presentada; la pagina 2 existe y el filtro de estado va al servidor", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${BASE}/expedientes`);
    await afirmarPantallaSana(page, "expedientes");
    await mock.agregarVariosAEstado("lic.convocatorias", [...expedientes(30, "go"), ...expedientes(1, "submitted")]);
    await page.reload();
    await expect(page.getByRole("status").filter({ hasText: "Mostrando" })).toContainText("Mostrando 1–25 de 31");
    await page.getByRole("button", { name: "Siguiente" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Mostrando" })).toContainText("Mostrando 26–31 de 31");
    expect((await mock.buscar({ metodo: "GET", ruta: /\/expedientes\?.*offset=25/ })).length).toBeGreaterThan(0);
    await page.getByLabel("Estatus").selectOption("submitted");
    await expect(page.getByRole("status").filter({ hasText: "Mostrando" })).toContainText("de 1");
    expect((await mock.buscar({ metodo: "GET", ruta: /\/expedientes\?.*status=submitted/ })).length).toBeGreaterThan(0);
    expect(await mock.escrituras()).toEqual([]);
    vigilante.verificar();
  });

  test("Staff: quitar a un miembro pide confirmacion (Cancelar y Escape no escriben) y manda el DELETE", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${BASE}/staff`);
    await expect(page.getByText("Staff licitaciones", { exact: true })).toBeVisible();
    const quitar = page.getByRole("button", { name: "Quitar" }).last();
    await afirmarCancelarNoEscribe(page, mock, quitar, { nombre: /Quitar a Staff licitaciones/, verificarFoco: false });
    // A uno mismo no se ofrece.
    await expect(page.getByRole("button", { name: "Quitar" }).first()).toBeDisabled();

    await quitar.click();
    await dialogo(page, /Quitar a Staff licitaciones/).getByRole("button", { name: "Quitar del staff" }).click();
    await expect(page.getByText("Staff licitaciones", { exact: true })).toBeHidden();
    expect((await mock.buscar({ metodo: "DELETE", ruta: /\/admin\/staff\/miembros\// })).length).toBe(1);
    vigilante.verificar();
  });
});
