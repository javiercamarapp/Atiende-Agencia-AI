// ds3 / lote 5 (marco del shell): geometria REAL en el navegador con la bandera encendida, en las 7 consolas (6 verticales + superadmin).
// Escritorio: el documento no hace scroll (scrollHeight === innerHeight), lienzo de 16 (sidebar en 16,16 de 232 x alto-32; marco desde
// 16+232+16 hasta ancho-16), tarjetas de radio 12 y contenido con padding 24/24/28. Superadmin ademas con el Copiloto (Cmd+J) abierto:
// el panel queda a 16 del marco y del borde y el documento sigue sin scroll. Movil: sin scroll horizontal.
// Enciende ds3 por su cuenta (no depende de E2E_DISENO): mide el diseno nuevo. Solo AÑADE.
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { VERTICALES } from "../e2e/mock-api/personas.ts";
import { esperarSinCarga } from "./comun.ts";

type Consola = (typeof VERTICALES)[number] | "superadmin";
const CONSOLAS: readonly Consola[] = [...VERTICALES, "superadmin"];

interface Geometria {
  docScrollY: number;
  docScrollX: number;
  vw: number;
  vh: number;
  aside: { x: number; y: number; w: number; h: number; radio: string } | null;
  marco: { x: number; y: number; right: number; h: number; radio: string } | null;
  padding: string | null;
  copiloto: { x: number; right: number; w: number; h: number; y: number } | null;
}

function medirMarco(): Geometria {
  const r = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
  const aside = document.querySelector("aside.ds3-sidebar");
  const marco = document.querySelector(".ds3-shell-marco");
  const main = document.querySelector("main.ds3-shell-contenido");
  const cop = document.querySelector('.copiloto-panel-lateral[data-abierto="true"]');
  const ra = r(aside);
  const rm = r(marco);
  const rc = r(cop);
  const cs = main ? getComputedStyle(main) : null;
  return {
    docScrollY: document.documentElement.scrollHeight - window.innerHeight,
    docScrollX: document.documentElement.scrollWidth - window.innerWidth,
    vw: window.innerWidth,
    vh: window.innerHeight,
    aside: ra && aside ? { x: ra.x, y: ra.y, w: ra.width, h: ra.height, radio: getComputedStyle(aside).borderTopLeftRadius } : null,
    marco: rm && marco ? { x: rm.x, y: rm.y, right: rm.right, h: rm.height, radio: getComputedStyle(marco).borderTopLeftRadius } : null,
    padding: cs ? `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}` : null,
    copiloto: rc ? { x: rc.x, right: rc.right, w: rc.width, h: rc.height, y: rc.y } : null,
  };
}

const cerca = (a: number, b: number) => Math.abs(a - b) <= 1;

for (const consola of CONSOLAS) {
  test(`marco ds3: ${consola}`, async ({ page, iniciarSesion }, info) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("atiende-diseno", "ds3");
      } catch {
        // sin almacenamiento
      }
    });
    await iniciarSesion(consola, "owner");
    await esperarSinCarga(page);
    // La entrada de pagina (250 ms) y el fundido de la capa de arranque deben terminar antes de medir.
    await page.waitForTimeout(800);
    const g = await page.evaluate(medirMarco);
    const movil = info.project.name.startsWith("m");

    expect(g.docScrollX, `${consola}: sin scroll horizontal`).toBeLessThanOrEqual(0);
    if (movil) return;

    expect(g.docScrollY, `${consola}: el documento no hace scroll en escritorio`).toBeLessThanOrEqual(0);
    expect(g.aside, `${consola}: sidebar`).not.toBeNull();
    expect(g.marco, `${consola}: marco`).not.toBeNull();
    const a = g.aside!;
    const m = g.marco!;
    expect(cerca(a.x, 16) && cerca(a.y, 16), `${consola}: sidebar en 16,16 (${a.x},${a.y})`).toBe(true);
    expect(cerca(a.w, 232), `${consola}: sidebar de 232 (${a.w})`).toBe(true);
    expect(cerca(a.h, g.vh - 32), `${consola}: sidebar de alto - 32 (${a.h})`).toBe(true);
    expect(cerca(m.x, 16 + 232 + 16), `${consola}: marco tras el gap de 16 (${m.x})`).toBe(true);
    expect(cerca(m.right, g.vw - 16), `${consola}: borde derecho a 16 (${m.right} de ${g.vw})`).toBe(true);
    expect(cerca(m.y, 16) && cerca(m.h, g.vh - 32), `${consola}: marco a alto - 32`).toBe(true);
    expect(a.radio).toBe("12px");
    expect(m.radio).toBe("12px");
    expect(g.padding, `${consola}: contenido 24/24/28`).toBe("24px 24px 28px 24px");

    if (consola === "superadmin") {
      await page.keyboard.press("ControlOrMeta+j");
      await expect(page.locator('.copiloto-panel-lateral[data-abierto="true"]')).toHaveCount(1);
      await page.waitForTimeout(700); // transicion de ancho de 480 ms
      const abierta = await page.evaluate(medirMarco);
      const c = abierta.copiloto!;
      expect(abierta.docScrollY, "superadmin con Copiloto abierto: sin scroll").toBeLessThanOrEqual(0);
      expect(cerca(c.right, abierta.vw - 16), `Copiloto a 16 del borde (${c.right})`).toBe(true);
      expect(cerca(c.x, abierta.marco!.right + 16), `Copiloto a 16 del marco (${c.x} vs ${abierta.marco!.right})`).toBe(true);
      expect(cerca(c.y, 16) && cerca(c.h, abierta.vh - 32), "Copiloto a alto - 32").toBe(true);
    }
  });
}
