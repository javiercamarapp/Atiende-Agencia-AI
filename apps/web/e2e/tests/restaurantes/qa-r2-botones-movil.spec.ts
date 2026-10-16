// QA adversarial ronda 2 (lente botones) -- movil: en cada pagina del panel, despues de bajar hasta el final, el ULTIMO control de la pagina
// debe poder pulsarse (no quedar debajo de la barra inferior fija). Se mide con elementFromPoint en el centro del control: si lo que esta
// encima es la barra "Navegacion movil", el control esta tapado. Solo corre en los proyectos moviles.
import { expect, test } from "../../helpers/fixtures.ts";
import { DESTINOS, ir } from "../../helpers/recorrido.ts";
import { esMovil } from "../../helpers/navegacion.ts";

test.describe("restaurantes R2 botones: movil, controles al final de la pagina @recorrido", () => {
  test("movil: el ultimo control de cada pagina no queda tapado por la barra inferior", async ({ page, iniciarSesion }) => {
    test.skip(!esMovil(page), "solo movil");
    test.setTimeout(180_000);
    await iniciarSesion("restaurantes", "owner");
    const tapados: string[] = [];
    for (const d of DESTINOS) {
      await ir(page, d.sub);
      // Deja que la pagina termine de cargar sus datos (sin estados de carga visibles).
      await expect(page.locator("main#contenido-principal [aria-busy=true]")).toHaveCount(0);
      await page.waitForLoadState("networkidle");
      const resultado = await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        const main = document.querySelector("main#contenido-principal");
        const nav = document.querySelector('nav[aria-label="Navegación móvil"]');
        if (!main || !nav) return null;
        const controles = [...main.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea")].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        });
        const ultimo = controles.at(-1);
        if (!ultimo) return null;
        const r = ultimo.getBoundingClientRect();
        const encima = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, window.innerHeight - 1));
        const tapado = encima !== null && !ultimo.contains(encima) && nav.contains(encima);
        return { tapado, texto: (ultimo.innerText || ultimo.getAttribute("aria-label") || ultimo.tagName).trim().slice(0, 40), top: Math.round(r.top), navTop: Math.round(nav.getBoundingClientRect().top) };
      });
      if (resultado?.tapado) tapados.push(`${d.sub || "/"}: "${resultado.texto}" (top ${resultado.top} >= barra ${resultado.navTop})`);
    }
    expect(tapados, `controles tapados por la barra movil:\n${tapados.join("\n")}`).toEqual([]);
  });
});
