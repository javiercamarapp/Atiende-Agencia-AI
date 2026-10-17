// Rn-P3-08 / Rn-P3-09 -- pre-check-in publico del huesped y entrega manual de accesos, contra la API simulada de e2e (nunca la real).
import { ClienteMock } from "../mock-api/cliente.ts";
import { rentas } from "../mock-api/fixtures/rentas.ts";
import { afirmarSinScrollHorizontal, afirmarUnSoloMain } from "../helpers/ds.ts";
import { expect, test, URL_API } from "../helpers/fixtures.ts";

const codigoUnico = () => `HME2E${Math.random().toString(36).slice(2, 7).toUpperCase().padEnd(5, "0")}`;

test.describe("pre-check-in publico @humo", () => {
  test("el huesped encuentra su reserva, deja su correo y acepta el aviso y el reglamento; una segunda verificacion ya lo ve capturado", async ({ page, vigilante }) => {
    const anon = new ClienteMock(URL_API, "anon");
    const codigo = codigoUnico();
    // Correo unico por prueba: las peticiones sin sesion comparten el escenario "anon" entre el proyecto de escritorio y el movil.
    const correo = `huesped.${codigo.toLowerCase()}@example.test`;
    await page.goto(`/rentas/precheckin/${rentas.propertyId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Pre-check-in" })).toBeVisible();
    await afirmarUnSoloMain(page);

    await page.getByLabel("Código de confirmación").fill(codigo.toLowerCase());
    await page.getByLabel(/Últimos 4 dígitos/).fill("0123");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByText("Casa Playa Norte", { exact: false }).first()).toBeVisible();

    await page.getByLabel("Correo electrónico").fill(correo);
    await page.getByLabel("WhatsApp (opcional)").fill("998 123 4567");
    // Sin aceptar el aviso ni el reglamento, enviar esta deshabilitado.
    await expect(page.getByRole("button", { name: "Enviar" })).toBeDisabled();
    await page.getByLabel("Acepto el aviso de privacidad").check();
    await expect(page.getByRole("button", { name: "Enviar" })).toBeDisabled();
    await page.getByLabel("Acepto el reglamento de la casa").check();
    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByText("instrucciones de acceso por correo")).toBeVisible();

    const capturas = (await anon.buscar({ metodo: "POST", ruta: "/capturar" })).filter((p) => JSON.stringify(p.cuerpo).includes(correo));
    expect(capturas).toHaveLength(1);
    expect(capturas[0]!.cuerpo).toMatchObject({ correo, aceptaPrivacidad: true, aceptaReglamento: true });

    // La reserva ya tiene contacto: volver a verificar la reconoce y no vuelve a pedir datos.
    await page.reload();
    await page.getByLabel("Código de confirmación").fill(codigo);
    await page.getByLabel(/Últimos 4 dígitos/).fill("0123");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByText("Ya recibimos tus datos")).toBeVisible();
    vigilante.verificar();
  });

  test("datos que no coinciden: mensaje generico, sin revelar nada; a los 5 intentos el codigo se bloquea", async ({ page }) => {
    const codigo = codigoUnico();
    await page.goto(`/rentas/precheckin/${rentas.propertyId}`);
    for (let i = 0; i < 5; i++) {
      await page.getByLabel("Código de confirmación").fill(codigo);
      await page.getByLabel(/Últimos 4 dígitos/).fill("9999");
      await page.getByRole("button", { name: "Continuar" }).click();
      await expect(page.getByRole("alert")).toContainText("No pudimos validar tus datos");
    }
    await page.getByLabel("Código de confirmación").fill(codigo);
    await page.getByLabel(/Últimos 4 dígitos/).fill("0123");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("alert")).toContainText("Demasiados intentos");
  });

  test("movil a 375 px: sin scroll horizontal y el formulario completo es utilizable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/rentas/precheckin/${rentas.propertyId}`);
    await expect(page.getByLabel("Código de confirmación")).toBeVisible();
    await afirmarSinScrollHorizontal(page);
    await page.getByLabel("Código de confirmación").fill(codigoUnico());
    await page.getByLabel(/Últimos 4 dígitos/).fill("0123");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByLabel("Correo electrónico")).toBeVisible();
    await afirmarSinScrollHorizontal(page);
  });
});

test.describe("acceso al huesped: pendientes de entregar @humo", () => {
  test("la gestora copia el mensaje para la OTA (GET descifrado, sin escrituras) y marca la entrega con confirmacion: Cancelar no escribe", async ({ page, iniciarSesion, mock, vigilante, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
    await iniciarSesion("rentas", "admin");
    await page.goto(`/rentas/${rentas.orgSlug}/acceso-huesped`);
    await expect(page.getByText("Pendientes de entregar (1)")).toBeVisible();

    await page.getByRole("button", { name: "Copiar mensaje para la OTA" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "/reservas/ocu-ota-1/acceso-mensaje" })).length).toBe(1);
    expect((await mock.buscar({ metodo: "POST" })).filter((p) => p.ruta.includes("entrega-manual"))).toHaveLength(0);

    await page.getByRole("button", { name: "Marcar como entregado por la OTA" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancelar" }).click();
    expect((await mock.buscar({ metodo: "POST", ruta: "/entrega-manual" })).length).toBe(0);

    await page.getByRole("button", { name: "Marcar como entregado por la OTA" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Marcar como entregado", exact: true }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/reservas/ocu-ota-1/entrega-manual" })).length).toBe(1);
    await expect(page.getByText("Nada pendiente")).toBeVisible();
    vigilante.verificar();
  });

  test("el enlace publico, el texto sugerido y el reglamento se guardan con un PUT real", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("rentas", "admin");
    await page.goto(`/rentas/${rentas.orgSlug}/acceso-huesped`);
    await expect(page.getByLabel("Enlace público")).toHaveValue(new RegExp(`/rentas/precheckin/${rentas.propertyId}$`));
    await page.getByLabel(/Reglamento de la casa/).fill("Sin mascotas.");
    await page.getByRole("button", { name: "Guardar reglamento" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PUT", ruta: "/acceso-huesped/precheckin" })).length).toBe(1);
    await expect(page.getByText("Reglamento guardado.")).toBeVisible();
  });
});
