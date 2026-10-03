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
    await expect(page.getByText("Taqueria El Faro")).toBeVisible();
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

  test("costos y facturacion, consumo de IA y ejecutivo: pestanas por URL, redirecciones de las rutas viejas y un solo h1 por pagina", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("superadmin");
    // SA-L-21: las cuatro paginas de costos son pestanas; la activa vive en ?tab= y las rutas viejas redirigen a su pestana.
    await page.goto("/superadmin/costos-facturacion");
    await afirmarPantallaSana(page, "costos y facturacion");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Costos y facturación");
    await expect(page.getByText("Gasto de IA histórico")).toBeVisible();
    await page.getByRole("tab", { name: "P&L" }).click();
    await expect(page).toHaveURL(/\/superadmin\/costos-facturacion\?tab=pyl$/);
    await page.goto("/superadmin/contratos");
    await expect(page).toHaveURL(/\/superadmin\/costos-facturacion\?tab=contratos$/);
    await expect(page.getByRole("tab", { name: "Contratos" })).toHaveAttribute("aria-selected", "true");
    // SA-L-22: Gasto de API de LLM pasa a Consumo de IA, con la tabla por rol y las alertas.
    await page.goto("/superadmin/gasto-api");
    await expect(page).toHaveURL(/\/superadmin\/consumo-ia$/);
    await afirmarPantallaSana(page, "consumo de IA");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Consumo de IA");
    await expect(page.getByText("Gasto de hoy por rol / agente")).toBeVisible();
    await expect(page.getByText("sin techo").first()).toBeVisible();
    // SA-L-24: Dashboard CFO pasa a Ejecutivo / Board.
    await page.goto("/superadmin/cfo");
    await expect(page).toHaveURL(/\/superadmin\/ejecutivo$/);
    await afirmarPantallaSana(page, "ejecutivo");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ejecutivo / Board");
    await expect(page.getByText("Lo que este panel todavía no puede mostrar")).toBeVisible();
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
