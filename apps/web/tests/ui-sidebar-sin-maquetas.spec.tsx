// @vitest-environment jsdom
//
// PR-0 del informe de diseno-ux (F-02, B-01..B-05): el <Sidebar> compartido
// (todas las verticales + superadmin) tenia controles maqueta: "Centro de ayuda"
// sin accion, tres items deshabilitados "Pronto" cuyo tooltip decia "Atiende
// Hoteles" y un enlace fijo a /configuracion sin ruta. Estos tests afirman el
// comportamiento (no snapshots): cada control visible tiene un destino o
// accion real y el grupo guardado de otra vertical no deja el menu cerrado.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LayoutDashboard, Wrench } from "lucide-react";
import { Sidebar, type SidebarSection } from "@atiende/ui";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SECCIONES: SidebarSection[] = [
  { title: "Panel", siempreAbierto: true, items: [{ to: "/x/demo", label: "Dashboard", icon: LayoutDashboard }] },
  { title: "Operación", items: [{ to: "/x/demo/mant", label: "Mantenimiento", icon: Wrench }] },
  { title: "Admin", items: [{ to: "/x/demo/pl", label: "P&L", icon: Wrench }] },
];

let rendered: RenderedComponent | undefined;
let storage: Storage;

beforeEach(() => {
  installMatchMediaStub();
  storage = installMemoryLocalStorage();
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function renderSidebar(props: Partial<React.ComponentProps<typeof Sidebar>> = {}, ruta = "/x/demo"): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <Sidebar sections={SECCIONES} user={{ email: "a@b.com", rol: "owner" }} onLogout={() => {}} {...props} />
    </MemoryRouter>,
  );
}

describe("Sidebar compartido — sin controles maqueta", () => {
  it("no dibuja Centro de ayuda, Notificaciones, Mi perfil ni Plan y facturación", () => {
    rendered = renderSidebar();
    const texto = rendered.container.textContent ?? "";
    for (const maqueta of ["Centro de ayuda", "Notificaciones", "Mi perfil", "Plan y facturación", "Pronto", "Atiende Hoteles"]) {
      expect(texto).not.toContain(maqueta);
    }
  });

  it("ningún botón del Sidebar queda deshabilitado de forma fija", () => {
    rendered = renderSidebar();
    const deshabilitados = [...rendered.container.querySelectorAll("button, a")].filter(
      (el) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
    );
    expect(deshabilitados).toHaveLength(0);
  });

  it("sin configuracionTo no hay enlace a una ruta inexistente; con configuracionTo apunta a esa ruta real", () => {
    rendered = renderSidebar();
    expect(rendered.container.querySelector('a[href="/configuracion"]')).toBeNull();
    expect([...rendered.container.querySelectorAll("a")].some((a) => a.textContent === "Configuración")).toBe(false);
    rendered.unmount();

    rendered = renderSidebar({ configuracionTo: "/citas/demo/configuracion" });
    const link = [...rendered.container.querySelectorAll("a")].find((a) => a.textContent === "Configuración");
    expect(link?.getAttribute("href")).toBe("/citas/demo/configuracion");
  });

  it("el botón de cerrar sesión dispara onLogout", () => {
    const onLogout = vi.fn();
    rendered = renderSidebar({ onLogout });
    click(rendered.container.querySelector('button[aria-label="Cerrar sesión"]')!);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

describe("Sidebar compartido — grupo abierto guardado", () => {
  it("un grupo guardado que no existe en esta vertical no deja todos los acordeones cerrados", () => {
    storage.setItem("atiende-hoteles-sidebar-grupo-abierto", "Grupo-de-otra-vertical");
    rendered = renderSidebar({}, "/x/demo/mant");
    const abiertos = [...rendered.container.querySelectorAll("button[aria-expanded]")].filter((b) => b.getAttribute("aria-expanded") === "true");
    expect(abiertos).toHaveLength(1);
    expect(rendered.container.textContent).toContain("Mantenimiento");
  });

  it("un grupo guardado que sí existe se respeta", () => {
    storage.setItem("atiende-hoteles-sidebar-grupo-abierto", "Admin");
    rendered = renderSidebar({}, "/x/demo");
    expect(rendered.container.textContent).toContain("P&L");
    expect(rendered.container.textContent).not.toContain("Mantenimiento");
  });
});
