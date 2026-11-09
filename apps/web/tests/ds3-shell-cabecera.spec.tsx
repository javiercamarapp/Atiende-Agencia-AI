// @vitest-environment jsdom
//
// ds3 / lote 5.1 (encabezado, PageHeader y barra de alcance). El boton «Guía» existe OCULTO sin la bandera y FUERA de la barra
// del diseno actual (que sigue sin botones propios); anuncia GUIA_ABRIR_EVENTO o llama a `onGuia` (enganche del recorrido, otro carril).
// PageHeader suma eyebrow y la guia «¿Cómo leer esto?» solo cuando se pasan. Solo AÑADE: no toca ningun spec existente.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CalendarCheck } from "lucide-react";
import { BarraAlcance, BarraAlcanceEspaciador, BotonFiltros, ChipFiltro, GUIA_ABRIR_EVENTO, PageHeader, VerticalShell } from "@atiende/ui";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

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

function renderShell(onGuia?: () => void): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={["/v/demo/agenda"]}>
      <VerticalShell
        vertical="demo"
        sections={[{ title: "Agenda", siempreAbierto: true, items: [{ to: "/v/demo/agenda", label: "Agenda", icon: CalendarCheck }] }]}
        mobileItems={[]}
        user={{ email: "a@b.mx" }}
        onLogout={() => {}}
        header={{ icon: <span />, title: "Demo" }}
        onGuia={onGuia}
      >
        <p>contenido</p>
      </VerticalShell>
    </MemoryRouter>,
  );
}

const q = (sel: string) => rendered!.container.querySelector<HTMLElement>(sel);

describe("ds3 — encabezado: boton «Guía»", () => {
  it("vive oculto en la zona del encabezado, fuera de la barra del diseno actual", () => {
    rendered = renderShell();
    const guia = q('[data-testid="barra-guia"]')!;
    expect(guia.hidden).toBe(true);
    expect(guia.textContent).toBe("Guía");
    expect(guia.closest(".ds3-cabecera-zona")).not.toBeNull();
    expect(q('[data-testid="barra-pagina"]')!.querySelector("a, button")).toBeNull();
    expect(q('[data-testid="barra-pagina"]')!.classList.contains("ds3-cabecera")).toBe(true);
    expect(q(".ds3-cabecera-titulo [data-testid='barra-pagina-titulo']")!.textContent).toBe("Agenda");
  });

  it("sin onGuia anuncia GUIA_ABRIR_EVENTO con la ruta; con onGuia la llama", () => {
    rendered = renderShell();
    const rutas: string[] = [];
    const oyente = (e: Event) => rutas.push((e as CustomEvent<{ ruta: string }>).detail.ruta);
    window.addEventListener(GUIA_ABRIR_EVENTO, oyente);
    click(q('[data-testid="barra-guia"]')!);
    window.removeEventListener(GUIA_ABRIR_EVENTO, oyente);
    expect(rutas).toEqual(["/v/demo/agenda"]);
    rendered.unmount();
    const onGuia = vi.fn();
    rendered = renderShell(onGuia);
    click(q('[data-testid="barra-guia"]')!);
    expect(onGuia).toHaveBeenCalledTimes(1);
  });

  // Auditoria R2 #3: en 390 no habia forma de abrir la Guía (el boton solo vivia en la barra de escritorio).
  it("en la cabecera movil hay un «Guía» de 44 que hace lo mismo", () => {
    rendered = renderShell();
    const guia = q('[data-testid="movil-guia"]')!;
    expect(guia.hidden).toBe(true);
    expect(guia.classList.contains("ds3-solo")).toBe(true);
    expect(guia.getAttribute("aria-label")).toBe("Guía");
    expect(guia.closest('[data-testid="mobile-header"]')).not.toBeNull();
    const rutas: string[] = [];
    const oyente = (e: Event) => rutas.push((e as CustomEvent<{ ruta: string }>).detail.ruta);
    window.addEventListener(GUIA_ABRIR_EVENTO, oyente);
    click(guia);
    window.removeEventListener(GUIA_ABRIR_EVENTO, oyente);
    expect(rutas).toEqual(["/v/demo/agenda"]);
  });
});

describe("ds3 — PageHeader", () => {
  it("sin eyebrow ni guia el arbol es el de siempre (un h1, descripcion y acciones)", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <PageHeader titulo="Reservas" descripcion="Todas las reservas" acciones={<button type="button">Nueva</button>} />
      </MemoryRouter>,
    );
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(q(".ds3-encabezado-eyebrow")).toBeNull();
    expect(q(".ds3-encabezado-guia")).toBeNull();
    expect(q(".ds3-encabezado-descripcion")!.textContent).toBe("Todas las reservas");
    expect(q(".ds3-encabezado-acciones button")!.textContent).toBe("Nueva");
  });

  it("con eyebrow lo pinta sobre el h1; con guia, «¿Cómo leer esto?» abre un popover de 340 con las viñetas", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <PageHeader eyebrow="Ficha del cliente" titulo="Ana" descripcion="Historial" guia={["Las cifras son del mes en curso.", "Estimado = sin ticket."]} />
      </MemoryRouter>,
    );
    const eyebrow = q(".ds3-encabezado-eyebrow")!;
    expect(eyebrow.textContent).toBe("Ficha del cliente");
    expect(eyebrow.compareDocumentPosition(q("h1")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const boton = q(".ds3-encabezado-guia")!;
    expect(boton.textContent).toBe("¿Cómo leer esto?");
    act(() => {
      boton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    click(boton);
    const panel = document.body.querySelector<HTMLElement>(".ds3-popover-guia");
    expect(panel).not.toBeNull();
    expect(panel!.className).toContain("w-[340px]");
    expect([...panel!.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Las cifras son del mes en curso.", "Estimado = sin ticket."]);
  });
});

describe("ds3 — barra de alcance", () => {
  it("una fila con nombre accesible, filtros con conteo, chips quitables y espaciador", () => {
    const quitar = vi.fn();
    const abrir = vi.fn();
    rendered = renderComponent(
      <BarraAlcance>
        <BotonFiltros activos={2} onClick={abrir} />
        <ChipFiltro etiqueta="Sucursal: Centro" onQuitar={quitar} />
        <BarraAlcanceEspaciador />
        <span>Actualizado hoy</span>
      </BarraAlcance>,
    );
    const barra = q('[role="group"][aria-label="Alcance y filtros"]')!;
    expect(barra.className).toContain("whitespace-nowrap");
    expect(barra.className).toContain("overflow-x-auto");
    const filtros = q(".ds3-alcance-filtros")!;
    expect(filtros.textContent).toBe("Filtros (2)");
    click(filtros);
    expect(abrir).toHaveBeenCalledTimes(1);
    click(q('button[aria-label="Quitar filtro Sucursal: Centro"]')!);
    expect(quitar).toHaveBeenCalledTimes(1);
    expect(q(".ds3-alcance-espaciador")).not.toBeNull();
  });

  it("sin filtros activos el boton dice solo «Filtros»", () => {
    rendered = renderComponent(<BotonFiltros />);
    expect(q(".ds3-alcance-filtros")!.textContent).toBe("Filtros");
  });
});
