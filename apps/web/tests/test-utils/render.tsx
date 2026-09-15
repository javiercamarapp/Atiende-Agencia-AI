// Harness mínimo para renderizar componentes React reales en jsdom sin sumar
// @testing-library/react al repo (no estaba ya instalado -- ver el comentario de
// cabecera de vitest.config.ts, rubro 9 de la auditoría "0 tests de componentes
// React"). Usa react-dom/client (createRoot) + el `act` que exporta `react` 18.3+
// (shim de compatibilidad hacia adelante con React 19 -- reemplaza al `act` de
// react-dom/test-utils, deprecado), que ya vienen con react/react-dom 18.3.1 --
// cero dependencias nuevas de testing. Cada archivo de test que use esto necesita
// el pragma `// @vitest-environment jsdom` en su primera línea (el resto de la
// suite corre en environment "node").
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ReactElement } from "react";

declare global {
  // React 18.3+ lee esta bandera global para silenciar el warning "not configured
  // to support act(...)" (mismo criterio que @testing-library/react setea
  // internamente) -- `var` es obligatorio aquí: es la única forma válida de
  // ampliar `globalThis` con una declaración `declare global`.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export interface RenderedComponent {
  readonly container: HTMLElement;
  /** Vuelve a renderizar el mismo árbol con props/estado nuevo, dentro del mismo `act`. */
  rerender(next: ReactElement): void;
  /** Desmonta y limpia el nodo del DOM -- llamar en `afterEach`. */
  unmount(): void;
}

export function renderComponent(element: ReactElement): RenderedComponent {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(element);
  });
  return {
    container,
    rerender(next: ReactElement) {
      act(() => {
        root.render(next);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Dispara un click real (bubbles + click nativo del navegador) sobre el elemento. */
export function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Pone `value` en un <input>/<textarea>/<select> vía el setter nativo (para que el
 * detector de cambios "controlado" de React lo note, igual que `@testing-library/user-event`
 * hace por debajo) y dispara el evento `input`/`change` de React. */
export function changeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Envía el form y deja correr los microtasks pendientes (el `await` real dentro
 * del `onSubmit` del componente, p. ej. una llamada de red mockeada) DENTRO del
 * mismo `act()` async -- evita el warning "not wrapped in act(...)" que sale si el
 * dispatch y el flush de promesas quedan en dos `act()` separados. */
export async function submitForm(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushMicrotasks();
  });
}

/** Dos vueltas de microtask -- suficiente para que un `await algo()` con un `.then`
 * de por medio (p. ej. `res.json()` de un mock) termine de resolverse antes de la
 * siguiente aserción. */
export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export function keydown(target: EventTarget, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}
