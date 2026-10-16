// Flujo compartido por los specs de nav móvil de cada Shell: en el MobileHeader
// deben estar la campana y el botón del menú de cuenta; el menú trae
// "Chatea con tus datos" y "Cerrar sesión", que dispara POST /auth/logout.
import { act } from "react";
import { expect, vi } from "vitest";
import { click, flushMicrotasks } from "./render.tsx";

export async function cerrarSesionDesdeMenuMovil(container: HTMLElement): Promise<ReturnType<typeof vi.fn>> {
  const mobileHeader = [...container.querySelectorAll("header")].find((h) => h.className.includes("md:hidden"));
  expect(mobileHeader).toBeDefined();
  expect(mobileHeader!.querySelector('button[aria-label^="Notificaciones"]')).not.toBeNull();
  click(mobileHeader!.querySelector('button[aria-label="Abrir menú de cuenta"]')!);
  const hoja = document.body.querySelector('[role="dialog"]')!;
  expect(hoja.textContent).toContain("Chatea con tus datos");
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => {
    click([...hoja.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cerrar sesión")!);
    await flushMicrotasks();
    await flushMicrotasks();
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.test/auth/logout");
  return fetchMock;
}
