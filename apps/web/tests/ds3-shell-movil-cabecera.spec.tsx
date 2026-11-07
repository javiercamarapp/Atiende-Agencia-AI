// @vitest-environment jsdom
//
// ds3 / paridad movil (igual que Rovaq): la cabecera suma (oculto sin la bandera) la campana con contador y un «Más» de 44 que abre la
// hoja con el sidebar completo; el menu de cuenta del diseno actual queda envuelto para ocultarse con ds3. La campana es decision de Omar
// 7-nov-2026 (reemplaza «encabezado movil sin campana», ver test-utils/menu-cuenta-movil.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Bell, CalendarCheck, Users } from "lucide-react";
import { VerticalShell, type SidebarSection } from "@atiende/ui";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SECCIONES: SidebarSection[] = [
  { title: "Resumen", siempreAbierto: true, items: [{ to: "/v/demo", label: "Resumen", icon: CalendarCheck, end: true }] },
  { title: "Clientes", items: [{ to: "/v/demo/clientes", label: "Clientes", icon: Users }] },
];

let rendered: RenderedComponent | undefined;
beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
});

const render = (contador?: number, conCampana = false) =>
  renderComponent(
    <MemoryRouter initialEntries={["/v/demo"]}>
      <VerticalShell
        vertical="demo"
        sections={SECCIONES}
        mobileItems={[{ to: "/v/demo", label: "Resumen", icon: CalendarCheck, end: true }]}
        user={{ email: "a@b.mx" }}
        onLogout={() => {}}
        header={{ icon: <span />, title: "Demo" }}
        sidebarPie={[{ label: "Notificaciones", to: "/v/demo/notificaciones", icon: Bell, indicador: (contador ?? 0) > 0, contador }]}
        notificaciones={conCampana ? { to: "/v/demo/notificaciones", contador, hayNoLeidas: (contador ?? 0) > 0 } : undefined}
      >
        <p>contenido</p>
      </VerticalShell>
    </MemoryRouter>,
  );

const cabecera = () => document.body.querySelector<HTMLElement>('[data-testid="mobile-header"]')!;

describe("ds3 — cabecera movil: campana y «Más»", () => {
  it("con `notificaciones` la campana (solo-ds3) va justo antes de «Más», con el contador real; sin la prop no hay campana", () => {
    rendered = render(3, true);
    const campana = cabecera().querySelector<HTMLAnchorElement>('a[data-testid="movil-campana"]')!;
    expect(campana.hidden).toBe(true);
    expect(campana.getAttribute("aria-label")).toBe("Notificaciones: 3 sin leer");
    expect(campana.nextElementSibling?.classList.contains("ds3-movil-mas")).toBe(true);
    rendered.unmount();
    rendered = render(3);
    expect(cabecera().querySelector('[aria-label^="Notificaciones"]')).toBeNull();
  });

  it("«Más» de la cabecera abre la hoja «Más secciones»; el menu de cuenta sigue (envuelto en ds3-no)", () => {
    rendered = render();
    const mas = cabecera().querySelector<HTMLButtonElement>("button.ds3-movil-mas")!;
    expect(mas.hidden).toBe(true);
    expect(mas.getAttribute("aria-label")).toBe("Abrir más secciones");
    click(mas);
    expect(document.body.querySelector(".ds3-hoja-mas")).not.toBeNull();
    expect(cabecera().querySelector('.ds3-no button[aria-label="Abrir menú de cuenta"]')).not.toBeNull();
  });
});
