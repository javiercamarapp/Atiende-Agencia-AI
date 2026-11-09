// Esperas por condicion para las pruebas de navegador (en lugar de `page.waitForTimeout`, que adivina cuanto tarda algo y o se queda
// corto en CI o alarga la suite en balde). Guard: apps/web/tests/e2e-sin-waitfortimeout.spec.ts.
import type { Locator, Page } from "@playwright/test";

/** Deja pasar `n` cuadros de pintado (requestAnimationFrame): da a la pagina la oportunidad de recalcular estilos y pintar. */
export async function esperarCuadros(page: Page, n = 2): Promise<void> {
  await page.evaluate(
    (total) =>
      new Promise<void>((resolve) => {
        let vistos = 0;
        const paso = () => (++vistos >= total ? resolve() : requestAnimationFrame(paso));
        requestAnimationFrame(paso);
      }),
    n,
  );
}

/**
 * Espera a que terminen las animaciones y transiciones CSS/WAAPI finitas del documento (entradas escalonadas, hover, cambio de tema).
 * Las infinitas (spinners, pulsos) se ignoran porque nunca terminan; el canvas animado por requestAnimationFrame no es una Animation.
 * Antes deja pasar dos cuadros para que una transicion recien disparada (p. ej. al cambiar un atributo) ya este registrada.
 */
export async function esperarAnimaciones(page: Page, timeout = 10_000): Promise<void> {
  await esperarCuadros(page, 2);
  await page.waitForFunction(
    () =>
      document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity),
    undefined,
    { timeout },
  );
}

/** Espera a que la caja del elemento deje de moverse: la misma posicion y tamano durante `cuadros` cuadros seguidos. */
export async function esperarQuieto(locator: Locator, cuadros = 3): Promise<void> {
  await locator.evaluate(
    (el, n) =>
      new Promise<void>((resolve) => {
        let previo = "";
        let iguales = 0;
        const paso = () => {
          const r = el.getBoundingClientRect();
          const actual = `${r.x},${r.y},${r.width},${r.height}`;
          iguales = actual === previo ? iguales + 1 : 0;
          previo = actual;
          if (iguales >= n) resolve();
          else requestAnimationFrame(paso);
        };
        requestAnimationFrame(paso);
      }),
    cuadros,
  );
}
