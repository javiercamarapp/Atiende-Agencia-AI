import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil } from "../helpers/navegacion.ts";
import { rentas } from "../mock-api/fixtures/rentas.ts";

// Paridad3 rentas: conectar -> probar -> copiar la URL de exportacion con token, contra la API SIMULADA (nunca la base real).
test.describe("rentas conectividad @humo", () => {
  test("conectar un feed: Probar URL no guarda nada; guardar conecta; generar la URL con token y copiarla", async ({ page, context, iniciarSesion, mock, vigilante }) => {
    test.skip(esMovil(page), "el recorrido de conexion es el mismo en movil; el escritorio cubre el flujo completo");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await iniciarSesion("rentas", "admin");
    await page.goto(`/rentas/${rentas.orgSlug}/ical-sync`);
    await afirmarPantallaSana(page, "sincronizacion iCal");

    // Booking.com avisa que no hay evidencia de iCal, con el motivo del catalogo (nunca una cifra inventada).
    await expect(page.getByText("Sin evidencia de que Booking.com ofrezca iCal")).toBeVisible();
    await expect(page.getByText("Latencia declarada: ~3 horas (confianza baja; fuente RV03 S1)")).toBeVisible();

    await page.getByRole("button", { name: "Conectar", exact: true }).first().click();
    const dialogo = page.getByRole("dialog");
    await dialogo.getByLabel(/URL del feed de Airbnb/).fill("https://www.airbnb.com/calendar/ical/12345.ics");
    await mock.limpiarRegistro();
    await dialogo.getByRole("button", { name: "Probar URL" }).click();
    await expect(dialogo.getByText("La URL funciona: 3 eventos, del 2026-11-01 al 2027-01-15.")).toBeVisible();
    // Probar NO persiste nada: ninguna escritura distinta de la propia prueba.
    expect((await mock.buscar({ metodo: "POST", ruta: "/ical-feeds/probar" })).length).toBe(1);
    expect((await mock.buscar({ metodo: "POST", ruta: "/ical-sync" })).length).toBe(0);

    await dialogo.getByRole("button", { name: "Conectar", exact: true }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/canales/airbnb/ical-sync" })).length).toBe(1);
    await expect(page.getByText("Conectado", { exact: true }).first()).toBeVisible();

    // Sincronizar ahora (Rn-P3-23): llama al endpoint del feed y muestra el resultado real.
    await page.getByRole("button", { name: "Sincronizar ahora" }).first().click();
    await expect(page.getByText("Sincronizado: 3 eventos aplicados, 1 reserva nueva.")).toBeVisible();

    // La URL con token se muestra UNA vez y se copia al portapapeles.
    await page.getByRole("button", { name: "Generar URL con token" }).first().click();
    const campo = page.getByLabel("URL con token para Airbnb");
    await expect(campo).toBeVisible();
    const url = await campo.inputValue();
    expect(url).toMatch(/\/rentas\/feed\/[A-Za-z0-9_-]+\.ics$/);
    await campo.locator("xpath=..").getByRole("button", { name: "Copiar" }).click();
    await expect(page.getByRole("button", { name: "¡Copiada!" }).first()).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await expect(page.getByText("por seguridad no se vuelve a mostrar")).toBeVisible();

    // Al recargar la pagina el token en claro ya no se puede ver: solo queda el estado y la opcion de rotar.
    await page.reload();
    await expect(page.getByLabel("URL con token para Airbnb")).toHaveCount(0);
    await expect(page.getByText(/URL con token creada el/)).toBeVisible();
    vigilante.verificar();
  });

  test("rotar la URL: Cancelar y Escape no escriben; confirmar hace un POST", async ({ page, iniciarSesion, mock, vigilante }) => {
    test.skip(esMovil(page), "el dialogo es el mismo en movil");
    await iniciarSesion("rentas", "admin");
    await page.goto(`/rentas/${rentas.orgSlug}/ical-sync`);
    await page.getByRole("button", { name: "Generar URL con token" }).first().click();
    await expect(page.getByLabel("URL con token para Airbnb")).toBeVisible();
    await page.reload();

    const rotar = page.getByRole("button", { name: "Rotar URL" }).first();
    await expect(rotar).toBeVisible();
    await afirmarCancelarNoEscribe(page, mock, rotar, { nombre: "¿Rotar la URL de exportación de Airbnb?", verificarFoco: false });
    await rotar.click();
    await expect(page.getByRole("alertdialog")).toContainText("Airbnb dejará de ver tu calendario hasta que pegues la URL nueva");
    await page.getByRole("alertdialog").getByRole("button", { name: "Sí, rotar URL" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/feed-token/rotar" })).length).toBe(1);
    await expect(page.getByLabel("URL con token para Airbnb")).toBeVisible();
    vigilante.verificar();
  });

  test("matriz de conectividad: refleja el feed conectado, el asistente marca pasos con evidencia y el catalogo no ofrece conectar API", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("rentas", "admin");
    await page.goto(`/rentas/${rentas.orgSlug}/ical-sync`);
    await page.getByRole("button", { name: "Conectar", exact: true }).first().click();
    await page.getByRole("dialog").getByLabel(/URL del feed de Airbnb/).fill("https://www.airbnb.com/calendar/ical/12345.ics");
    await page.getByRole("dialog").getByRole("button", { name: "Conectar", exact: true }).click();
    await expect(page.getByText("Conectado", { exact: true }).first()).toBeVisible();

    await page.goto(`/rentas/${rentas.orgSlug}/conectividad`);
    await afirmarPantallaSana(page, "conectividad");
    await expect(page.getByText("Matriz de conectividad")).toBeVisible();
    await expect(page.getByText("Pendiente de sincronizar").first()).toBeVisible();
    await expect(page.getByText("Latencia: SIN EVIDENCIA (sin evidencia)")).toBeVisible();

    await page.getByRole("button", { name: "Abrir el asistente de Casa Playa Norte en Airbnb" }).click();
    await expect(page.getByText("Asistente: Airbnb · Casa Playa Norte")).toBeVisible();
    await expect(page.getByText("Conectado, esperando la primera sincronización.")).toBeVisible();

    await expect(page.getByText("Requiere acuerdo de partner").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /conectar api/i })).toHaveCount(0);
    vigilante.verificar();
  });
});
