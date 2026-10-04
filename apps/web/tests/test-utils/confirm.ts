// Ayudantes de prueba para el <ConfirmDialog> de @atiende/ui (useConfirm): el dialogo vive en un portal
// (document.body, role="alertdialog"), no dentro del contenedor del componente que se renderiza.
import { act } from "react";
import { click, flushMicrotasks } from "./render.tsx";

export const dialogoConfirm = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="alertdialog"]');

export function botonDelDialogo(texto: string): HTMLButtonElement | undefined {
  const d = dialogoConfirm();
  return d ? ([...d.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined) : undefined;
}

/** Pulsa un boton del dialogo de confirmacion (p. ej. "Cancelar" o la etiqueta de confirmar) y deja correr las promesas. */
export async function pulsarEnDialogo(texto: string): Promise<void> {
  const b = botonDelDialogo(texto);
  if (!b) throw new Error(`No hay boton "${texto}" en el dialogo de confirmacion`);
  await act(async () => {
    click(b);
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
