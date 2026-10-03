import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";

test.describe("superadmin @humo", () => {
  test("superadmin: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("superadmin");
    expect(aterrizaje).toBe("/superadmin");
    await afirmarPantallaSana(page, "resumen");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    // El odometro solo se pinta desde `sm`; en movil el MRR va en texto.
    if ((page.viewportSize()?.width ?? 0) >= 640) await expect(page.getByTestId("odometro")).toBeVisible();
    else await expect(page.getByText(/MRR.*\$48,900.*meta \$1,000,000/)).toBeVisible();
    await expect(page.getByText("Operaciones atendidas", { exact: true })).toBeVisible();
    // SA-L-01: el listado de organizaciones ya no es la raiz; vive en su propia ruta.
    await page.goto("/superadmin/organizaciones");
    await afirmarPantallaSana(page, "organizaciones");
    await expect(page.locator("[data-org-id]").filter({ hasText: "Taqueria El Faro" })).toBeVisible();
    await recorrerSecciones(page, { minimo: 18 });
    vigilante.verificar();
  });

  test("resumen: 'Entrar' abre el dialogo con motivo; Cancelar y Escape no escriben; el parte diario vive en su ruta", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("superadmin");
    await expect(page.getByText("Orquestación de agentes")).toBeVisible();
    // Cero botones muertos: no existe /superadmin/analitica, asi que la pildora no se pinta.
    await expect(page.getByRole("link", { name: /Ver analítica/ })).toHaveCount(0);
    const entrar = page.getByRole("button", { name: /^Entrar a / }).first();
    await expect(entrar).toBeVisible();
    await afirmarCancelarNoEscribe(page, mock, entrar, { nombre: /Entrar a /, verificarFoco: false });

    await page.getByRole("link", { name: /Ver parte diario/ }).click();
    await expect(page).toHaveURL(/\/superadmin\/parte-diario$/);
    await afirmarPantallaSana(page, "parte diario");
    // La ruta vieja redirige sin 404.
    await page.goto("/superadmin/resumen");
    await expect(page).toHaveURL(/\/superadmin$/);
    vigilante.verificar();
  });

  test("organizaciones: tabla con metricas y 'Entrar' con motivo (Cancelar y Escape no escriben), ficha 360, 404 honesto y pestana Gestion", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("superadmin");
    await page.goto("/superadmin/organizaciones");
    await afirmarPantallaSana(page, "organizaciones");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    // Tabla (tarjetas en movil): una fila por organizacion con las columnas reales; despachos no tiene operaciones medibles ("—", no "0").
    const fila = page.locator("[data-org-id]").filter({ hasText: "Taqueria El Faro" });
    await expect(fila).toBeVisible();
    if ((page.viewportSize()?.width ?? 0) >= 768) {
      const tabla = page.getByRole("table", { name: "Organizaciones" });
      for (const col of ["Organización", "Plan", "Operaciones 30 d", "Costo IA 30 d", "Margen", "Onboarding"]) await expect(tabla.getByRole("columnheader", { name: new RegExp(col) })).toBeVisible();
    }
    await expect(page.locator('[data-org-id]:has-text("Sin fuente: despachos")').first()).toBeAttached();
    await expect(page.getByTestId("hbars")).toBeVisible();
    if ((page.viewportSize()?.width ?? 0) >= 640) await expect(page.getByTestId("odometro")).toBeVisible();

    // "Entrar" abre el dialogo con motivo; Cancelar y Escape NO escriben; con un motivo corto el boton queda bloqueado.
    const entrar = page.getByRole("button", { name: /^Entrar a Taqueria El Faro/ }).first();
    await afirmarCancelarNoEscribe(page, mock, entrar, { nombre: /Entrar a /, verificarFoco: false });
    await entrar.click();
    const dialogo = page.getByRole("alertdialog", { name: /Entrar a / });
    await dialogo.getByLabel(/Motivo/).fill("corto");
    await expect(dialogo.getByRole("button", { name: "Abrir sesión" })).toBeDisabled();
    expect(await mock.escrituras()).toEqual([]);
    await dialogo.getByRole("button", { name: "Cancelar" }).click();

    // Ficha 360 de la organizacion.
    await page.getByRole("link", { name: /^Ficha de Taqueria El Faro/ }).first().click();
    await expect(page).toHaveURL(/\/superadmin\/organizaciones\/[^/]+$/);
    await afirmarPantallaSana(page, "ficha de organizacion");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Taqueria El Faro/);
    for (const titulo of ["Uso · últimos 30 días", "Costo"]) await expect(page.getByRole("heading", { level: 2, name: titulo, exact: true })).toBeVisible();
    for (const titulo of ["Membresías", "Últimos errores", "Facturación y contrato"]) await expect(page.getByText(titulo, { exact: true })).toBeVisible();
    await expect(page.getByText(/^Onboarding · \d+\/\d+$/)).toBeVisible();
    await expect(page.getByText("No se pudo medir").or(page.getByText("Pendiente")).first()).toBeVisible();

    // Una organizacion inexistente: 404 honesto, no una pantalla en blanco.
    await page.goto("/superadmin/organizaciones/00000000-0000-4000-8000-000000000000");
    await expect(page.getByText("No encontramos esta organización")).toBeVisible();

    // La ruta vieja de gestion redirige a la pestana, sin 404; la pestana monta la gestion de siempre.
    await page.goto("/superadmin/gestion-organizaciones");
    await expect(page).toHaveURL(/\/superadmin\/organizaciones\?tab=gestion$/);
    await expect(page.getByRole("button", { name: /Alta de organización/ })).toBeVisible();
    vigilante.verificar();
  });

  test("interruptores: Cancelar y Escape no escriben; aplicar hace un PUT", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("superadmin");
    await page.goto("/superadmin/interruptores");
    const detener = page.getByRole("button", { name: "Detener" }).first();
    await expect(detener).toBeVisible();

    await afirmarCancelarNoEscribe(page, mock, detener, { nombre: "Detener", verificarFoco: false });

    await detener.click();
    const dialogo = page.getByRole("dialog", { name: "Detener" });
    await dialogo.getByLabel(/Motivo/).fill("Incidente de prueba: se detiene el LLM para validar el flujo");
    await dialogo.getByRole("button", { name: "Detener" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PUT", ruta: "/superadmin/interruptores" })).length).toBe(1);
    vigilante.verificar();
  });

  test("panel de agentes: Cancelar y Escape en la palanca no escriben; aplicar con motivo hace un PUT y la fila queda Detenida", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("superadmin");
    await page.goto("/superadmin/agentes");
    const detener = page.getByRole("button", { name: "Detener Agente de WhatsApp de restaurantes" });
    await expect(detener).toBeVisible();

    await afirmarCancelarNoEscribe(page, mock, detener, { nombre: /Detener Agente de WhatsApp de restaurantes/, verificarFoco: false });

    await detener.click();
    const dialogo = page.getByRole("alertdialog", { name: /Detener Agente de WhatsApp de restaurantes/ });
    await dialogo.getByLabel(/Motivo/).fill("Incidente de prueba: se detiene el agente para validar el flujo");
    await dialogo.getByRole("button", { name: "Detener agente" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PUT", ruta: "/superadmin/interruptores" })).length).toBe(1);
    await expect(page.getByRole("button", { name: "Reactivar Agente de WhatsApp de restaurantes" })).toBeVisible();
    vigilante.verificar();
  });

  test("panel de agentes: una corrida abre su traza con el error redactado", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("superadmin");
    await page.goto("/superadmin/agentes");
    await page.getByText("/internal/rentas/ical-sync").first().click();
    const traza = page.getByRole("dialog", { name: "Traza de la corrida" });
    await expect(traza.getByText("timeout del proveedor de calendario")).toBeVisible();
    vigilante.verificar();
  });
});
