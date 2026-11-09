// Portada del Copiloto: las preguntas se agrupan en temas (una fila de temas; el primero viene activo). Para usar una pregunta de otro
// tema, primero se activa ese tema. `donde` es la pagina o el panel lateral (Cmd+J) del superadmin.
import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

export async function mostrarTema(donde: Page | Locator, tema: string): Promise<void> {
  const boton = donde.getByTestId("copiloto-temas").getByRole("button", { name: tema, exact: true });
  await boton.click();
  await expect(boton).toHaveAttribute("aria-pressed", "true");
}
