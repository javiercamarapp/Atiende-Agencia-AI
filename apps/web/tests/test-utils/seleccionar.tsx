// Ayudas para probar el `Selector` de @atiende/ui (Radix Select) en jsdom, que no es un <select> nativo:
// el disparador es un `button[role=combobox]` y la lista vive en un portal. `prepararJsdomParaRadix()` instala las APIs
// que jsdom no trae (puntero, scrollIntoView, ResizeObserver) y debe llamarse una vez por archivo (beforeAll).
import { act } from "react";
import { flushMicrotasks, keydown } from "./render.tsx";

export function prepararJsdomParaRadix(): void {
  const p = Element.prototype as unknown as Record<string, unknown>;
  p.hasPointerCapture ??= () => false;
  p.setPointerCapture ??= () => {};
  p.releasePointerCapture ??= () => {};
  p.scrollIntoView ??= () => {};
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const opciones = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];

/** Todos los disparadores de lista (`role=combobox`) dentro del contenedor. */
export function comboboxes(raiz: ParentNode = document.body): HTMLElement[] {
  return [...raiz.querySelectorAll<HTMLElement>('[role="combobox"]')];
}

/** Abre la lista con el teclado (como un usuario) y deja que Radix monte el portal. */
export async function abrirLista(trigger: HTMLElement): Promise<void> {
  trigger.focus();
  keydown(trigger, "Enter");
  await act(async () => {
    await flushMicrotasks();
  });
}

/** Etiquetas de las opciones de una lista (la abre y la cierra con Escape). */
export async function etiquetasDeOpciones(trigger: HTMLElement): Promise<string[]> {
  await abrirLista(trigger);
  const textos = opciones().map((o) => o.textContent?.trim() ?? "");
  keydown(document.activeElement ?? document.body, "Escape");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  return textos;
}

/** Elige una opcion por su etiqueta exacta, como lo haria una persona (abrir, enfocar, Enter). */
export async function elegirOpcion(trigger: HTMLElement, etiqueta: string): Promise<void> {
  await abrirLista(trigger);
  const opcion = opciones().find((o) => o.textContent?.trim() === etiqueta);
  if (!opcion) throw new Error(`no hay opcion "${etiqueta}"; hay: ${opciones().map((o) => o.textContent?.trim()).join(" | ")}`);
  opcion.focus();
  keydown(opcion, "Enter");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

/** Etiqueta mostrada por un disparador (lo que ve la persona). */
export function etiquetaMostrada(trigger: HTMLElement): string {
  return trigger.textContent?.trim() ?? "";
}

// ---- Variantes sincronas (drop-in de `changeValue(select, valor)` y de leer `select.value`/`select.options`) ----
// Se apoyan en `data-valor`, que el `Selector` pone en el disparador (valor actual) y en cada opcion (su valor).

const opcionesSync = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];

/** Elige la opcion de ese VALOR (no etiqueta), como `changeValue(select, valor)` en un <select> nativo. */
export function elegirValor(trigger: Element | null, valor: string): void {
  if (!trigger) throw new Error(`no existe la lista donde elegir "${valor}"`);
  const t = trigger as HTMLElement;
  t.focus();
  keydown(t, "Enter");
  const opcion = opcionesSync().find((o) => o.dataset.valor === valor);
  if (!opcion) throw new Error(`no hay opcion con valor "${valor}"; hay: ${opcionesSync().map((o) => o.dataset.valor).join(" | ")}`);
  opcion.focus();
  keydown(opcion, "Enter");
}

/**
 * Cierra la lista abierta sin cambiar nada: confirma la opcion ya elegida (Enter sobre la marcada). No usa Escape: dentro de
 * un Dialog de Radix, jsdom deja la lista montada y un Escape en el body cerraria ademas el propio dialogo.
 */
function cerrarListaAbierta(): void {
  const lista = document.body.querySelector<HTMLElement>('[role="listbox"]');
  if (!lista) return;
  const actual = lista.querySelector<HTMLElement>('[role="option"][data-state="checked"]') ?? lista.querySelector<HTMLElement>('[role="option"]');
  if (!actual) return;
  actual.focus();
  keydown(actual, "Enter");
}

/** Valor actual del disparador (el `select.value` de un <select> nativo). */
export function valorDe(trigger: Element | null): string {
  return (trigger as HTMLElement | null)?.dataset.valor ?? "";
}

/** Etiquetas de las opciones (el `[...select.options].map(o => o.textContent)` de un <select> nativo). */
export function etiquetasDe(trigger: Element | null): string[] {
  if (!trigger) throw new Error("no existe la lista");
  const t = trigger as HTMLElement;
  t.focus();
  keydown(t, "Enter");
  const textos = opcionesSync().map((o) => o.textContent?.trim() ?? "");
  cerrarListaAbierta();
  return textos;
}

/** Valores de las opciones. */
export function valoresDe(trigger: Element | null): string[] {
  if (!trigger) throw new Error("no existe la lista");
  const t = trigger as HTMLElement;
  t.focus();
  keydown(t, "Enter");
  const v = opcionesSync().map((o) => o.dataset.valor ?? "");
  cerrarListaAbierta();
  return v;
}
