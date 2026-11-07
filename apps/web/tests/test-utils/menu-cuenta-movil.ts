// Flujo compartido por los specs de nav móvil de cada Shell. Decisión de Omar 7-nov-2026 (reemplaza «encabezado móvil sin campana»):
// el MobileHeader lleva la campana (enlace a /notificaciones, solo-ds3: existe oculta sin la bandera) y el botón del menú de cuenta;
// el chat de datos NO va en el encabezado (es «Preguntar» de la barra inferior). El menú trae "Cerrar sesión" (POST /auth/logout).
import { act } from "react";
import { expect, vi } from "vitest";
import { click, flushMicrotasks } from "./render.tsx";

/** Campana del encabezado móvil: una sola, enlace a la página de notificaciones de la consola, marcada solo-ds3 (oculta sin la bandera). */
export function afirmarCampanaMovil(mobileHeader: HTMLElement): HTMLAnchorElement {
  const campanas = mobileHeader.querySelectorAll<HTMLAnchorElement>('a[data-testid="movil-campana"]');
  expect(campanas, "una campana en el encabezado movil").toHaveLength(1);
  const campana = campanas[0]!;
  expect(campana.getAttribute("aria-label")).toMatch(/^Notificaciones/);
  expect(campana.getAttribute("href")).toMatch(/\/notificaciones$/);
  expect(campana.hidden, "solo-ds3: oculta sin la bandera").toBe(true);
  expect(campana.classList.contains("ds3-solo")).toBe(true);
  return campana;
}

export async function cerrarSesionDesdeMenuMovil(container: HTMLElement): Promise<ReturnType<typeof vi.fn>> {
  const mobileHeader = [...container.querySelectorAll("header")].find((h) => h.className.includes("md:hidden"));
  expect(mobileHeader).toBeDefined();
  // Decision de Omar 7-nov-2026: el encabezado movil lleva la campana; el chat sigue fuera del encabezado.
  afirmarCampanaMovil(mobileHeader!);
  expect(mobileHeader!.textContent).not.toContain("Pregúntale a tus datos");
  click(mobileHeader!.querySelector('button[aria-label="Abrir menú de cuenta"]')!);
  const hoja = document.body.querySelector('[role="dialog"]')!;
  expect(hoja.textContent).not.toContain("Pregúntale a tus datos");
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
