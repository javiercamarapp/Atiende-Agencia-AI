import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { hoteles } from "../mock-api/fixtures/hoteles.ts";

// H-P3-04/05/06: el hotel se configura y arranca desde el panel, sin SQL. El owner invita a una persona (Equipo), cambia el ISH (Configuracion,
// con bitacora) y ve avanzar el checklist de Primeros pasos; Cancelar/Escape de un dialogo de edicion nunca escriben.
test.describe("hoteles configuracion y equipo @humo", () => {
  test("owner: invita a una persona, cambia el ISH y ve el checklist avanzar", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("hoteles", "owner");
    const base = `/hoteles/${hoteles.orgSlug}`;

    // Primeros pasos: el equipo esta pendiente (solo el owner tiene acceso).
    await page.goto(`${base}/primeros-pasos`);
    const equipo = page.locator("li", { has: page.getByText("Al menos un miembro del equipo") });
    await expect(equipo).toContainText("Pendiente");
    await expect(equipo).toContainText("Solo tú tienes acceso");

    // Equipo: invitar con uno de los 8 roles.
    await page.goto(`${base}/equipo`);
    await page.getByLabel("Correo").fill("Recepcion.Nueva@hotel.test");
    await page.getByLabel("Rol").selectOption("frontdesk");
    await page.getByRole("button", { name: "Invitar" }).click();
    await expect(page.getByText("token-de-ejemplo")).toBeVisible();
    await expect(page.getByText("recepcion.nueva@hotel.test").first()).toBeVisible();
    const invitaciones = await mock.buscar({ metodo: "POST", ruta: "/admin/staff/invitaciones" });
    expect(invitaciones).toHaveLength(1);
    expect(invitaciones[0]!.cuerpo).toEqual({ email: "recepcion.nueva@hotel.test", verticalRole: "frontdesk" });

    // Configuracion: cambiar el ISH del 3 % al 4 %.
    await page.goto(`${base}/configuracion`);
    await expect(page.getByText("verifícala con tu contador")).toBeVisible();
    await expect(page.getByLabel("ISH (%)")).toHaveValue("3");
    await page.getByLabel("ISH (%)").fill("4");
    await page.getByRole("button", { name: "Guardar impuestos" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PUT", ruta: "/configuracion/impuestos" })).length).toBe(1);
    expect((await mock.buscar({ metodo: "PUT", ruta: "/configuracion/impuestos" }))[0]!.cuerpo).toMatchObject({ ishRate: 0.04, ivaRate: 0.16 });

    // La bitacora lo registra con valor anterior y nuevo.
    await page.getByRole("tab", { name: "Bitácora" }).click();
    await expect(page.getByText("ishRate: 0.04").first()).toBeVisible();
    await expect(page.getByText("ishRate: 0.03").first()).toBeVisible();

    // El checklist avanzo: el equipo ya no esta pendiente (hay una invitacion por aceptar).
    await page.goto(`${base}/primeros-pasos`);
    await expect(equipo).toContainText("Parcial");
    await expect(equipo).toContainText("1 invitación(es) pendiente(s)");
    expect(vigilante.sinFixture, "alguna pantalla nueva pidio una ruta que la API simulada no conoce").toEqual([]);
    vigilante.verificar();
  });

  test("tarifas y sobreventa: editar abre un dialogo; Cancelar y Escape no escriben; guardar manda el PUT", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("hoteles", "owner");
    const base = `/hoteles/${hoteles.orgSlug}`;

    await page.goto(`${base}/configuracion?tab=sobreventa`);
    await expect(page.getByText("Sin sobreventa")).toBeVisible();
    await afirmarCancelarNoEscribe(page, mock, page.getByRole("button", { name: /Editar la sobreventa de Doble vista al mar/ }), { botonCancelar: "Cerrar", verificarFoco: false });

    await page.goto(`${base}/configuracion?tab=tarifas`);
    await expect(page.locator("[data-tarifa-id]").first()).toBeVisible();
    await page.getByRole("button", { name: /Editar el precio del/ }).first().click();
    await page.getByLabel("Precio por noche (MXN)").fill("1999");
    await page.getByRole("dialog").getByRole("button", { name: "Guardar cambios" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PUT", ruta: "/tarifas/" })).length).toBe(1);
    await expect(page.getByText("Precio manual")).toBeVisible();
    vigilante.verificar();
  });
});
