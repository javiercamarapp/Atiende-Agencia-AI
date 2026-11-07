// @vitest-environment jsdom
//
// ds3 / lote 5 (marco del shell): el <VerticalShell> marca sus piezas con las clases `ds3-*` que la hoja `@atiende/ui/ds3-shell.css`
// estiliza SOLO bajo html[data-diseno="ds3"]. Con la bandera apagada no cambia nada: mismo arbol, mismos landmarks, ninguna clase
// de layout del diseno actual retirada. Solo AÑADE: no toca ningun spec existente.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CalendarCheck, Settings } from "lucide-react";
import { VerticalShell, VERTICAL_SHELL_MAIN_ID, type SidebarSection } from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SECCIONES: SidebarSection[] = [
  { title: "Agenda", siempreAbierto: true, items: [{ to: "/v/demo/agenda", label: "Agenda", icon: CalendarCheck }] },
  { title: "Administrar", items: [{ to: "/v/demo/configuracion", label: "Configuración", icon: Settings }] },
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

function renderShell(): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={["/v/demo/agenda"]}>
      <VerticalShell
        vertical="demo"
        sections={SECCIONES}
        mobileItems={[{ to: "/v/demo/agenda", label: "Agenda", icon: CalendarCheck }]}
        user={{ email: "staff@example.com", rol: "owner" }}
        onLogout={() => {}}
        header={{ icon: <span />, title: "Demo · acme" }}
      >
        <p>contenido</p>
      </VerticalShell>
    </MemoryRouter>,
  );
}

describe("ds3 — marco del shell", () => {
  it("el lienzo, la columna del sidebar, el marco, el contenido y la pagina llevan su clase ds3", () => {
    rendered = renderShell();
    const raiz = rendered.container.querySelector("[data-vertical='demo']")!;
    expect(raiz.classList.contains("ds3-shell")).toBe(true);
    expect(rendered.container.querySelector(".ds3-shell-lateral aside.ds3-sidebar")).not.toBeNull();
    const marco = rendered.container.querySelector(".ds3-shell-marco")!;
    const main = marco.querySelector("main.ds3-shell-contenido")!;
    expect(main.id).toBe(VERTICAL_SHELL_MAIN_ID);
    expect(main.querySelector(".ds3-shell-pagina")?.textContent).toBe("contenido");
  });

  it("sin la bandera conserva las clases de layout del diseno actual (las ds3 se suman, no reemplazan)", () => {
    rendered = renderShell();
    const raiz = rendered.container.querySelector(".ds3-shell")!;
    expect(raiz.className).toContain("min-h-[100dvh] bg-background flex w-full");
    expect(rendered.container.querySelector(".ds3-shell-lateral")!.className).toContain("hidden md:block md:p-4 md:pr-0");
    const marco = rendered.container.querySelector(".ds3-shell-marco")!;
    expect(marco.className).toContain("bg-sunken");
    expect(marco.className).toContain("md:rounded-2xl");
    expect(rendered.container.querySelector("main")!.className).toContain("md:px-5 md:pt-3.5 md:pb-5");
    expect(document.documentElement.dataset.diseno).toBeUndefined();
  });
});
