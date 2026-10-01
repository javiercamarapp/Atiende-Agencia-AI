// @vitest-environment jsdom
//
// PR-4 del plan de diseno-ux (4.6 punto 4): el grupo abierto y el colapso del
// <Sidebar> se recuerdan POR VERTICAL (`atiende:<vertical>:sidebar:*`). Antes
// todas las verticales compartian dos claves de localStorage. Sin `storageScope`
// se conservan las claves heredadas (las verticales sin migrar no cambian).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

function renderSidebar(storageScope?: string): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={["/x/demo"]}>
      <Sidebar sections={SECCIONES} user={{ email: "a@b.com", rol: "owner" }} onLogout={() => {}} storageScope={storageScope} />
    </MemoryRouter>,
  );
}

function botonGrupo(titulo: string): HTMLButtonElement {
  return [...rendered!.container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) => b.textContent?.includes(titulo))!;
}

describe("Sidebar — preferencias por vertical", () => {
  it("con storageScope guarda el grupo abierto en la clave de SU vertical y no toca la compartida", () => {
    rendered = renderSidebar("citas");
    click(botonGrupo("Admin"));
    expect(storage.getItem("atiende:citas:sidebar:grupo")).toBe("Admin");
    expect(storage.getItem("atiende-hoteles-sidebar-grupo-abierto")).toBeNull();
  });

  it("el grupo guardado por una vertical no afecta a otra", () => {
    storage.setItem("atiende:hoteles:sidebar:grupo", "Admin");
    rendered = renderSidebar("citas");
    expect(botonGrupo("Admin").getAttribute("aria-expanded")).toBe("false");
    expect(botonGrupo("Operación").getAttribute("aria-expanded")).toBe("true");
  });

  it("restaura el grupo guardado de la propia vertical y valida que exista", () => {
    storage.setItem("atiende:citas:sidebar:grupo", "Admin");
    rendered = renderSidebar("citas");
    expect(botonGrupo("Admin").getAttribute("aria-expanded")).toBe("true");
    rendered.unmount();
    storage.setItem("atiende:citas:sidebar:grupo", "Grupo-que-ya-no-existe");
    rendered = renderSidebar("citas");
    expect(botonGrupo("Operación").getAttribute("aria-expanded")).toBe("true");
  });

  it("el colapso también es por vertical", () => {
    rendered = renderSidebar("citas");
    click(rendered.container.querySelector('button[aria-label="Colapsar barra lateral"]')!);
    expect(storage.getItem("atiende:citas:sidebar:colapsado")).toBe("1");
    expect(storage.getItem("atiende-hoteles-sidebar-colapsado")).toBeNull();
    rendered.unmount();
    rendered = renderSidebar("hoteles");
    expect(rendered.container.querySelector('button[aria-label="Colapsar barra lateral"]')).not.toBeNull();
  });

  it("sin storageScope conserva las claves compartidas heredadas", () => {
    rendered = renderSidebar();
    click(botonGrupo("Admin"));
    expect(storage.getItem("atiende-hoteles-sidebar-grupo-abierto")).toBe("Admin");
  });
});
