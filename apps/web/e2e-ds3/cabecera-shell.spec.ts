// ds3 / lote 5.1 (encabezado): en el navegador, con la bandera, el encabezado del marco mide 44 px en las 7 consolas (la raiz ds3 de
// 13 px encogia el h-11 en rem a 36: la zona fija su alto en px) y el boton «Guía» se ve junto al titulo. Solo escritorio. Solo AÑADE.
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { VERTICALES } from "../e2e/mock-api/personas.ts";
import { esperarSinCarga } from "./comun.ts";

const CONSOLAS = [...VERTICALES, "superadmin"] as const;

for (const consola of CONSOLAS) {
  test(`encabezado ds3 de 44 px: ${consola}`, async ({ page, iniciarSesion }, info) => {
    // El encabezado de 44 es de escritorio; en movil la cabecera es otra (lote 5.3) y esta prueba no tiene nada que medir.
    if (info.project.name.startsWith("m")) return;
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("atiende-diseno", "ds3");
      } catch {
        // sin almacenamiento
      }
    });
    await iniciarSesion(consola, "owner");
    await esperarSinCarga(page);
    const zona = page.locator(".ds3-cabecera-zona");
    const caja = await zona.boundingBox();
    expect(caja && Math.round(caja.height), `${consola}: alto del encabezado`).toBe(44);
    const guia = page.getByTestId("barra-guia");
    await expect(guia).toBeVisible();
    const g = await guia.boundingBox();
    expect(g && Math.round(g.height), `${consola}: «Guía» de 28`).toBe(28);
    // Bloque visible del titulo (icono + nombre): en el Resumen el <p> del diseno actual queda oculto y se ve el nombre de la pagina.
    const titulo = await page.locator(".ds3-cabecera-titulo").boundingBox();
    expect(titulo && g && g.x > titulo.x, `${consola}: «Guía» va despues del titulo`).toBe(true);
  });
}
