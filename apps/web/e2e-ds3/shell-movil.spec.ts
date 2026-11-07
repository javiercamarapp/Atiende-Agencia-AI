// Cabecera y barra inferior moviles ds3 (decision de Omar 7-nov-2026, igual que Rovaq): la cabecera lleva logo + campana de 44 con
// contador + menu de cuenta de 44, y la barra inferior es 4 destinos + «Preguntar» (chat de datos, solo para roles con acceso) + «Más».
// Corre en los proyectos moviles del config ds3 (m390-claro, m360-oscuro; con DS3_MATRIZ=completa tambien m390-oscuro y m360-claro) y
// SIEMPRE guarda una captura por consola en <DS3_SALIDA>/shell-movil/. Sin E2E_DISENO=ds3 verifica que la campana y «Preguntar» siguen
// ocultos (el diseno actual no cambia). No usa la API real: corre contra el mock.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { afirmarModo } from "../e2e/helpers/ds.ts";
import { barraMovil, esMovil } from "../e2e/helpers/navegacion.ts";
import { orgDe } from "../e2e/mock-api/personas.ts";
import type { Rol } from "../e2e/mock-api/tipos.ts";
import { esperarSinCarga, prepararBandera } from "./comun.ts";

const DS3 = process.env["E2E_DISENO"] === "ds3";
const SALIDA = join(process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia", "shell-movil");

interface Caso {
  readonly consola: "restaurantes" | "hoteles" | "superadmin";
  readonly rol?: Rol;
  /** Ruta del chat de datos si el rol tiene acceso (y la API simulada confirma el asistente); null = sin «Preguntar». */
  readonly preguntar: string | null;
  readonly notificaciones: string;
}

const CASOS: readonly Caso[] = [
  { consola: "restaurantes", rol: "owner", preguntar: `/restaurantes/${orgDe("restaurantes").slug}/copiloto`, notificaciones: `/restaurantes/${orgDe("restaurantes").slug}/notificaciones` },
  { consola: "superadmin", preguntar: "/superadmin/copiloto", notificaciones: "/superadmin/notificaciones" },
  // Rol sin Copiloto de hoteles (solo owner/gm): sin «Preguntar», la barra se queda en 4 + «Más».
  { consola: "hoteles", rol: "staff", preguntar: null, notificaciones: `/hoteles/${orgDe("hoteles").slug}/notificaciones` },
];

test.beforeEach(async ({ page }) => {
  await prepararBandera(page);
});

for (const caso of CASOS) {
  test(`shell movil: campana en la cabecera y «Preguntar» en la barra — ${caso.consola}${caso.rol ? ` (${caso.rol})` : ""}`, async ({ page, iniciarSesion, vigilante }, info) => {
    test.skip(!esMovil(page), "cabecera y barra inferior son solo de movil");
    const oscuro = info.project.name.endsWith("oscuro");
    await iniciarSesion(caso.consola, caso.rol);
    await expect(page.locator("main#contenido-principal")).toBeVisible();
    await esperarSinCarga(page);
    await afirmarModo(page, oscuro ? "oscuro" : "claro");
    // La capa de arranque ds3 se suelta tras 600 ms estables; antes de eso la captura solo veria el logo.
    if (DS3) await page.waitForFunction(() => document.documentElement.dataset["arranque"] === "suelto", undefined, { timeout: 15_000 });

    const cabecera = page.getByTestId("mobile-header");
    const campana = cabecera.getByTestId("movil-campana");
    const barra = barraMovil(page);
    const preguntar = barra.getByTestId("barra-preguntar");
    await expect(campana).toHaveCount(1);
    await expect(campana).toHaveAttribute("href", caso.notificaciones);
    await expect(preguntar).toHaveCount(caso.preguntar ? 1 : 0);

    if (!DS3) {
      // Diseno actual: los dos elementos existen ocultos; la barra sigue en 4 + «Más».
      await expect(campana).toBeHidden();
      if (caso.preguntar) await expect(preguntar).toBeHidden();
      await expect(barra.locator("li:visible")).toHaveCount(5);
      vigilante.verificar();
      return;
    }

    // Cabecera: logo a la izquierda; campana de 44 x 44 justo antes del menu de cuenta (44 x 44), todo en una fila de 56.
    await expect(campana).toBeVisible();
    await expect(campana).toHaveAttribute("aria-label", /^Notificaciones/);
    const menu = cabecera.getByRole("button", { name: "Abrir menú de cuenta" });
    const [cajaCampana, cajaMenu, ancho] = await Promise.all([campana.boundingBox(), menu.boundingBox(), page.evaluate(() => innerWidth)]);
    expect(cajaCampana && Math.round(cajaCampana.width)).toBe(44);
    expect(cajaCampana && Math.round(cajaCampana.height)).toBe(44);
    expect(cajaMenu && Math.round(cajaMenu.width)).toBe(44);
    expect(cajaCampana!.x + cajaCampana!.width).toBeLessThanOrEqual(cajaMenu!.x);
    expect(Math.abs(cajaCampana!.y - cajaMenu!.y)).toBeLessThanOrEqual(1);
    expect(cajaMenu!.x + cajaMenu!.width).toBeLessThanOrEqual(ancho);
    // La semilla trae 2 sin leer: el contador muestra el numero real y el nombre accesible lo dice.
    const contador = campana.getByTestId("movil-campana-contador");
    if ((await contador.count()) > 0) {
      await expect(contador).toBeVisible();
      await expect(campana).toHaveAttribute("aria-label", new RegExp(`^Notificaciones: ${(await contador.innerText()).trim()} sin leer$`));
    }
    await expect(cabecera).not.toContainText("Pregúntale a tus datos");

    // Barra: 4 destinos + «Preguntar» (si hay acceso) + «Más», ninguna etiqueta recortada, cada destino >= 44 de alto.
    const lugares = barra.locator("li:visible");
    await expect(lugares).toHaveCount(caso.preguntar ? 6 : 5);
    await expect(lugares.last()).toHaveText("Más");
    const recortadas = await barra.locator("li:visible .ds3-barra-destino > span:not([aria-hidden])").evaluateAll((spans) =>
      spans.filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent),
    );
    expect(recortadas, "etiquetas recortadas en la barra").toEqual([]);
    const altos = await barra.locator("li:visible .ds3-barra-destino").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    for (const alto of altos) expect(alto).toBeGreaterThanOrEqual(44);

    mkdirSync(SALIDA, { recursive: true });
    const nombre = `${caso.consola}${caso.rol ? "-" + caso.rol : ""}-${info.project.name}`;
    await page.screenshot({ path: join(SALIDA, `${nombre}.png`) });

    if (caso.preguntar) {
      await expect(lugares.nth(4)).toHaveText("Preguntar");
      await expect(preguntar).toHaveAttribute("href", caso.preguntar);
      await preguntar.click();
      await expect(page).toHaveURL(new RegExp(`${caso.preguntar}$`));
      await expect(preguntar).toHaveAttribute("aria-current", "page");
      await esperarSinCarga(page);
      await page.waitForFunction(() => document.documentElement.dataset["arranque"] === "suelto", undefined, { timeout: 15_000 });
      // En su ruta, «Más» no se marca aunque el chat tambien viva en las secciones (Copiloto).
      const mas = barra.getByRole("button", { name: /^Más/ });
      const fondoMas = await mas.evaluate((e) => getComputedStyle(e).backgroundColor);
      expect(fondoMas === "transparent" || fondoMas === "rgba(0, 0, 0, 0)").toBe(true);
      await page.screenshot({ path: join(SALIDA, `${nombre}-preguntar.png`) });
    }

    // La campana lleva a la pagina de notificaciones.
    await campana.click();
    await expect(page).toHaveURL(new RegExp(`${caso.notificaciones}$`));
    await expect(campana).toHaveAttribute("aria-current", "page");
    vigilante.verificar();
  });
}
