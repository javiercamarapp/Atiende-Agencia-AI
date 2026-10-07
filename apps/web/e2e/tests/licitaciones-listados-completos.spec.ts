// paridad3 L-P3-13: con mas de 50 convocatorias la lista NO se corta en silencio. La API simulada pagina como la real (limit/offset, total
// en X-Total-Count, filtros en el "servidor"); la prueba siembra 251 y verifica pagina 2, busqueda en servidor y KPIs del Resumen.
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";

const BASE = `/licitaciones/${licitaciones.orgSlug}`;
const CLAVE = "lic.convocatorias";

function convocatoriasExtra(n: number, orgId: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `tnd-gen-${String(i).padStart(3, "0")}`,
    organizationId: orgId,
    title: `Convocatoria sembrada ${i}`,
    submissionDeadline: null,
    updatedAt: `2026-08-${String((i % 27) + 1).padStart(2, "0")}T12:00:00.000Z`,
    source: "compranet",
    externalId: `GEN-${i}`,
    contractingBody: "IMSS",
    cpvCodes: [],
    budgetAmount: null,
    currency: "MXN",
    state: null,
    procedureTypeRaw: null,
    status: "discovered",
  }));
}

test.describe("licitaciones: listados completos @humo", () => {
  test("251 convocatorias: la pagina 2 existe, la busqueda es del servidor y el Resumen muestra el total real", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${BASE}/convocatorias`);
    await afirmarPantallaSana(page, "convocatorias");
    await mock.agregarVariosAEstado(CLAVE, convocatoriasExtra(249, "org-e2e"));
    await page.reload();

    await expect(page.getByRole("status").filter({ hasText: "Mostrando" })).toContainText("Mostrando 1–25 de 251");
    await expect(page.getByText("Página 1 de 11")).toBeVisible();
    await page.getByRole("button", { name: "Siguiente" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Mostrando" })).toContainText("Mostrando 26–50 de 251");
    expect((await mock.buscar({ metodo: "GET", ruta: /\/tenders\?.*offset=25/ })).length).toBeGreaterThan(0);

    await page.getByLabel("Buscar").fill("GEN-24");
    await expect(page.getByRole("status").filter({ hasText: "Mostrando" })).toContainText("de 10"); // GEN-24 y GEN-240..GEN-248 (ids sembrados 0..248)
    expect((await mock.buscar({ metodo: "GET", ruta: /\/tenders\?.*q=GEN-24/ })).length).toBeGreaterThan(0);

    await page.goto(`${BASE}/panel`);
    await expect(page.getByText("251 convocatorias abiertas")).toBeVisible();
    // El Resumen pide solo los conteos: nunca baja el listado para contar.
    expect((await mock.buscar({ metodo: "GET", ruta: /\/tenders\/summary/ })).length).toBeGreaterThan(0);
    vigilante.verificar();
  });
});
