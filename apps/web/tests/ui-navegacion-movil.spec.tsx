// @vitest-environment jsdom
//
// F-01 del informe de diseno-ux: hoteles y despachos no tenian navegacion movil
// y el logout/campana/chat no eran alcanzables en movil. Componentes compartidos
// nuevos: BottomNav con "Más" (todas las secciones) y MobileAccountMenu
// (cuenta + tema + cerrar sesion), compuestos por MobileHeaderActions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BedDouble, LayoutDashboard, Wrench } from "lucide-react";
import { BottomNav, MobileAccountMenu, type SidebarSection } from "@atiende/ui";
import { MobileHeaderActions } from "../src/components/MobileHeaderActions.tsx";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SECCIONES: SidebarSection[] = [
  { title: "Panel", siempreAbierto: true, items: [{ to: "/h/demo", label: "Dashboard", icon: LayoutDashboard }] },
  {
    title: "Operación",
    items: [
      { to: "/h/demo/reservas", label: "Reservas", icon: BedDouble },
      { to: "/h/demo/mantenimiento", label: "Mantenimiento", icon: Wrench },
    ],
  },
];

let rendered: RenderedComponent | undefined;

beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

const botonPorTexto = (texto: string, raiz: ParentNode = document.body) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;

describe("BottomNav con Más", () => {
  function render(moreSections?: SidebarSection[]) {
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/h/demo"]}>
        <BottomNav items={[{ to: "/h/demo", label: "Inicio", icon: LayoutDashboard }]} moreSections={moreSections} />
      </MemoryRouter>,
    );
  }

  it("sin moreSections no hay botón Más (comportamiento previo intacto)", () => {
    render();
    expect(botonPorTexto("Más", rendered!.container)).toBeUndefined();
  });

  it("con moreSections el botón Más abre una hoja con TODOS los destinos como enlaces reales", () => {
    render(SECCIONES);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    click(botonPorTexto("Más", rendered!.container)!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    const enlaces = [...hoja.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(enlaces).toEqual([
      ["Dashboard", "/h/demo"],
      ["Reservas", "/h/demo/reservas"],
      ["Mantenimiento", "/h/demo/mantenimiento"],
    ]);
  });

  it("elegir un destino de la hoja la cierra", () => {
    render(SECCIONES);
    click(botonPorTexto("Más", rendered!.container)!);
    click([...document.body.querySelectorAll('[role="dialog"] a')].find((a) => a.textContent === "Reservas")!);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("MobileAccountMenu", () => {
  it("abre la hoja de cuenta, muestra el usuario y cerrar sesión dispara onLogout", () => {
    const onLogout = vi.fn();
    rendered = renderComponent(<MobileAccountMenu user={{ email: "gm@example.com", rol: "owner" }} onLogout={onLogout} />);
    click(rendered.container.querySelector('button[aria-label="Abrir menú de cuenta"]')!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    expect(hoja.textContent).toContain("gm@example.com");
    click(botonPorTexto("Cerrar sesión", hoja)!);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("mientras cierra sesión el botón queda deshabilitado", () => {
    rendered = renderComponent(<MobileAccountMenu user={null} onLogout={() => {}} loggingOut />);
    click(rendered.container.querySelector('button[aria-label="Abrir menú de cuenta"]')!);
    expect(botonPorTexto("Saliendo…")!.disabled).toBe(true);
  });
});

describe("MobileHeaderActions", () => {
  const notif = { items: [], unreadCount: 3, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} };

  it("expone campana con contador, chat (marcado Pronto) y cerrar sesión", () => {
    const onLogout = vi.fn();
    rendered = renderComponent(<MobileHeaderActions notif={notif} user={{ email: "a@b.com", rol: "admin" }} onLogout={onLogout} />);
    expect(rendered.container.querySelector('button[aria-label="Notificaciones: 3 sin leer"]')).not.toBeNull();
    click(rendered.container.querySelector('button[aria-label="Abrir menú de cuenta"]')!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    expect(hoja.textContent).toContain("Chatea con tus datos");
    click(botonPorTexto("Cerrar sesión", hoja)!);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("conChat=false (superadmin) no muestra Chatea con tus datos", () => {
    rendered = renderComponent(<MobileHeaderActions notif={notif} user={null} onLogout={() => {}} conChat={false} />);
    click(rendered.container.querySelector('button[aria-label="Abrir menú de cuenta"]')!);
    expect(document.body.querySelector('[role="dialog"]')!.textContent).not.toContain("Chatea con tus datos");
  });
});
