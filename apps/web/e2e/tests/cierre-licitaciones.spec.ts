// L-26/L-28 -- cierre del expediente de licitaciones, de punta a punta contra la API simulada: doble aprobacion
// (tecnico-legal 1/2 y economica 2/2, dos personas distintas, cada una con step-up TOTP), ensamblado y declaracion
// de la presentacion ante el portal. Cancelar y Escape nunca escriben.
import { afirmarCancelarNoEscribe, dialogo } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";

const RUTA_CIERRE = `/licitaciones/${licitaciones.orgSlug}/convocatorias/tnd-1/cierre`;

test.describe("licitaciones: cierre del expediente @humo", () => {
  test("doble aprobacion con step-up, ensamblado y declaracion de la presentacion", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(RUTA_CIERRE);
    await page.getByRole("tab", { name: "Aprobación" }).click();
    await expect(page.getByText("Faltan: Técnico-legal (1/2) y Económica (2/2).")).toBeVisible();

    const aprobarTL = page.getByRole("button", { name: "Aprobar técnico-legal (1/2)" });
    const aprobarEC = page.getByRole("button", { name: "Aprobar económica (2/2)" });
    await expect(aprobarEC).toBeDisabled();
    await expect(page.getByText("Falta la aprobación técnico-legal (1/2).")).toBeVisible();

    // Cancelar y Escape no escriben nada (ni el step-up ni la aprobacion).
    await afirmarCancelarNoEscribe(page, mock, aprobarTL, { nombre: /Confirma tu identidad/, verificarFoco: false });

    // Un codigo incorrecto no aprueba: el servidor rechaza el step-up y no se llega al POST de aprobacion.
    await aprobarTL.click();
    await dialogo(page, /Confirma tu identidad/).getByLabel("Código de verificación en dos pasos").fill("000000");
    await dialogo(page, /Confirma tu identidad/).getByRole("button", { name: "Aprobar" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "El código es incorrecto o ya se usó." })).toBeVisible();
    expect(await mock.buscar({ metodo: "POST", ruta: "/expediente/approval" })).toHaveLength(0);

    // Con el codigo correcto el owner da la 1/2 y ya NO puede dar la 2/2 (debe ser otra persona).
    await aprobarTL.click();
    await dialogo(page, /Confirma tu identidad/).getByLabel("Código de verificación en dos pasos").fill("123456");
    await dialogo(page, /Confirma tu identidad/).getByRole("button", { name: "Aprobar" }).click();
    await expect(page.getByText("Técnico-legal (1/2): aprobada.")).toBeVisible();
    await expect(page.getByText("Aprobó Propietario (tú)")).toBeVisible();
    await expect(aprobarEC).toBeDisabled();
    await expect(page.getByText("Ya diste la otra aprobación de este expediente: debe darla otra persona.")).toBeVisible();

    // Otra persona (admin) completa el 2/2 y recien entonces se puede ensamblar.
    await iniciarSesion("licitaciones", "admin");
    await page.goto(RUTA_CIERRE);
    await page.getByRole("tab", { name: "Paquete final" }).click();
    await expect(page.getByRole("button", { name: "Ensamblar paquete" })).toBeDisabled();
    await expect(page.getByText(/Para ensamblar falta Económica \(2\/2\)/)).toBeVisible();

    await page.getByRole("tab", { name: "Aprobación" }).click();
    await expect(page.getByText("Aprobó Propietario ·")).toBeVisible();
    await aprobarEC.click();
    await dialogo(page, /Confirma tu identidad/).getByLabel("Código de verificación en dos pasos").fill("123456");
    await dialogo(page, /Confirma tu identidad/).getByRole("button", { name: "Aprobar" }).click();
    await expect(page.getByText("Económica (2/2): aprobada.")).toBeVisible();
    await expect(page.getByText("2/2 completa").first()).toBeVisible();

    await page.getByRole("tab", { name: "Paquete final" }).click();
    await page.getByRole("button", { name: "Ensamblar paquete" }).click();
    await expect(page.getByText(/Generado .*La presentación y firma las realiza el usuario/)).toBeVisible();

    // Presentacion ante el portal: Atiende solo registra la declaracion.
    await page.getByRole("tab", { name: "Presentación" }).click();
    await expect(page.getByText("Atiende nunca envía tu oferta al portal")).toBeVisible();
    await page.getByLabel("Fecha y hora de la presentación").fill("2026-10-01T10:00");
    await page.getByLabel("Notas (opcional)").fill("Folio del portal 123");
    const declarar = page.getByRole("button", { name: "Declarar presentación" });
    await mock.limpiarRegistro();
    await declarar.click();
    // Cancelar no escribe; confirmar hace UN solo POST.
    await dialogo(page, /Declarar la presentación ante el portal/).getByRole("button", { name: "Cancelar" }).click();
    expect(await mock.escrituras()).toEqual([]);
    await declarar.click();
    await page.keyboard.press("Escape");
    expect(await mock.escrituras()).toEqual([]);
    await declarar.click();
    await dialogo(page, /Declarar la presentación ante el portal/).getByRole("button", { name: "Declarar presentación" }).click();
    await expect(page.getByTestId("presentacion-declarada")).toContainText("Folio del portal 123");
    expect(await mock.buscar({ metodo: "POST", ruta: "/submission/declare" })).toHaveLength(1);

    // Visible al recargar.
    await page.reload();
    await page.getByRole("tab", { name: "Presentación" }).click();
    await expect(page.getByTestId("presentacion-declarada")).toContainText("Folio del portal 123");
    await expect(page.getByRole("button", { name: "Declarar presentación" })).toHaveCount(0);
    vigilante.verificar();
  });
});
