// L-25/L-29 -- gate final de la sala de guerra y bitacora de la convocatoria, de punta a punta contra la API simulada:
// el gate arranca "No listo" (sin 2/2 ni paquete) con enlace a lo que falta, pasa a "Listo" cuando se completa la doble
// aprobacion y se ensambla el paquete, y la bitacora muestra esos mismos eventos, filtrables. Todo es lectura salvo el
// flujo de cierre ya existente; la tarjeta y la bitacora nunca escriben.
import { dialogo } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";

const BASE = `/licitaciones/${licitaciones.orgSlug}/convocatorias/tnd-1`;

async function aprobar(page: import("@playwright/test").Page, boton: string, etapa: string) {
  await page.getByRole("button", { name: boton }).click();
  await dialogo(page, /Confirma tu identidad/).getByLabel("Código de verificación en dos pasos").fill("123456");
  await dialogo(page, /Confirma tu identidad/).getByRole("button", { name: "Aprobar" }).click();
  await expect(page.getByText(etapa)).toBeVisible();
}

test.describe("licitaciones: gate final y bitacora @humo", () => {
  test("el gate pasa de 'No listo' a 'Listo' al completar el 2/2 y ensamblar; la bitacora lo refleja", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${BASE}/sala-guerra`);

    const gate = page.getByTestId("gate-final");
    await expect(gate.getByText("No listo")).toBeVisible();
    // La cuenta avanza desde el reloj del servidor: segundos despues de cargar ya son 22 h 59 min.
    await expect(gate.getByText(/Cierra en 18 d (23 h 0|22 h 59) min/)).toBeVisible();
    await expect(page.getByTestId("gate-aprobaciones")).toContainText("Falta la aprobación técnico-legal (1/2) y la aprobación económica (2/2).");
    await expect(page.getByTestId("gate-paquete")).toContainText("Todavía no hay un paquete de envío ensamblado.");
    await expect(page.getByTestId("gate-holgura")).toContainText("Verde");

    // El enlace de lo que falta lleva a la pantalla de cierre.
    await page.getByTestId("gate-aprobaciones").getByRole("link", { name: "Ir a las aprobaciones" }).click();
    await expect(page).toHaveURL(`${BASE}/cierre`);

    // Doble aprobacion por dos personas (owner y admin) y ensamblado.
    await page.getByRole("tab", { name: "Aprobación" }).click();
    await aprobar(page, "Aprobar técnico-legal (1/2)", "Técnico-legal (1/2): aprobada.");
    await iniciarSesion("licitaciones", "admin");
    await page.goto(`${BASE}/cierre`);
    await page.getByRole("tab", { name: "Aprobación" }).click();
    await aprobar(page, "Aprobar económica (2/2)", "Económica (2/2): aprobada.");
    await page.getByRole("tab", { name: "Paquete final" }).click();
    await page.getByRole("button", { name: "Ensamblar paquete" }).click();
    await expect(page.getByText(/Generado /)).toBeVisible();

    // De vuelta en la sala de guerra: el gate se recalcula en el servidor y queda en verde.
    await mock.limpiarRegistro();
    await page.goto(`${BASE}/sala-guerra`);
    await expect(gate.getByText("Listo para presentar")).toBeVisible();
    await expect(page.getByTestId("gate-zip_manifiesto")).toContainText("El ZIP coincide con el manifiesto");
    await expect(gate.getByRole("link")).toHaveCount(0);
    await page.getByRole("button", { name: "Recalcular gate" }).click();
    await expect(gate.getByText("Listo para presentar")).toBeVisible();
    expect(await mock.buscar({ metodo: "GET", ruta: "/sala-guerra/gate" })).toHaveLength(2);
    expect(await mock.escrituras()).toEqual([]);

    // Bitacora de la convocatoria: eventos reales del cierre, con filtro por origen.
    await page.goto(BASE);
    await page.getByRole("tab", { name: "Bitácora" }).click();
    await expect(page.getByText("Aprobación técnico-legal (1/2) del expediente.")).toBeVisible();
    await expect(page.getByText("Aprobación económica (2/2) del expediente.")).toBeVisible();
    await page.getByLabel("Origen").selectOption("presentacion");
    await expect(page.getByText("Ningún evento coincide con los filtros.")).toBeVisible();
    await page.getByRole("button", { name: "Limpiar filtros" }).click();
    await expect(page.getByText("Aprobación económica (2/2) del expediente.")).toBeVisible();
    vigilante.verificar();
  });

  test("error al calcular el gate: mensaje honesto y reintento", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    vigilante.permitirRespuesta5xx(/\/sala-guerra\/gate/);
    await mock.inyectarFalla({ metodo: "GET", ruta: "/sala-guerra/gate", status: 500, cuerpo: { message: "No se pudo calcular el gate." }, veces: 1 });
    await page.goto(`${BASE}/sala-guerra`);
    await expect(page.getByText("No se pudo calcular el gate.")).toBeVisible();
    await page.getByRole("button", { name: /Reintentar/ }).click();
    await expect(page.getByTestId("gate-final").getByText("No listo")).toBeVisible();
    vigilante.verificar();
  });
});
