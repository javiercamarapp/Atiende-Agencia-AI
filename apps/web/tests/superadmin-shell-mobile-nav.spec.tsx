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
import { PIE_SUPERADMIN, SECCIONES, TODAS_LAS_RUTAS } from "../src/superadmin/rutas.ts";
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
      "/superadmin/organizaciones",
      "/superadmin/salud",
      "/superadmin/acciones",
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

  it("el Sidebar sigue el mapa de rutas: Resumen raíz, categorías en el orden de Likida con acordeón exclusivo, pie y tarjeta de usuario", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const titulos = SECCIONES.map((s) => s.title);
    expect(categoriasSidebar(root)).toEqual(titulos);
    expect(categoriasAbiertas(root)).toHaveLength(1);
    for (const sec of SECCIONES) {
      if (!categoriasAbiertas(root).includes(sec.title)) abrirCategoria(root, sec.title);
      expect(categoriasAbiertas(root)).toEqual([sec.title]);
      expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", ...sec.items.map((i) => i.label)]);
    }
    const pie = [...root.querySelectorAll<HTMLAnchorElement>('aside[aria-label="Navegación principal"] > div a')].map((a) => [a.getAttribute("aria-label"), a.getAttribute("href")]);
    expect(pie).toEqual(PIE_SUPERADMIN.map((p) => [p.label, p.to]));
    expect(tarjetaUsuario(root)).toEqual({ nombre: "Root", rol: "Superadmin" });
  });

  it('"Más" abre TODOS los destinos del mapa de rutas (SA-L-01) más las 2 píldoras del pie: sin entradas fantasma', async () => {
    rendered = await renderShell();
    const nav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    click([...nav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!);
    const hrefs = [...document.body.querySelectorAll('[role="dialog"] a')].map((a) => a.getAttribute("href"));
    expect(hrefs).toHaveLength(TODAS_LAS_RUTAS.length + PIE_SUPERADMIN.length);
    expect(new Set(hrefs)).toEqual(new Set([...TODAS_LAS_RUTAS.map((r) => r.to), ...PIE_SUPERADMIN.map((p) => p.to)]));
    expect(hrefs).toContain("/superadmin/organizaciones");
    expect(hrefs).toContain("/superadmin/privacidad");
    // SA-L-20: la gestion es la pestana "Gestion" de Organizaciones; su ruta vieja redirige y ya no es una entrada del menu.
    expect(hrefs).not.toContain("/superadmin/gestion-organizaciones");
    expect(hrefs).toContain("/superadmin/interruptores");
    expect(hrefs).toContain("/superadmin/seguridad");
    expect(hrefs).toContain("/superadmin/zona-cfo");
    expect(hrefs).toContain("/superadmin/ejecutivo");
    expect(hrefs).toContain("/superadmin/costos-facturacion");
    expect(hrefs).toContain("/superadmin/consumo-ia");
    expect(hrefs).toContain("/superadmin/planes");
    expect(hrefs).toContain("/superadmin/break-glass");
    expect(hrefs).toContain("/superadmin/integraciones");
  });

  it("en la hoja de cuenta, 'Chatea con tus datos' cierra la hoja y deja el Copiloto a la vista (CHAT-17)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })));
    rendered = await renderShell();
    const mobileHeader = [...rendered.container.querySelectorAll("header")].find((h) => h.className.includes("md:hidden"))!;
    click(mobileHeader.querySelector('button[aria-label="Abrir menú de cuenta"]')!);
    const boton = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.includes("Chatea con tus datos"))!;
    await act(async () => {
      click(boton);
      await flushMicrotasks();
    });
    expect(document.getElementById("copiloto-panel")?.getAttribute("data-abierto")).toBe("true");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("campana y cerrar sesión son alcanzables en móvil, y 'Chatea con tus datos' abre el Copiloto (CHAT-17)", async () => {
    const onRequireLogin = vi.fn();
    rendered = await renderShell(onRequireLogin);
    const mobileHeader = [...rendered.container.querySelectorAll("header")].find((h) => h.className.includes("md:hidden"))!;
    expect(mobileHeader.querySelector('a[aria-label^="Notificaciones"]')).not.toBeNull();
    click(mobileHeader.querySelector('button[aria-label="Abrir menú de cuenta"]')!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    expect(hoja.textContent).toContain("Chatea con tus datos");
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
