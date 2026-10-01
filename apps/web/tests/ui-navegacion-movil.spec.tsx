// @vitest-environment jsdom
//
// F-01 del informe de diseno-ux: hoteles y despachos no tenian navegacion movil
// y el logout/campana/chat no eran alcanzables en movil. Componentes compartidos
// nuevos: BottomNav con "Más" (todas las secciones) y MobileAccountMenu
// (cuenta + tema + cerrar sesion), compuestos por MobileHeaderActions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BedDouble, LayoutDashboard, Wrench, Users, Receipt, Settings } from "lucide-react";
import { BOTTOM_NAV_MAX_DESTINOS, BottomNav, MobileAccountMenu, MobileHeader, type SidebarSection } from "@atiende/ui";
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

describe("BottomNav: la barra del panel del chofer de Likida (UNI-1)", () => {
  const ITEMS = [
    { to: "/h/demo", label: "Resumen", icon: LayoutDashboard, end: true },
    { to: "/h/demo/reservas", label: "Reservas", icon: BedDouble },
    { to: "/h/demo/clientes", label: "Clientes", icon: Users },
    { to: "/h/demo/cobros", label: "Cobros", icon: Receipt },
    { to: "/h/demo/ajustes", label: "Ajustes", icon: Settings },
  ];
  const TODAS: SidebarSection[] = [
    { title: "Panel", siempreAbierto: true, items: [ITEMS[0]!] },
    { title: "Operación", items: [ITEMS[1]!, ITEMS[2]!, { to: "/h/demo/mantenimiento", label: "Mantenimiento", icon: Wrench }] },
    { title: "Admin", items: [ITEMS[3]!, ITEMS[4]!] },
  ];
  function render(ruta: string, extra: Partial<React.ComponentProps<typeof BottomNav>> = {}) {
    rendered = renderComponent(
      <MemoryRouter initialEntries={[ruta]}>
        <BottomNav items={ITEMS} moreSections={TODAS} {...extra} />
      </MemoryRouter>,
    );
    return rendered.container.querySelector("nav")!;
  }

  it("medidas literales de Likida: md:hidden, fija abajo, z-40, borde superior, safe-area, lista flex", () => {
    const nav = render("/h/demo");
    for (const c of ["md:hidden", "fixed", "bottom-0", "z-40", "border-t", "bg-card", "safe-area-bottom", "pr-[env(safe-area-inset-right)]", "pl-[env(safe-area-inset-left)]"]) {
      expect(nav.className, c).toContain(c);
    }
    expect(nav.querySelector("ul")!.className).toBe("flex");
    const destino = nav.querySelector("a")!;
    for (const c of ["min-h-14", "flex-col", "gap-1", "py-2.5"]) expect(destino.className, c).toContain(c);
    expect(destino.querySelector("svg")!.getAttribute("class")).toContain("size-[22px]");
    expect(destino.querySelector("span")!.className).toContain("text-xs");
  });

  it("nunca más de 4 destinos curados más 'Más' (5 lugares), aunque el shell pase más", () => {
    const nav = render("/h/demo");
    expect(BOTTOM_NAV_MAX_DESTINOS).toBe(4);
    expect([...nav.querySelectorAll("a span")].map((s) => s.textContent)).toEqual(["Resumen", "Reservas", "Clientes", "Cobros"]);
    expect(nav.querySelectorAll("li")).toHaveLength(5);
  });

  it("activo = aria-current + negrita + trazo 2.25; inactivo = font-medium y trazo 1.75 (nunca color solo)", () => {
    const nav = render("/h/demo/reservas");
    const activo = nav.querySelector('a[aria-current="page"]')!;
    expect(activo.textContent).toBe("Reservas");
    expect(activo.querySelector("span")!.className).toContain("font-semibold");
    expect(activo.querySelector("svg")!.getAttribute("stroke-width")).toBe("2.25");
    const inactivo = [...nav.querySelectorAll("a")].find((a) => a.textContent === "Resumen")!;
    expect(inactivo.getAttribute("aria-current")).toBeNull();
    expect(inactivo.querySelector("span")!.className).toContain("font-medium");
    expect(inactivo.querySelector("svg")!.getAttribute("stroke-width")).toBe("1.75");
  });

  it("la raíz (end) solo es activa con coincidencia exacta", () => {
    const nav = render("/h/demo/reservas/42");
    expect([...nav.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent)).toEqual(["Reservas"]);
  });

  it("'Más' queda activo (negrita) solo cuando la ruta está en una sección pero no en un destino de la barra", () => {
    const enMas = render("/h/demo/mantenimiento");
    const botonMas = [...enMas.querySelectorAll("button")].find((b) => b.textContent === "Más")!;
    expect(botonMas.querySelector("span")!.className).toContain("font-semibold");
    rendered?.unmount();
    const enBarra = render("/h/demo/reservas");
    expect([...enBarra.querySelectorAll("button")].find((b) => b.textContent === "Más")!.querySelector("span")!.className).toContain("font-medium");
  });

  it("la hoja 'Más' usa el material de Likida: 80dvh, rounded-t-2xl, safe-area, filas de 44 px, activa con bg-primary", () => {
    render("/h/demo/mantenimiento");
    click(botonPorTexto("Más", rendered!.container)!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    for (const c of ["max-h-[80dvh]", "rounded-t-2xl", "bg-card", "pb-[calc(2rem+var(--safe-area-bottom))]"]) expect(hoja.className, c).toContain(c);
    const fila = hoja.querySelector("a")!;
    for (const c of ["min-h-11", "gap-2.5", "rounded-lg", "px-2.5", "text-ui"]) expect(fila.className, c).toContain(c);
    const activa = hoja.querySelector('a[aria-current="page"]')!;
    expect(activa.textContent).toBe("Mantenimiento");
    expect(activa.className).toContain("bg-primary");
    // Titulo de categoria = el de Atiende (mono, 10 px).
    expect([...hoja.querySelectorAll("p")].find((p) => p.textContent === "Operación")!.className).toContain("font-mono");
  });

  it("la hoja 'Más' no pinta titulo para la seccion raiz (siempreAbierto), solo para las categorias", () => {
    render("/h/demo");
    click(botonPorTexto("Más", rendered!.container)!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    const titulos = [...hoja.querySelectorAll("p.font-mono")].map((p) => p.textContent);
    expect(titulos).not.toContain("Panel");
    expect(titulos).toContain("Operación");
    // El destino de la raiz sigue alcanzable en la hoja.
    expect([...hoja.querySelectorAll("a")].map((a) => a.textContent)).toContain("Resumen");
  });

  it("el cierre de la hoja mide 44 px (size-11) y cierra", () => {
    render("/h/demo");
    click(botonPorTexto("Más", rendered!.container)!);
    const cerrar = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.includes("Cerrar"))!;
    expect(cerrar.className).toContain("size-11");
    click(cerrar);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("las píldoras del pie van en la sección 'Cuenta' de la hoja (to, href y onClick reales); sin destino no se pintan", () => {
    const onClick = vi.fn();
    render("/h/demo", { pie: [{ label: "Costos de IA", to: "/h/demo/costos" }, { label: "Otro panel", href: "https://example.com/p" }, { label: "Preguntar", onClick }, { label: "Maqueta" }] });
    click(botonPorTexto("Más", rendered!.container)!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    expect(hoja.textContent).toContain("Cuenta");
    expect(hoja.querySelector('a[href="/h/demo/costos"]')).not.toBeNull();
    expect(hoja.querySelector('a[href="https://example.com/p"]')).not.toBeNull();
    expect(hoja.textContent).not.toContain("Maqueta");
    click(botonPorTexto("Preguntar", hoja)!);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("MobileHeader", () => {
  it("fija arriba, z-40, md:hidden, con safe-area; con `pagina` suma la fila con el nombre y, sin <h1>, hace de nivel 1", () => {
    rendered = renderComponent(<MobileHeader title={<span>logo</span>} pagina={{ icon: <i />, title: "Reservas", comoH1: true }} />);
    const marco = rendered.container.querySelector('[data-testid="mobile-header"]')!;
    for (const c of ["md:hidden", "fixed", "top-0", "z-40", "safe-area-top"]) expect(marco.className, c).toContain(c);
    const header = marco.querySelector("header")!;
    for (const c of ["md:hidden", "min-h-14", "border-b", "px-4"]) expect(header.className, c).toContain(c);
    const t = marco.querySelector('[data-testid="mobile-pagina-titulo"]')!;
    expect(t.textContent).toBe("Reservas");
    expect(t.getAttribute("role")).toBe("heading");
    rendered.rerender(<MobileHeader title={<span>logo</span>} />);
    expect(rendered.container.querySelector('[data-testid="mobile-pagina-titulo"]')).toBeNull();
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
