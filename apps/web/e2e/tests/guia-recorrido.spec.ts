// ds3 «Guía»: recorrido guiado de punta a punta contra el build y la API simulada. Con la bandera ds3: invitacion al primer ingreso,
// recorrido corto de 7 pasos, la tarjeta NUNCA tapa el elemento resaltado (defecto de Rovaq a 1440), viaje automatico entre pantallas,
// Esc cierra y conserva el paso, el progreso llega al servidor (PUT /v1/onboarding/progreso) y «Retomar donde lo dejé» lo recupera.
// Sin la bandera, la guia no se pinta. El boton «Guía» de la cabecera (carril del shell) emite `atiende:guia:abrir`; aqui se emite igual.
import type { Page } from "@playwright/test";
import type { ClienteMock } from "../mock-api/cliente.ts";
import { esperarQuieto } from "../helpers/esperas.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

// ds3 es el diseno por omision: ya no hay bandera que encender. Lo que estas pruebas necesitan es el PRIMER ingreso de la persona (sin
// progreso guardado), que la API simulada solo da si se le pide; el resto de las pruebas entra como quien ya descarto la invitacion.
async function primerIngreso(mock: ClienteMock): Promise<void> {
  await mock.configurar({ guiaPrimerIngreso: true });
}

/**
 * La tarjeta y el foco ya se colocaron: sus cajas quietas cinco cuadros seguidos (entrada de 180 ms y viaje de 360-380 ms terminados).
 * No espera TODAS las animaciones de la pagina: en el paso «Vamos a» la barra de la cuenta de 3 s anima sin parar y esperarla dejaria
 * que el viaje automatico ocurra antes de afirmar el paso.
 */
async function guiaAsentada(page: Page): Promise<void> {
  await esperarQuieto(page.locator(".guia-tarjeta"), 5);
  const foco = page.locator(".guia-capa:not([data-sin-foco]) .guia-foco");
  if ((await foco.count()) > 0) await esperarQuieto(foco.first(), 5);
}

/** Avanza un paso con la flecha y espera a que la tarjeta muestre otro paso (su texto cambia). */
async function avanzarPaso(page: Page): Promise<void> {
  const tarjeta = page.locator(".guia-tarjeta");
  const previo = await tarjeta.innerText();
  await page.keyboard.press("ArrowRight");
  await expect(tarjeta).not.toHaveText(previo, { useInnerText: true });
}

const abrirGuia = (page: Page) => page.evaluate(() => window.dispatchEvent(new CustomEvent("atiende:guia:abrir")));

async function seTocan(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const foco = document.querySelector(".guia-capa:not([data-sin-foco]) .guia-foco")?.getBoundingClientRect();
    const tarjeta = document.querySelector(".guia-tarjeta")?.getBoundingClientRect();
    if (!foco || !tarjeta) return false;
    return tarjeta.left < foco.right && foco.left < tarjeta.right && tarjeta.top < foco.bottom && foco.top < tarjeta.bottom;
  });
}

test.describe("guia @ds3", () => {
  test("owner de restaurantes: invitacion, recorrido corto sin tapar el foco, viaje, Esc y retomar", async ({ page, iniciarSesion, mock }, info) => {
    test.skip(info.project.name.startsWith("movil"), "el caso movil va en su propia prueba");
    await primerIngreso(mock);
    await iniciarSesion("restaurantes", "owner");
    const inv = page.locator(".guia-invitacion");
    await expect(inv).toContainText("Conoce Atiende");
    await expect(inv.locator('[data-guia-modo="corto"]')).toHaveText(/Recorrido corto \(\d+ pasos\)/);
    await info.attach("01-invitacion", { body: await page.screenshot(), contentType: "image/png" });

    await inv.locator('[data-guia-modo="corto"]').click();
    const tarjeta = page.locator(".guia-tarjeta");
    await expect(tarjeta).toBeVisible();
    await expect(tarjeta.locator(".guia-contador").first()).toHaveText(/Paso 1 de \d+/);
    await expect(page.locator(".guia-capa .guia-foco")).toBeVisible();
    await guiaAsentada(page);
    expect(await seTocan(page), "la tarjeta tapa el elemento resaltado").toBe(false);
    await info.attach("02-paso-1", { body: await page.screenshot(), contentType: "image/png" });

    // Avanza hasta el primer salto de pantalla: cuenta de 3 s y viaje real por el menu.
    for (let i = 0; i < 4 && !(await tarjeta.locator("h2").innerText()).startsWith("Vamos a"); i++) {
      await avanzarPaso(page);
      await guiaAsentada(page);
      expect(await seTocan(page), "la tarjeta tapa el elemento resaltado").toBe(false);
    }
    await expect(tarjeta.locator("h2")).toHaveText(/^Vamos a /);
    await expect(page.locator(".guia-etiqueta")).toContainText("Haz clic aquí:");
    await info.attach("03-te-llevo", { body: await page.screenshot(), contentType: "image/png" });
    const antes = page.url();
    await expect.poll(() => page.url(), { timeout: 8_000 }).not.toBe(antes);
    await expect(tarjeta.locator("h2")).not.toHaveText(/^Vamos a /);

    // Esc cierra y conserva el paso; el progreso viaja al servidor.
    await page.keyboard.press("Escape");
    await expect(tarjeta).toHaveCount(0);
    // El PUT de Esc sale tras el debounce (400 ms): se espera a que el ULTIMO PUT ya sea el de cierre (los de pasos previos traen activo:true).
    const ultimoPut = async () => (await mock.buscar({ metodo: "PUT", ruta: "/v1/onboarding/progreso" })).at(-1)?.cuerpo as Record<string, unknown> | undefined;
    await expect.poll(async () => (await ultimoPut())?.activo).toBe(false);
    const ultimo = (await ultimoPut())!;
    expect(ultimo).toMatchObject({ pista: "restaurantes.owner", org: restaurantes.orgSlug, modo: "corto", activo: false });

    // Menu de la guia: rol, recorridos, retomar y saltar a una pantalla.
    await abrirGuia(page);
    const menu = page.locator("#guia-menu");
    await expect(menu).toContainText("Recorrido corto");
    await expect(menu).toContainText("Recorrido completo");
    await expect(menu).toContainText("Saltar a una pantalla");
    await info.attach("04-menu", { body: await page.screenshot(), contentType: "image/png" });
    await menu.locator("[data-guia-retomar]").click();
    await expect(tarjeta).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("movil: la tarjeta es una hoja inferior que no tapa la barra de navegacion ni el elemento", async ({ page, iniciarSesion, mock }, info) => {
    test.skip(!info.project.name.startsWith("movil"), "solo movil");
    await primerIngreso(mock);
    await iniciarSesion("restaurantes", "owner");
    await page.locator('.guia-invitacion [data-guia-modo="corto"]').click();
    const tarjeta = page.locator(".guia-tarjeta");
    await expect(tarjeta).toBeVisible();
    await guiaAsentada(page);
    const caja = (await tarjeta.boundingBox())!;
    const vista = page.viewportSize()!;
    expect(caja.x).toBeGreaterThanOrEqual(11);
    expect(caja.x + caja.width).toBeLessThanOrEqual(vista.width - 11);
    expect(caja.y + caja.height).toBeLessThanOrEqual(vista.height - 63);
    expect(await seTocan(page)).toBe(false);
    await info.attach("movil-paso-1", { body: await page.screenshot(), contentType: "image/png" });
  });

  test("movimiento reducido: sin viaje automatico, queda «Ir a …»", async ({ page, iniciarSesion, mock }, info) => {
    test.skip(info.project.name.startsWith("movil"), "escritorio basta");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await primerIngreso(mock);
    await iniciarSesion("restaurantes", "owner");
    await page.locator('.guia-invitacion [data-guia-modo="corto"]').click();
    const tarjeta = page.locator(".guia-tarjeta");
    for (let i = 0; i < 4 && !(await tarjeta.locator("h2").innerText()).startsWith("Vamos a"); i++) {
      await avanzarPaso(page);
    }
    await expect(page.locator("[data-guia-cuenta]")).toHaveCount(0);
    await expect(page.locator("[data-guia-manual]")).toHaveText(/^Ir a /);
  });

  // Antes «sin la bandera ds3 la guia no se pinta»: ds3 ya es de todos (solo VITE_DISENO_LEGADO=1 en el build lo apaga, y el build de
  // e2e no lo usa), asi que sin preparar nada la guia existe: lee el progreso del servidor, respeta que ya se descarto (no invita) y el
  // boton «Guía» abre su menu.
  test("por omision la guia existe: lee el progreso, no reinvita a quien la descarto y escucha el boton", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("restaurantes", "owner");
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "/v1/onboarding/progreso" })).length).toBeGreaterThan(0);
    // La respuesta del servidor ya se aplico: la guia la guarda en el navegador (clave atiende-guia.*) despues de reconciliarla.
    await page.waitForFunction(() =>
      Object.keys(localStorage).some((k) => {
        if (!k.startsWith("atiende-guia.")) return false;
        try {
          return (JSON.parse(localStorage.getItem(k) ?? "{}") as { descartado?: unknown }).descartado === true;
        } catch {
          return false;
        }
      }),
    );
    await expect(page.locator(".guia-invitacion")).toHaveCount(0);
    await abrirGuia(page);
    await expect(page.locator("#guia-menu")).toContainText("Recorrido corto");
  });
});
