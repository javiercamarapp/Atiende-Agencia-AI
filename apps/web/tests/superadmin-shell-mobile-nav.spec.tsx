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
import { abrirCategoria, categoriasAbiertas, categoriasSidebar, linksSidebar, tarjetaUsuario } from "./test-utils/sidebar-estructura.ts";

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

async function renderShell(onRequireLogin: () => void = () => {}, ruta = "/superadmin"): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.superadmin.session", JSON.stringify(SESSION));
  const result = renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
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
  it("agrega MobileHeader y BottomNav con los 4 destinos diarios; Sidebar y BarraPagina quedan solo para escritorio", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(root.querySelector('aside[aria-label="Navegación principal"]')!.className).toContain("md:flex");
    const headers = [...root.querySelectorAll("header")];
    expect(headers.some((h) => h.className.includes("md:hidden") && h.textContent?.includes("atiende"))).toBe(true);
    // La cabecera de escritorio vive dentro de un contenedor `hidden md:block` (VerticalShell).
    const desktop = headers.find((h) => h.textContent?.includes("Consola de Atiende"))!;
    expect(desktop.closest(".hidden")?.className).toContain("md:block");
    expect([...root.querySelectorAll('nav[aria-label="Navegación móvil"] a')].map((a) => a.getAttribute("href"))).toEqual([
      "/superadmin",
      "/superadmin/salud",
      "/superadmin/acciones",
      "/superadmin/prospectos",
    ]);
  });

  it("el item raíz «Resumen» solo queda activo en /superadmin (no en cada pantalla hija)", async () => {
    rendered = await renderShell(() => {}, "/superadmin/planes");
    const activos = [...rendered.container.querySelectorAll('aside a[aria-current="page"]')].map((a) => a.getAttribute("href"));
    expect(activos).toEqual(["/superadmin/planes"]);
  });

  it("un solo <main> con skip link (VerticalShell) y el contenido de la página dentro de él", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const mains = root.querySelectorAll("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]!.id).toBe("contenido-principal");
    expect(mains[0]!.textContent).toContain("child");
    expect(root.querySelector('a[href="#contenido-principal"]')).not.toBeNull();
  });

  // UNI-6: el menu de hoy con el marco de Likida -- Resumen raiz sin titulo, categorias en el orden de Likida, acordeon
  // exclusivo, pie con "Costos de IA" y "Ver los otros paneles" (sale de las secciones) y tarjeta de usuario.
  it("el Sidebar agrupa los 21 destinos en el orden de Likida, con acordeon exclusivo y el pie de la consola", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(categoriasSidebar(root)).toEqual(["Agentes", "Negocio", "Plataforma", "Control", "Sistema"]);
    expect(categoriasAbiertas(root)).toEqual(["Agentes"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Gasto de API de LLM"]);
    abrirCategoria(root, "Negocio");
    expect(categoriasAbiertas(root)).toEqual(["Negocio"]);
    expect(linksSidebar(root)).toEqual([
      "Resumen",
      "Gestión de organizaciones",
      "Prospectos",
      "Planes y precios",
      "Contratos por cliente",
      "Facturación",
      "Dashboard CFO",
      "P&L por vertical",
      "Costos y margen",
      "Zona CFO segura",
    ]);
    abrirCategoria(root, "Plataforma");
    expect(linksSidebar(root)).toEqual(["Resumen", "Integraciones", "Interruptores", "Acciones"]);
    abrirCategoria(root, "Control");
    expect(linksSidebar(root)).toEqual(["Resumen", "Seguridad (MFA)", "Privacidad", "Romper cristal", "Impersonación", "Auditoría de denegaciones"]);
    abrirCategoria(root, "Sistema");
    expect(linksSidebar(root)).toEqual(["Resumen", "Salud operativa", "Resumen diario"]);
    // Pie: pildoras con destino real, fuera del <nav> de las categorias.
    const pie = [...root.querySelectorAll<HTMLAnchorElement>("aside > div a")].map((a) => [a.getAttribute("aria-label"), a.getAttribute("href")]);
    expect(pie).toEqual([
      ["Costos de IA", "/superadmin/costos-margen"],
      ["Ver los otros paneles", "/superadmin/paneles"],
    ]);
    expect(tarjetaUsuario(root)).toEqual({ nombre: "Root", rol: "Superadmin" });
  });

  it('"Más" abre los 22 destinos de la consola (incluye privacidad, gestión de organizaciones, interruptores, seguridad MFA, zona CFO segura, dashboard CFO, costos y margen, planes y contratos por cliente)', async () => {
    rendered = await renderShell();
    const nav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    click([...nav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!);
    const hrefs = [...document.body.querySelectorAll('[role="dialog"] a')].map((a) => a.getAttribute("href"));
    // 21 de las categorias + "Ver los otros paneles" (pie, seccion "Cuenta"); "Costos de IA" repite /costos-margen.
    expect(new Set(hrefs).size).toBe(22);
    expect(hrefs).toContain("/superadmin/paneles");
    expect(hrefs).toContain("/superadmin/privacidad");
    expect(hrefs).toContain("/superadmin/gestion-organizaciones");
    expect(hrefs).toContain("/superadmin/interruptores");
    expect(hrefs).toContain("/superadmin/seguridad");
    expect(hrefs).toContain("/superadmin/zona-cfo");
    expect(hrefs).toContain("/superadmin/cfo");
    expect(hrefs).toContain("/superadmin/pyl");
    expect(hrefs).toContain("/superadmin/costos-margen");
    expect(hrefs).toContain("/superadmin/planes");
    expect(hrefs).toContain("/superadmin/contratos");
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
