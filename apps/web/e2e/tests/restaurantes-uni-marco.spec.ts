// UNI-MARCO (restaurantes): UNA sola barra superior del marco en CADA ruta del panel, sin controles repetidos.
// Convencion: la barra (`BarraPagina`, montada una vez por el `VerticalShell`) lleva SOLO el titulo de la pagina (y las acciones propias de
// la pagina): sin "Pregúntale a tus datos", campana ni fecha (orden del dueno). Ninguna pagina los repite en su cuerpo.
// En las 29 rutas con shell, en claro, oscuro y 375 px, exige EXACTAMENTE UNA instancia visible de cada control:
//   escritorio: barra delgada solo con titulo; campana y chat accesibles desde el pie del menu lateral.
//   movil (375 px): la barra de escritorio no existe; el encabezado movil (logo + menu de cuenta + fila con el titulo) la
//   sustituye; campana y chat viven en "Mas" > "Cuenta".
// El PNG solo se escribe si CAPTURAS_UNI_MARCO_DIR apunta a una carpeta (CI no genera nada). Corre tambien en oscuro (@oscuro).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { expect, test } from "../helpers/fixtures.ts";
import type { Locator } from "@playwright/test";
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

const NOMBRE_CHAT = /^Pregúntale a tus datos/;

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
  const textos = await page.getByText(/Pregúntale a tus datos/).filter({ visible: true }).count();
  return { total, enMain, textos };
}

/** Controles con `aria-label` "Notificaciones..." visibles en toda la pantalla (en escritorio incluye la pildora del pie del menu lateral; en movil, con el menu cerrado, ninguno). */
const campanas = (page: Page) => page.locator('[aria-label^="Notificaciones"]').filter({ visible: true });

test.describe("UNI-MARCO restaurantes: una sola barra, un solo juego de controles @oscuro", () => {
  test("las 29 rutas llevan exactamente una barra delgada (solo titulo; sin chat, campana ni fecha)", async ({ page, iniciarSesion, vigilante }, info) => {
    test.setTimeout(240_000);
    await iniciarSesion("restaurantes", "owner");
    const dir = destino();
    expect(RUTAS_RESTAURANTES).toHaveLength(29);
    for (const [nombre, ruta] of RUTAS_RESTAURANTES) {
      await page.goto(`${BASE}${ruta}`);
      await afirmarPantallaSana(page, nombre);
      await afirmarSinScrollHorizontal(page);

      // El Resumen no repite el acceso al Copiloto en su cuerpo (vive en la barra / menu de cuenta y en el Sidebar).
      await expect(page.locator("main#contenido-principal").getByRole("link", { name: /Pregúntale a tus datos/ }), `${nombre}: sin pildora «Pregúntale a tus datos» en el cuerpo`).toHaveCount(0);
      if (!esMovil(page)) {
        const barra = page.getByTestId("barra-pagina");
        await expect(barra, `${nombre}: exactamente una barra visible`).toHaveCount(1);
        await expect(barra).toBeVisible();
        await expect(page.getByTestId("barra-pagina-titulo"), `${nombre}: titulo de la pagina en la barra`).toHaveText(/\S/);
        // Orden del dueno: la barra va delgada. Sin "Pregúntale a tus datos", sin campana, sin fecha (ni en la barra ni en el cuerpo).
        const chat = await contarChat(page);
        const entradaChat = (raiz: Locator) => raiz.getByRole("link", { name: NOMBRE_CHAT }).or(raiz.getByRole("button", { name: NOMBRE_CHAT }));
        await expect(entradaChat(barra), `${nombre}: la barra no lleva boton de "Pregúntale a tus datos"`).toHaveCount(0);
        // UNA sola entrada con ese nombre en toda la pantalla: la pildora del pie del menu lateral (el titulo de la barra del Copiloto es texto, no control).
        expect(chat.total, `${nombre}: UNA sola entrada "Pregúntale a tus datos" visible`).toBe(1);
        await expect(entradaChat(page.locator("aside")), `${nombre}: la entrada vive en el pie del menu`).toHaveCount(1);
        expect(chat.enMain, `${nombre}: ningun "Pregúntale a tus datos" dentro del cuerpo de la pagina`).toBe(0);
        await expect(barra.locator('[aria-label^="Notificaciones"]'), `${nombre}: sin campana en la barra`).toHaveCount(0);
        await expect(page.getByTestId("barra-pagina-fecha"), `${nombre}: sin chip de fecha`).toHaveCount(0);
        expect(((await barra.boundingBox())?.height ?? 99), `${nombre}: barra delgada (~44 px)`).toBeLessThanOrEqual(48);
        // Las funciones siguen accesibles desde el pie del menu lateral.
        await expect(page.locator("aside").getByRole("link", { name: "Notificaciones" }), `${nombre}: Notificaciones en el pie del menu`).toHaveCount(1);
        await expect(page.getByTestId("mobile-header"), `${nombre}: el encabezado movil no se ve en escritorio`).toBeHidden();
      } else {
        await expect(page.getByTestId("barra-pagina"), `${nombre}: la barra de escritorio no se ve en movil`).toBeHidden();
        const cabecera = page.getByTestId("mobile-header");
        await expect(cabecera, `${nombre}: un solo encabezado movil visible`).toBeVisible();
        await expect(page.getByTestId("mobile-pagina-titulo"), `${nombre}: titulo de la pagina en el encabezado movil`).toHaveText(/\S/);
        await expect(campanas(page), `${nombre}: sin campana en el encabezado movil`).toHaveCount(0);
        expect((await cabecera.boundingBox())?.height ?? 99, `${nombre}: encabezado movil compacto`).toBeLessThanOrEqual(84);
        const antes = await contarChat(page);
        expect(antes.total, `${nombre}: sin "Pregúntale a tus datos" en el encabezado ni en el cuerpo`).toBe(0);
        expect(antes.enMain, `${nombre}: ningun chat dentro del cuerpo`).toBe(0);
        // El menu de cuenta conserva tema y cierre de sesion; el chat y las notificaciones viven en "Mas" > "Cuenta".
        await cabecera.getByRole("button", { name: "Abrir menú de cuenta" }).click();
        const menu = page.getByRole("dialog");
        await expect(menu.getByRole("button", { name: "Cerrar sesión" }), `${nombre}: cerrar sesion sigue en el menu de cuenta`).toHaveCount(1);
        await expect(menu.getByRole("link", { name: NOMBRE_CHAT }).or(menu.getByRole("button", { name: NOMBRE_CHAT })), `${nombre}: el chat ya no va en el menu de cuenta`).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
      }
      if (nombre === "copiloto") await expect(page.getByTestId("barra-pagina-titulo").or(page.getByTestId("mobile-pagina-titulo")).first(), "el Copiloto lleva su nombre en la barra").toHaveText("Pregúntale a tus datos");
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
