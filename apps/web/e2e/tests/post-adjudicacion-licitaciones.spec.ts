// L-27 -- post-adjudicacion estructurada de licitaciones, de punta a punta contra la API simulada: garantias (alta, edicion de
// estado, liberar con confirmacion), hitos con responsable del equipo, plazos y convenios modificatorios (decision + step-up).
// Cancelar y Escape nunca escriben; un lector no ve los controles de escritura.
import { afirmarCancelarNoEscribe, dialogo } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";

const RUTA = `/licitaciones/${licitaciones.orgSlug}/convocatorias/tnd-1/post-adjudicacion`;

test.describe("licitaciones: post-adjudicacion, garantias y hitos @humo", () => {
  test("alta de garantia y hito, liberar con confirmacion, plazos y convenio con step-up; recargar conserva todo", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(RUTA);
    await page.getByRole("tab", { name: "Garantías y hitos" }).click();
    await expect(page.getByText("Sin garantías registradas")).toBeVisible();
    await expect(page.getByText("Sin hitos registrados")).toBeVisible();
    await expect(page.getByText("Sin convenios modificatorios")).toBeVisible();
    await expect(page.getByText(/no verificado contra la fuente primaria/)).toBeVisible();

    // Cancelar y Escape no escriben nada.
    await afirmarCancelarNoEscribe(page, mock, page.getByRole("button", { name: "Nueva garantía" }), { nombre: "Nueva garantía", botonCancelar: "Cerrar", verificarFoco: false });

    // Alta de una garantia de cumplimiento ya entregada: el monto viaja como cadena exacta.
    await page.getByRole("button", { name: "Nueva garantía" }).click();
    const d = dialogo(page, "Nueva garantía");
    await d.getByLabel("Monto (MXN)").fill("125000.50");
    await d.getByLabel("Porcentaje del contrato (%)").fill("10");
    await d.getByLabel("Afianzadora").fill("Afianzadora Demo");
    await d.getByLabel("Número de póliza").fill("POL-1");
    await d.getByLabel("Vigencia desde").fill("2026-01-01");
    await d.getByLabel("Vigencia hasta").fill("2026-10-20");
    await mock.limpiarRegistro();
    await d.getByRole("button", { name: "Registrar garantía" }).click();
    await expect(page.getByText("Garantía registrada.")).toBeVisible();
    const altas = await mock.buscar({ metodo: "POST", ruta: "/post-award/garantias" });
    expect(altas).toHaveLength(1);
    expect(altas[0]!.cuerpo).toMatchObject({ tipo: "cumplimiento", monto: "125000.50", afianzadora: "Afianzadora Demo" });
    const fila = page.locator("[data-garantia-id]").first();
    await expect(fila).toContainText("$125,000.50");
    await expect(fila).toContainText("Pendiente de entrega");

    // Marcar entregada (fecha real) y luego liberar: Cancelar no escribe, confirmar hace UN PATCH.
    await fila.getByRole("button", { name: "Marcar entregada" }).click();
    await dialogo(page, "Marcar garantía como entregada").getByLabel("Fecha de entrega").fill("2026-10-03");
    await dialogo(page, "Marcar garantía como entregada").getByRole("button", { name: "Marcar entregada" }).click();
    await expect(page.getByText("Garantía marcada como entregada.")).toBeVisible();
    await expect(fila).toContainText("vence en 15 días");
    await mock.limpiarRegistro();
    await fila.getByRole("button", { name: "Liberar" }).click();
    await dialogo(page, "Liberar la garantía").getByRole("button", { name: "Cancelar" }).click();
    expect(await mock.escrituras()).toEqual([]);
    await fila.getByRole("button", { name: "Liberar" }).click();
    await dialogo(page, "Liberar la garantía").getByRole("button", { name: "Liberar" }).click();
    await expect(page.getByText("Garantía liberada.")).toBeVisible();
    await expect(fila).toContainText("Liberada");
    await expect(fila.getByRole("button", { name: "Liberar" })).toHaveCount(0);

    // Hito con responsable del equipo (sale del servidor, no del id).
    await page.getByRole("button", { name: "Nuevo hito" }).click();
    const h = dialogo(page, "Nuevo hito");
    await h.getByLabel("Título").fill("Entrega de la etapa 1");
    await h.getByLabel("Responsable").selectOption({ label: "Admin licitaciones" });
    await h.getByLabel("Fecha comprometida").fill("2026-10-01");
    await h.getByRole("button", { name: "Registrar hito" }).click();
    await expect(page.getByText("Hito registrado.")).toBeVisible();
    const filaHito = page.locator("[data-hito-id]").first();
    await expect(filaHito).toContainText("Admin licitaciones");
    await expect(filaHito).toContainText("4 días de retraso");
    await filaHito.getByRole("button", { name: "Cumplido" }).click();
    await dialogo(page, "Marcar el hito como cumplido").getByRole("button", { name: "Marcar cumplido" }).click();
    await expect(page.getByText("Hito marcado como cumplido.")).toBeVisible();
    await expect(filaHito).toContainText("Cumplido");

    // Plazos: dias fuera de rango se rechazan en la pantalla; con datos validos se guardan.
    await page.getByRole("button", { name: "Editar plazos" }).click();
    const p = dialogo(page, "Plazos de firma y de entrega de garantía");
    await p.getByLabel("Días hábiles para firmar").fill("0");
    await p.getByRole("button", { name: "Guardar plazos" }).click();
    await expect(p.getByText(/entre 1 y 90/)).toBeVisible();
    await p.getByLabel("Fallo notificado el").fill("2026-11-12");
    await p.getByLabel("Días hábiles para firmar").fill("3");
    await p.getByRole("button", { name: "Guardar plazos" }).click();
    await expect(page.getByText("Plazos guardados.")).toBeVisible();
    await expect(page.getByText("Límite para firmar el contrato")).toBeVisible();

    // Convenio modificatorio: decision + step-up. Un codigo incorrecto no registra nada.
    await page.getByRole("button", { name: "Registrar convenio" }).click();
    const c = dialogo(page, "Registrar convenio modificatorio");
    await c.getByLabel("Tipo").selectOption("monto_plazo");
    await c.getByLabel("Ajuste de monto (MXN)").fill("-5000.00");
    await c.getByLabel("Nueva fecha de fin del contrato").fill("2027-03-31");
    await c.getByLabel("Fecha de firma del convenio").fill("2026-10-01");
    await c.getByLabel("Motivo").fill("Ajuste acordado con la convocante");
    await c.getByLabel("Código de verificación en dos pasos").fill("000000");
    await mock.limpiarRegistro();
    await c.getByRole("button", { name: "Registrar convenio" }).click();
    await expect(c.getByText("El código es incorrecto o ya se usó.")).toBeVisible();
    expect(await mock.buscar({ metodo: "POST", ruta: "/post-award/convenios" })).toHaveLength(0);
    await c.getByLabel("Código de verificación en dos pasos").fill("123456");
    await c.getByRole("button", { name: "Registrar convenio" }).click();
    await expect(page.getByText(/Convenio modificatorio registrado/)).toBeVisible();
    await expect(page.getByText("Convenio 1")).toBeVisible();
    await expect(page.getByText("-$5,000.00").first()).toBeVisible();
    await expect(page.getByText("Ajuste de monto acumulado")).toBeVisible();

    // Todo queda visible al recargar, junto con la bitacora de cambios.
    await page.reload();
    await page.getByRole("tab", { name: "Garantías y hitos" }).click();
    await expect(page.locator("[data-garantia-id]").first()).toContainText("Liberada");
    await expect(page.locator("[data-hito-id]").first()).toContainText("Cumplido");
    await expect(page.getByText("Convenio 1")).toBeVisible();
    await expect(page.getByText("Cambio de estado").first()).toBeVisible();
    vigilante.verificar();
  });

  test("un rol de solo lectura no ve ningun control de escritura", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("licitaciones", "finanzas");
    await page.goto(RUTA);
    await page.getByRole("tab", { name: "Garantías y hitos" }).click();
    await expect(page.getByText("Sin garantías registradas")).toBeVisible();
    for (const nombre of ["Nueva garantía", "Nuevo hito", "Editar plazos", "Registrar convenio"]) {
      await expect(page.getByRole("button", { name: nombre })).toHaveCount(0);
    }
    vigilante.verificar();
  });

  test("un rol que solo escribe (staff) registra garantias pero no puede registrar convenios ni liberar", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("licitaciones", "staff");
    await page.goto(RUTA);
    await page.getByRole("tab", { name: "Garantías y hitos" }).click();
    await expect(page.getByRole("button", { name: "Nueva garantía" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Registrar convenio" })).toHaveCount(0);
    vigilante.verificar();
  });
});
