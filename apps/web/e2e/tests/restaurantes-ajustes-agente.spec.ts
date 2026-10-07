// Ajustes del agente de restaurantes (Agente > Ajustes del agente): modelo y temperatura de WhatsApp con costo estimado, voz, sonido de fondo, voz y saludo,
// conocimiento automatico y clonacion con estado honesto. La API simulada reproduce el contrato real (PUT completo, lista permitida, temperatura solo donde el
// modelo la admite); el recorrido demuestra que la SPA manda lo que muestra y que lo guardado sobrevive a recargar.
import { expect, test } from "../helpers/fixtures.ts";
import { seccionesDelPanel } from "../helpers/navegacion.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const RUTA = `/restaurantes/${restaurantes.orgSlug}/agente-ajustes`;

test.describe("restaurantes: ajustes del agente", () => {
  test("owner: elige un modelo con temperatura, guarda (PUT completo) y al recargar sigue ahi", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(RUTA);
    const modelo = page.locator("#ajustes-modelo-whatsapp");
    await expect(modelo).toBeVisible();
    await expect(page.getByTestId("costo-whatsapp")).toContainText("≈ US$0.80 por 1,000 mensajes");
    // El predeterminado (Luna) no admite temperatura: lo dice en lugar de ofrecer un control que no hace nada.
    await expect(page.getByTestId("sin-temperatura-whatsapp")).toContainText("GPT-6 Luna no admite temperatura");

    await modelo.selectOption("google/gemini-2.5-flash-lite");
    await expect(page.getByTestId("costo-whatsapp")).toContainText("≈ US$0.76 por 1,000 mensajes");
    await expect(page.getByTestId("sin-temperatura-whatsapp")).toHaveCount(0);
    await page.getByRole("radiogroup", { name: "Temperatura del agente de WhatsApp" }).locator("label", { hasText: /^0\.4$/ }).click();

    await page.getByRole("button", { name: "Guardar ajustes" }).click();
    await expect(page.getByText("Ajustes guardados")).toBeVisible();
    await expect.poll(async () => (await mock.buscar({ metodo: "PUT", ruta: "/admin/agente/ajustes" })).length).toBe(1);
    const [put] = await mock.buscar({ metodo: "PUT", ruta: "/admin/agente/ajustes" });
    expect(put!.cuerpo).toMatchObject({ whatsappModelo: "google/gemini-2.5-flash-lite", whatsappTemperatura: 0.4, vozFondoActivo: false, vozRitmo: "normal" });

    await page.reload();
    await expect(page.locator("#ajustes-modelo-whatsapp")).toHaveValue("google/gemini-2.5-flash-lite");
    await expect(page.getByRole("radiogroup", { name: "Temperatura del agente de WhatsApp" }).getByRole("radio", { name: "0.4" })).toBeChecked();
    vigilante.verificar();
  });

  test("cambiar a un modelo sin temperatura la reinicia a automatica: el servidor nunca recibe una combinacion invalida", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(RUTA);
    await page.locator("#ajustes-modelo-whatsapp").selectOption("deepseek/deepseek-v4.1-flash");
    await page.getByRole("radiogroup", { name: "Temperatura del agente de WhatsApp" }).locator("label", { hasText: /^0\.6$/ }).click();
    await page.locator("#ajustes-modelo-whatsapp").selectOption("anthropic/claude-sonnet-5.5");
    await expect(page.getByTestId("sin-temperatura-whatsapp")).toContainText("Claude Sonnet 5.5 no admite temperatura");
    await expect(page.getByTestId("costo-whatsapp")).toContainText("≈ US$16.00 por 1,000 mensajes");
    await page.getByRole("button", { name: "Guardar ajustes" }).click();
    await expect(page.getByText("Ajustes guardados")).toBeVisible();
    const [put] = await mock.buscar({ metodo: "PUT", ruta: "/admin/agente/ajustes" });
    expect(put!.cuerpo).toMatchObject({ whatsappModelo: "anthropic/claude-sonnet-5.5", whatsappTemperatura: null });
  });

  test("voz y fondo: arranca apagado, al activarlo ofrece volumen acotado y todo viaja en el mismo PUT; declara de que depende", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(RUTA);
    const fondo = page.getByRole("switch", { name: "Activar el sonido de fondo" });
    await expect(fondo).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("radiogroup", { name: "Volumen del sonido de fondo" })).toHaveCount(0);
    await expect(page.getByTestId("aplica-fondo")).toContainText("servicio de llamadas");
    await expect(page.getByTestId("aplica-cascada")).toContainText("servicio de llamadas");
    await expect(page.getByTestId("nota-habla")).toContainText("no tiene un control numerico de velocidad");

    await fondo.click();
    await expect(page.getByText("nunca pasa de 20 %")).toBeVisible();
    await page.getByRole("radiogroup", { name: "Volumen del sonido de fondo" }).locator("label", { hasText: /^12 %$/ }).click();
    await page.getByRole("radiogroup", { name: "Ritmo de habla" }).locator("label", { hasText: "Pausado" }).click();
    await page.getByRole("radiogroup", { name: "Estilo de habla" }).locator("label", { hasText: "Cálido" }).click();
    await page.getByRole("radiogroup", { name: "Temperatura de la voz" }).locator("label", { hasText: /^0\.2$/ }).click();
    await page.locator("#ajustes-modelo-cascada").selectOption("google/gemini-2.5-flash-lite");
    await expect(page.getByTestId("costo-cascada")).toContainText("≈ US$1.40 por 1,000 minutos");
    await page.getByRole("button", { name: "Guardar ajustes" }).click();
    await expect(page.getByText("Ajustes guardados")).toBeVisible();
    const [put] = await mock.buscar({ metodo: "PUT", ruta: "/admin/agente/ajustes" });
    expect(put!.cuerpo).toMatchObject({ vozFondoActivo: true, vozFondoVolumen: 12, vozRitmo: "pausado", vozEstilo: "calido", vozTemperatura: 0.2, vozModeloCascada: "google/gemini-2.5-flash-lite" });
  });

  test("voz y saludo de la sucursal: guarda sobre la configuracion vigente y avisa si el saludo no dice 'asistente virtual'", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(RUTA);
    const saludo = page.locator("#ajustes-saludo");
    await expect(saludo).toHaveValue(/asistente virtual/);
    await saludo.fill("Hola, buenas tardes");
    await expect(page.getByTestId("alerta-sin-asistente-virtual")).toBeVisible();
    await saludo.fill("Bienvenido, le atiende el asistente virtual de Taqueria El Faro.");
    await expect(page.getByTestId("alerta-sin-asistente-virtual")).toHaveCount(0);
    await page.getByRole("button", { name: "Guardar voz y saludo" }).click();
    await expect(page.getByText("Voz y saludo guardados")).toBeVisible();
    const [put] = await mock.buscar({ metodo: "PUT", ruta: "/admin/voz/config" });
    expect(put!.cuerpo).toMatchObject({ voiceId: "Kore", mensajeInicial: "Bienvenido, le atiende el asistente virtual de Taqueria El Faro.", habilitado: false, comportamiento: "" });
  });

  test("conocimiento automatico: documentos generados con su estado y lo que NO se genera; clonacion de voz con estado honesto", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(RUTA);
    const menu = page.locator('[data-documento="menu_precios"]');
    await expect(menu).toContainText("En la instrucción de voz");
    await menu.locator("summary").click();
    await expect(menu.locator("pre")).toContainText("Tacos al pastor (orden): $95");
    await expect(page.locator('[data-documento="colonias_sucursal"]')).toContainText("No hay colonias conocidas configuradas.");
    await expect(page.getByTestId("conocimiento-nota")).toContainText("huella 9f2c4a7b");
    const omitidos = page.getByTestId("documentos-omitidos");
    await expect(omitidos).toContainText("Ventas:");
    await expect(omitidos).toContainText("Personal:");

    const clonacion = page.getByTestId("seccion-clonacion");
    await expect(clonacion).toContainText("No disponible");
    await expect(page.getByTestId("clonacion-motivo")).toContainText("no clona voces");
    await expect(clonacion.getByRole("button")).toHaveCount(0);
    vigilante.verificar();
  });

  test("el menu ofrece 'Ajustes del agente' al owner y no al staff", async ({ page, iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
    expect((await seccionesDelPanel(page)).some((s) => s.href.endsWith("/agente-ajustes"))).toBe(true);
    await page.context().clearCookies();
    await page.evaluate(() => window.localStorage.clear());
    await iniciarSesion("restaurantes", "staff");
    expect((await seccionesDelPanel(page)).some((s) => s.href.endsWith("/agente-ajustes"))).toBe(false);
  });
});
