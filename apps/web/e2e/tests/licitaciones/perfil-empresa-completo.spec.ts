// L-P3-03/04 -- perfil de empresa completo de punta a punta contra la API simulada (mock-api/fixtures/licitaciones-datos-empresa.ts):
// captura del perfil general con la estratificacion MIPyME PENDIENTE DE VERIFICACION LEGAL y la procedencia (quien y cuando), alta de dos
// firmantes del mismo cargo con vigencia, y el firmante vencido en rojo. Las pruebas @oscuro corren tambien en los proyectos oscuros y
// moviles. Con CAPTURAS_PERFIL_DIR guarda capturas (nunca en CI). Las reglas del servidor estan en las pruebas de API y de Postgres real.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afirmarModo, afirmarSinScrollHorizontal } from "../../helpers/ds.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { licitaciones } from "../../mock-api/fixtures/licitaciones.ts";

const RUTA = `/licitaciones/${licitaciones.orgSlug}/datos-empresa`;

async function capturar(page: import("@playwright/test").Page, nombre: string, proyecto: string): Promise<void> {
  const destino = process.env["CAPTURAS_PERFIL_DIR"];
  if (!destino) return;
  mkdirSync(destino, { recursive: true });
  await page.screenshot({ path: join(destino, `${nombre}-${proyecto}.png`), fullPage: true });
}

test.describe("licitaciones: perfil de empresa completo @humo", () => {
  test("perfil general: se captura, queda pendiente con su procedencia y la estratificacion dice que falta la verificacion legal @oscuro", async ({ page, iniciarSesion, mock, vigilante }, info) => {
    await iniciarSesion("licitaciones", "admin");
    await page.goto(`${RUTA}?tab=general`);
    await afirmarPantallaSana(page, "perfil general");
    // Estado vacio con la siguiente accion real.
    await expect(page.getByText("Aún no capturas el perfil de la empresa")).toBeVisible();
    await expect(page.getByText("Pendiente de verificación legal")).toBeVisible();
    await expect(page.getByText("Captura el perfil general (sector, trabajadores y ventas anuales)")).toBeVisible();

    await page.getByLabel("Razón social").fill("Acme Servicios SA de CV");
    await page.getByLabel("RFC").fill("acm010101ab1");
    await page.getByLabel("Sector (opcional)").selectOption("servicios");
    await page.getByLabel("Número de trabajadores (opcional)").fill("12");
    await page.getByLabel("Ventas anuales en pesos (opcional)").fill("1500000.50");
    await page.getByRole("button", { name: "Guardar perfil" }).click();

    // Persistido en el servidor (fuente de verdad), pendiente de aprobacion y con quien lo capturo.
    await expect(page.getByText("Acme Servicios SA de CV · ACM010101AB1")).toBeVisible();
    await expect(page.getByText("$1,500,000.50", { exact: false })).toBeVisible();
    await expect(page.getByText("Pendiente de aprobación").first()).toBeVisible();
    await expect(page.getByTestId("procedencia")).toContainText(/Capturó: (tú|Admin licitaciones) · 2026-10-04 16:00 UTC \(captura manual\)/);
    await expect(page.getByTestId("mipyme-resultado")).toContainText("Microempresa");
    await expect(page.getByText("Pendiente de verificación legal")).toBeVisible();
    const put = await mock.buscar({ metodo: "PUT", ruta: "/company/profile" });
    expect(put).toHaveLength(1);
    expect(put[0]!.cuerpo).toMatchObject({ legalName: "Acme Servicios SA de CV", taxId: "acm010101ab1", sector: "servicios", employeeCount: 12, annualSalesCents: 150_000_050 });
    // (La regla "quien captura no se aprueba a si mismo" se prueba en la API y en el unit de la UI; el token simulado de e2e no trae `sub`.)

    await afirmarSinScrollHorizontal(page);
    await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
    await capturar(page, "perfil-general", info.project.name);
    vigilante.verificar();
  });

  test("socios: la lista muestra la procedencia y el alta pasa por el servidor @oscuro", async ({ page, iniciarSesion, mock, vigilante }, info) => {
    await iniciarSesion("licitaciones", "admin");
    await page.goto(`${RUTA}?tab=socios`);
    await expect(page.getByText("Socia fundadora")).toBeVisible();
    await expect(page.getByText("60.00%")).toBeVisible();
    await expect(page.getByText(/Capturó: (tú|Staff licitaciones) · 2026-09-20 15:00 UTC/)).toBeVisible();

    await page.getByLabel("Nombre completo o razón social").fill("Beto Ruiz");
    await page.getByLabel("Participación (%)").fill("40");
    await page.getByRole("button", { name: "Agregar socio o representante" }).click();
    await expect(page.getByText("Beto Ruiz")).toBeVisible();
    const altas = await mock.buscar({ metodo: "POST", ruta: "/company/stakeholders" });
    expect(altas).toHaveLength(1);
    expect(altas[0]!.cuerpo).toEqual({ kind: "socio", fullName: "Beto Ruiz", participationPct: "40" });

    // Un representante no lleva porcentaje.
    await page.getByLabel("Tipo").selectOption("representante");
    await expect(page.getByLabel("Participación (%)")).toHaveCount(0);
    await afirmarSinScrollHorizontal(page);
    await capturar(page, "socios", info.project.name);
    vigilante.verificar();
  });

  test("firmantes: dos del mismo cargo con vigencia; el vencido sale en rojo y el vigente en verde @oscuro", async ({ page, iniciarSesion, mock, vigilante }, info) => {
    await iniciarSesion("licitaciones", "admin");
    await page.goto(`${RUTA}?tab=firmantes`);
    await afirmarPantallaSana(page, "firmantes con vigencia");
    // El firmante sembrado tiene el poder vencido desde 2025-12-31.
    const vencido = page.getByText("Poder vencido", { exact: true });
    await expect(vencido).toHaveCount(1);
    await expect(page.getByText("Poder desde 2023-01-01 hasta 2025-12-31")).toBeVisible();
    // Rojo: el color de texto del badge es el de peligro del tema (no el de exito).
    const colorDe = (loc: import("@playwright/test").Locator) => loc.evaluate((el) => getComputedStyle(el).color);
    const colorVencido = await colorDe(vencido);

    for (const [nombre, hasta] of [["Ana López", "2099-12-31"], ["Beto Ruiz", "2099-06-30"]] as const) {
      await page.getByLabel("Nombre", { exact: true }).fill(nombre);
      await page.getByLabel("Cargo").fill("Apoderado");
      await page.getByLabel("Poder vigente desde").fill("2026-01-01");
      await page.getByLabel("Vigente hasta (opcional)").fill(hasta);
      await page.getByLabel("Límites de actuación (opcional)").fill("hasta 5 millones");
      await page.getByRole("button", { name: "Agregar firmante (autorizado)" }).click();
      await expect(page.getByText(nombre, { exact: true })).toBeVisible();
    }
    const altas = await mock.buscar({ metodo: "POST", ruta: "/company/signers" });
    expect(altas).toHaveLength(2);
    expect(altas[0]!.cuerpo).toMatchObject({ role: "Apoderado", validFrom: "2026-01-01", validUntil: "2099-12-31", actionLimits: "hasta 5 millones" });

    // Los tres comparten cargo; los dos nuevos estan vigentes y el sembrado sigue vencido.
    await expect(page.getByText("Poder vigente", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Poder vencido", { exact: true })).toHaveCount(1);
    const colorVigente = await colorDe(page.getByText("Poder vigente", { exact: true }).first());
    expect(colorVigente).not.toBe(colorVencido);
    await expect(page.getByText("Límites de actuación: hasta 5 millones")).toHaveCount(2);

    await afirmarSinScrollHorizontal(page);
    await afirmarModo(page, info.project.name.endsWith("oscuro") ? "oscuro" : "claro");
    await capturar(page, "firmantes", info.project.name);
    vigilante.verificar();
  });

  test("el owner aprueba un socio de otra persona con una confirmacion simple (sin step-up) @humo", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("licitaciones", "admin");
    await page.goto(`${RUTA}?tab=socios`);
    await page.getByLabel("Nombre completo o razón social").fill("Carla Díaz");
    await page.getByLabel("Participación (%)").fill("10");
    await page.getByRole("button", { name: "Agregar socio o representante" }).click();
    await expect(page.getByText("Carla Díaz")).toBeVisible();
    // Mismo escenario, otra persona: el owner la decide.
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${RUTA}?tab=socios`);
    await expect(page.getByText("Carla Díaz")).toBeVisible();
    await page.getByRole("button", { name: "Aprobar", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Aprobar" }).click();
    await expect(page.getByRole("button", { name: "Aprobar", exact: true })).toHaveCount(0);
    expect(await mock.buscar({ metodo: "POST", ruta: "/company/stakeholders/soc-2/approve" })).toHaveLength(1);
    expect(await mock.buscar({ metodo: "POST", ruta: "/auth/step-up" })).toHaveLength(0);
  });
});
