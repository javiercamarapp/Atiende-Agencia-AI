// UNI-MARCO (restaurantes): UNA sola barra superior del marco en CADA ruta del panel, sin controles repetidos.
// Convencion: la barra (`BarraPagina`, montada una vez por el `VerticalShell`) lleva titulo de la pagina + "Chatea con tus datos" +
// campana (centro de notificaciones) + fecha. Ninguna pagina repite esos controles en su cuerpo.
// En las 29 rutas con shell, en claro, oscuro y 375 px, exige EXACTAMENTE UNA instancia visible de cada control:
//   escritorio: barra con titulo, chat, campana y fecha; cero copias en el <main>.
//   movil (375 px): la barra de escritorio no existe; el encabezado movil (logo + campana + menu de cuenta + fila con el titulo) la
//   sustituye; "Chatea con tus datos" vive UNA vez en el menu de cuenta.
// El PNG solo se escribe si CAPTURAS_UNI_MARCO_DIR apunta a una carpeta (CI no genera nada). Corre tambien en oscuro (@oscuro).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import type { Page } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { esMovil } from "../helpers/navegacion.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

const BASE = `/restaurantes/${restaurantes.orgSlug}`;

// [archivo de captura, ruta]. Son las 29 rutas del panel con shell de `App.tsx` (sin /repartidor, otro panel, ni el login).
export const RUTAS_RESTAURANTES: ReadonlyArray<readonly [string, string]> = [
  ["resumen", ""],
  ["productos", "/productos"],
  ["sucursales", "/sucursales"],
  ["pedidos", "/pedidos"],
  ["comandas-pos", "/comandas-pos"],
  ["historial", "/historial"],
  ["clientes", "/clientes"],
  ["ficha-cliente", "/clientes/cli-1"],
  ["staff", "/staff"],
  ["promociones", "/promociones"],
  ["auditoria", "/auditoria"],
  ["configuracion", "/configuracion"],
  ["agente-voz", "/agente-voz"],
  ["agente-ajustes", "/agente-ajustes"],
  ["agente-whatsapp", "/agente-whatsapp"],
  ["cierres", "/cierres"],
  ["campanas", "/campanas"],
  ["privacidad", "/privacidad"],
  ["privacidad-organizacion", "/privacidad-organizacion"],
  ["conversaciones", "/conversaciones"],
  ["turnos", "/turnos"],
  ["avisos", "/avisos"],
  ["copiloto", "/copiloto"],
  ["cfo", "/cfo"],
  ["primeros-pasos", "/primeros-pasos"],
  ["notificaciones", "/notificaciones"],
  ["plan", "/plan"],
  ["seguridad", "/seguridad"],
  ["no-encontrada", "/ruta-que-no-existe"],
];

const FORMATO_FECHA = /^\d{1,2} [a-z]{3,5}\.? \d{4}$/;
const NOMBRE_CHAT = /^Chatea con tus datos/;

function destino(): string | undefined {
  const base = process.env["CAPTURAS_UNI_MARCO_DIR"];
  if (!base) return undefined;
  mkdirSync(base, { recursive: true });
  return base;
}

/** Controles de chat visibles en TODA la pantalla (enlace o boton), y los que caen dentro del <main> de la pagina. */
async function contarChat(page: Page): Promise<{ total: number; enMain: number; textos: number }> {
  const chat = page.getByRole("link", { name: NOMBRE_CHAT }).or(page.getByRole("button", { name: NOMBRE_CHAT }));
  const total = await chat.filter({ visible: true }).count();
  const enMain = await page.locator("main#contenido-principal").getByRole("link", { name: NOMBRE_CHAT }).or(page.locator("main#contenido-principal").getByRole("button", { name: NOMBRE_CHAT })).count();
  // Ademas del rol: ningun otro nodo visible repite el rotulo (p. ej. un titulo o un enlace de texto suelto).
  const textos = await page.getByText(/Chatea con tus datos/).filter({ visible: true }).count();
  return { total, enMain, textos };
}

/** Campanas visibles en toda la pantalla: la campana lleva `aria-label` "Notificaciones..." (el item del menu lateral es texto, no aria-label). */
const campanas = (page: Page) => page.locator('[aria-label^="Notificaciones"]').filter({ visible: true });

test.describe("UNI-MARCO restaurantes: una sola barra, un solo juego de controles @oscuro", () => {
  test("las 29 rutas llevan exactamente una barra con chat, campana y fecha (o su equivalente movil)", async ({ page, iniciarSesion, vigilante }, info) => {
    test.setTimeout(240_000);
    await iniciarSesion("restaurantes", "owner");
    const dir = destino();
    expect(RUTAS_RESTAURANTES).toHaveLength(29);
    for (const [nombre, ruta] of RUTAS_RESTAURANTES) {
      await page.goto(`${BASE}${ruta}`);
      await afirmarPantallaSana(page, nombre);
      await afirmarSinScrollHorizontal(page);

      if (!esMovil(page)) {
        const barra = page.getByTestId("barra-pagina");
        await expect(barra, `${nombre}: exactamente una barra visible`).toHaveCount(1);
        await expect(barra).toBeVisible();
        await expect(page.getByTestId("barra-pagina-titulo"), `${nombre}: titulo de la pagina en la barra`).toHaveText(/\S/);
        const chat = await contarChat(page);
        expect(chat.total, `${nombre}: UN solo "Chatea con tus datos" visible`).toBe(1);
        expect(chat.textos, `${nombre}: el rotulo "Chatea con tus datos" aparece una vez`).toBe(1);
        expect(chat.enMain, `${nombre}: ningun "Chatea con tus datos" dentro del cuerpo de la pagina`).toBe(0);
        await expect(barra.getByRole("link", { name: NOMBRE_CHAT }).or(barra.getByRole("button", { name: NOMBRE_CHAT })), `${nombre}: el chat vive en la barra`).toHaveCount(1);
        await expect(campanas(page), `${nombre}: UNA sola campana visible`).toHaveCount(1);
        await expect(barra.locator('[aria-label^="Notificaciones"]'), `${nombre}: la campana vive en la barra`).toHaveCount(1);
        await expect(page.locator("main#contenido-principal").locator('[aria-label^="Notificaciones"]'), `${nombre}: ninguna campana en el cuerpo`).toHaveCount(0);
        await expect(page.getByTestId("barra-pagina-fecha"), `${nombre}: un solo chip de fecha`).toHaveCount(1);
        expect(((await page.getByTestId("barra-pagina-fecha").textContent()) ?? "").trim(), `${nombre}: fecha de hoy`).toMatch(FORMATO_FECHA);
        await expect(page.getByTestId("mobile-header"), `${nombre}: el encabezado movil no se ve en escritorio`).toBeHidden();
      } else {
        await expect(page.getByTestId("barra-pagina"), `${nombre}: la barra de escritorio no se ve en movil`).toBeHidden();
        const cabecera = page.getByTestId("mobile-header");
        await expect(cabecera, `${nombre}: un solo encabezado movil visible`).toBeVisible();
        await expect(page.getByTestId("mobile-pagina-titulo"), `${nombre}: titulo de la pagina en el encabezado movil`).toHaveText(/\S/);
        await expect(campanas(page), `${nombre}: UNA sola campana visible`).toHaveCount(1);
        await expect(cabecera.locator('[aria-label^="Notificaciones"]'), `${nombre}: la campana vive en el encabezado movil`).toHaveCount(1);
        // El chat no se pinta suelto en el encabezado ni en el cuerpo; vive una vez en el menu de cuenta.
        const antes = await contarChat(page);
        expect(antes.total, `${nombre}: sin "Chatea con tus datos" suelto antes de abrir el menu de cuenta`).toBe(0);
        expect(antes.enMain, `${nombre}: ningun chat dentro del cuerpo`).toBe(0);
        await cabecera.getByRole("button", { name: "Abrir menú de cuenta" }).click();
        const menu = page.getByRole("dialog");
        await expect(menu.getByRole("link", { name: NOMBRE_CHAT }).or(menu.getByRole("button", { name: NOMBRE_CHAT })), `${nombre}: UN chat en el menu de cuenta`).toHaveCount(1);
        const abierto = await contarChat(page);
        expect(abierto.total, `${nombre}: UN solo chat visible con el menu abierto`).toBe(1);
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
      }
      if (dir) await page.screenshot({ path: join(dir, `${nombre}-${info.project.name}.png`) });
      if (nombre === "copiloto" && dir) {
        // "Consulta" con el campo vacio abre las tarjetas (VENTAS, OPERACION, CLIENTES, CFO).
        await page.getByRole("button", { name: "Consulta" }).click();
        await expect(page.getByTestId("copiloto-categorias").or(page.locator(".copiloto-categorias-entra")).first()).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(dir, `copiloto-tarjetas-${info.project.name}.png`) });
      }
    }
    vigilante.verificar();
  });
});
