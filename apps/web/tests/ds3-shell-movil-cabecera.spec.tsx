// @vitest-environment jsdom
//
// ds3 / paridad movil: la cabecera suma (oculto sin la bandera) un «Más» de 44 que abre la hoja con el sidebar completo (sin campana:
// regla vigente del dueno, ver test-utils/menu-cuenta-movil.ts); el menu de cuenta del diseno actual queda envuelto para ocultarse con ds3. Solo AÑADE.
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

const render = (contador?: number) =>
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
      >
        <p>contenido</p>
      </VerticalShell>
    </MemoryRouter>,
  );

const cabecera = () => document.body.querySelector<HTMLElement>('[data-testid="mobile-header"]')!;

describe("ds3 — cabecera movil: campana y «Más»", () => {
  it("sin campana en la cabecera (regla vigente: las notificaciones con su contador viven en «Más»)", () => {
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
