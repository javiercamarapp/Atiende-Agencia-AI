// Capturas de la barra superior, el Copiloto y el selector de sucursal de restaurantes (claro, oscuro, movil 375 px).
// Las comprobaciones corren siempre: CADA ruta de restaurantes lleva la barra (titulo, "Chatea con tus datos", campana y fecha).
// El PNG solo se escribe si CAPTURAS_UX_DIR apunta a una carpeta, asi CI no genera nada. Las pruebas @oscuro corren tambien en oscuro.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil } from "../helpers/navegacion.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const BASE = `/restaurantes/${restaurantes.orgSlug}`;
const SEGUNDA = { propertyId: "00000000-0000-4000-8000-00000000a2b2", name: "Prolongación Montejo", slug: "montejo" };

// [archivo, ruta]. Resumen, Pedidos, Copiloto y CFO son las pedidas; el resto cubre las demas familias de pagina.
const PAGINAS: ReadonlyArray<readonly [string, string]> = [
  ["resumen", ""],
  ["pedidos", "/pedidos"],
  ["copiloto", "/copiloto"],
  ["cfo", "/cfo"],
  ["clientes", "/clientes"],
  ["ficha-cliente", "/clientes/cli-1"],
  ["agente-voz", "/agente-voz"],
  ["configuracion", "/configuracion"],
  ["historial", "/historial"],
  ["productos", "/productos"],
  ["turnos", "/turnos"],
  ["staff", "/staff"],
  ["notificaciones", "/notificaciones"],
];

function destino(): string | undefined {
  const base = process.env["CAPTURAS_UX_DIR"];
  if (!base) return undefined;
  mkdirSync(base, { recursive: true });
  return base;
}

test.describe("captura UX restaurantes @captura", () => {
  test("la barra superior (chat, campana, fecha) esta en cada pagina y se captura @oscuro", async ({ page, iniciarSesion, vigilante }, info) => {
    test.setTimeout(180_000);
    await iniciarSesion("restaurantes", "owner");
    const dir = destino();
    for (const [nombre, ruta] of PAGINAS) {
      await page.goto(`${BASE}${ruta}`);
      await afirmarPantallaSana(page, nombre);
      if (!esMovil(page)) {
        const barra = page.getByTestId("barra-pagina");
        await expect(barra, `${nombre}: barra visible`).toBeVisible();
        await expect(barra.getByRole("link", { name: /Chatea con tus datos/ }), `${nombre}: Chatea con tus datos`).toBeVisible();
        await expect(barra.getByRole("link", { name: /^Notificaciones/ }), `${nombre}: campana`).toHaveCount(1);
        await expect(barra.getByTestId("barra-pagina-fecha"), `${nombre}: fecha`).toBeVisible();
      }
      await afirmarSinScrollHorizontal(page);
      if (dir) await page.screenshot({ path: join(dir, `${nombre}-${info.project.name}.png`) });
    }
    vigilante.verificar();
  });

  test("selector de sucursal: sidebar (con varias sucursales y con una) @oscuro", async ({ page, iniciarSesion, mock, vigilante }, info) => {
    test.skip(esMovil(page), "el sidebar es de escritorio; el selector movil se captura en la cabecera");
    await iniciarSesion("restaurantes", "owner");
    const dir = destino();
    await page.goto(BASE);
    const aside = page.getByRole("complementary", { name: "Navegación principal" });
    await expect(aside).toBeVisible();
    if (dir) await aside.screenshot({ path: join(dir, `sucursal-una-${info.project.name}.png`) });
    await mock.agregarAEstado("rest.branches", SEGUNDA);
    await page.goto(BASE);
    await expect(aside.getByText("Sucursal activa")).toBeVisible();
    if (dir) await aside.screenshot({ path: join(dir, `sucursal-varias-${info.project.name}.png`) });
    await aside.getByRole("button", { name: "Colapsar barra lateral" }).click();
    if (dir) await aside.screenshot({ path: join(dir, `sucursal-colapsado-${info.project.name}.png`) });
    vigilante.verificar();
  });

  test("selector de sucursal: cabecera movil", async ({ page, iniciarSesion, mock }, info) => {
    test.skip(!esMovil(page), "solo movil");
    await iniciarSesion("restaurantes", "owner");
    await mock.agregarAEstado("rest.branches", SEGUNDA);
    await page.goto(BASE);
    const dir = destino();
    await expect(page.getByRole("combobox", { name: /Sucursal activa/i }).filter({ visible: true }).first()).toBeVisible();
    if (dir) await page.screenshot({ path: join(dir, `sucursal-cabecera-${info.project.name}.png`) });
  });
});
