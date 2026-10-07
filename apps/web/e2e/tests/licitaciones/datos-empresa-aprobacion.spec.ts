// L-P3-01/02 -- aprobacion real de los datos de empresa de licitaciones, de punta a punta contra la API simulada: el owner decide una
// tarifa con el dialogo de step-up simulado (Cancelar y Escape no escriben), un documento con una confirmacion simple, y un rol sin
// decision (staff) no ve Aprobar ni Rechazar. Las reglas del servidor (autor distinto del aprobador, 409 si ya se decidio) estan en
// mock-api/fixtures/licitaciones-datos-empresa.ts y se cubren con pruebas de API; aqui se ve lo que la persona ve y hace.
import { afirmarCancelarNoEscribe, dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { licitaciones } from "../../mock-api/fixtures/licitaciones.ts";

const RUTA = `/licitaciones/${licitaciones.orgSlug}/datos-empresa`;

test.describe("licitaciones: aprobacion de datos de empresa @humo", () => {
  test("el owner aprueba una tarifa con step-up; Cancelar, Escape o un codigo incorrecto no escriben", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${RUTA}?tab=tarifas`);
    await expect(page.getByText("consultoria_hora")).toBeVisible();
    await expect(page.getByText("Propuso: Staff licitaciones", { exact: true })).toBeVisible();

    const aprobar = page.getByRole("button", { name: "Aprobar", exact: true });
    await expect(aprobar).toHaveCount(1); // solo la tarifa pendiente; la ya aprobada no ofrece decidir

    // Cancelar y Escape no piden step-up ni escriben nada.
    await afirmarCancelarNoEscribe(page, mock, aprobar, { nombre: /Confirma tu identidad/, verificarFoco: false });

    // Un codigo incorrecto no aprueba: el servidor rechaza el step-up y no se llega al POST de aprobacion.
    await aprobar.click();
    await dialogo(page, /Confirma tu identidad/).getByLabel("Código de verificación en dos pasos").fill("000000");
    await dialogo(page, /Confirma tu identidad/).getByRole("button", { name: "Aprobar" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "El código es incorrecto o ya se usó." })).toBeVisible();
    expect(await mock.buscar({ metodo: "POST", ruta: "/company/rates/rate-1/approve" })).toHaveLength(0);

    // Con el codigo correcto se aprueba con UNA sola escritura y la vista muestra quien propuso y quien aprobo.
    await aprobar.click();
    await dialogo(page, /Confirma tu identidad/).getByLabel("Código de verificación en dos pasos").fill("123456");
    await dialogo(page, /Confirma tu identidad/).getByRole("button", { name: "Aprobar" }).click();
    await expect(page.getByText("Propuso: Staff licitaciones · Aprobó: Owner licitaciones")).toHaveCount(2); // la ya aprobada y la recien aprobada
    await expect(page.getByRole("button", { name: "Aprobar", exact: true })).toHaveCount(0);
    expect(await mock.buscar({ metodo: "POST", ruta: "/company/rates/rate-1/approve" })).toHaveLength(1);

    // Visible al recargar (el servidor es la fuente de verdad).
    await page.reload();
    await expect(page.getByText("Propuso: Staff licitaciones · Aprobó: Owner licitaciones")).toHaveCount(2);
  });

  test("un documento se aprueba con una confirmacion simple (sin step-up) y Cancelar no escribe", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("licitaciones", "admin");
    await page.goto(`${RUTA}?tab=documentos`);
    await expect(page.getByText("Acta constitutiva")).toBeVisible();
    const rechazar = page.getByRole("button", { name: "Rechazar", exact: true });
    await afirmarCancelarNoEscribe(page, mock, rechazar, { nombre: /Rechazar el documento/, verificarFoco: false });

    await page.getByRole("button", { name: "Aprobar", exact: true }).click();
    await dialogo(page, /Aprobar el documento/).getByRole("button", { name: "Aprobar" }).click();
    await expect(page.getByText("Aprobó: Admin licitaciones").first()).toBeVisible();
    expect(await mock.buscar({ metodo: "POST", ruta: "/company/documents/doc-1/approve" })).toHaveLength(1);
    expect(await mock.buscar({ metodo: "POST", ruta: "/auth/step-up" })).toHaveLength(0);
  });

  test("un rol sin decision (staff) ve los datos pero no Aprobar ni Rechazar", async ({ page, iniciarSesion }) => {
    await iniciarSesion("licitaciones", "staff");
    for (const tab of ["documentos", "tarifas"]) {
      await page.goto(`${RUTA}?tab=${tab}`);
      await expect(page.getByText("Pendiente de aprobación").first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Aprobar", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Rechazar", exact: true })).toHaveCount(0);
    }
  });
});
