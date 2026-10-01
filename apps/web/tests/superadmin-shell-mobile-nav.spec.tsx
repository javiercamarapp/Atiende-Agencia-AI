// @vitest-environment jsdom
//
// F-01 del informe de diseno-ux: SuperAdminShell no tenia MobileHeader ni
// BottomNav, asi que en movil el back office de plataforma no ofrecia ni
// navegacion, ni campana, ni cerrar sesion. Mismo patron que los specs de nav
// movil de las verticales.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SuperAdminShell } from "../src/superadmin/SuperAdminShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

// El banner sondea /superadmin/impersonacion/activa con un setInterval propio: no es lo que se prueba aqui.
vi.mock("../src/superadmin/components/ImpersonacionBanner.tsx", () => ({ ImpersonacionBanner: () => null }));

const SESSION = { token: "tok", refreshToken: "reftok", email: "root@example.com", fullName: "Root" };

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

async function renderShell(onRequireLogin: () => void = () => {}): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.superadmin.session", JSON.stringify(SESSION));
  const result = renderComponent(
    <MemoryRouter initialEntries={["/superadmin"]}>
      <SuperAdminShell apiBaseUrl="https://api.test" onRequireLogin={onRequireLogin}>
        {() => <div>child</div>}
      </SuperAdminShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
  });
  return result;
}

describe("SuperAdminShell — nav móvil", () => {
  it("agrega MobileHeader y BottomNav con los 4 destinos diarios; Sidebar y DashboardHeader quedan solo para escritorio", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(root.querySelector('aside[aria-label="Navegación principal"]')!.className).toContain("md:flex");
    const headers = [...root.querySelectorAll("header")];
    expect(headers.some((h) => h.className.includes("md:hidden") && h.textContent?.includes("atiende"))).toBe(true);
    const desktop = headers.find((h) => h.textContent?.includes("Consola de Atiende"))!;
    expect(desktop.className).toContain("hidden");
    expect([...root.querySelectorAll('nav[aria-label="Navegación móvil"] a')].map((a) => a.getAttribute("href"))).toEqual([
      "/superadmin",
      "/superadmin/resumen",
      "/superadmin/salud",
      "/superadmin/acciones",
    ]);
  });

  it('"Más" abre los 17 destinos de la consola (incluye gestión de organizaciones, interruptores, seguridad MFA, costos y margen, y planes)', async () => {
    rendered = await renderShell();
    const nav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    click([...nav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!);
    const hrefs = [...document.body.querySelectorAll('[role="dialog"] a')].map((a) => a.getAttribute("href"));
    expect(hrefs).toHaveLength(17);
    expect(hrefs).toContain("/superadmin/gestion-organizaciones");
    expect(hrefs).toContain("/superadmin/interruptores");
    expect(hrefs).toContain("/superadmin/seguridad");
    expect(hrefs).toContain("/superadmin/costos-margen");
    expect(hrefs).toContain("/superadmin/planes");
    expect(hrefs).toContain("/superadmin/break-glass");
    expect(hrefs).toContain("/superadmin/integraciones");
  });

  it("campana y cerrar sesión son alcanzables en móvil, sin Chatea con tus datos (no aplica a plataforma)", async () => {
    const onRequireLogin = vi.fn();
    rendered = await renderShell(onRequireLogin);
    const mobileHeader = [...rendered.container.querySelectorAll("header")].find((h) => h.className.includes("md:hidden"))!;
    expect(mobileHeader.querySelector('button[aria-label^="Notificaciones"]')).not.toBeNull();
    click(mobileHeader.querySelector('button[aria-label="Abrir menú de cuenta"]')!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    expect(hoja.textContent).not.toContain("Chatea con tus datos");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      click([...hoja.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cerrar sesión")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.test/auth/logout");
    expect(window.localStorage.getItem("atiende.superadmin.session")).toBeNull();
    expect(onRequireLogin).toHaveBeenCalled();
  });
});
