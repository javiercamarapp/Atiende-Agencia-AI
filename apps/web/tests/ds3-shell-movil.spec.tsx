// @vitest-environment jsdom
//
// ds3 / lote 5.3 (movil): la cabecera, la barra inferior y la hoja «Más» se marcan para la hoja ds3; la hoja «Más» suma (OCULTO sin
// la bandera) el pie del sidebar: tema, idioma y tarjeta de cuenta con «Salir». El teclado abierto se publica en html[data-teclado].
// Solo AÑADE: no toca ningun spec existente.
import { act } from "react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CalendarCheck, Settings, Users } from "lucide-react";
import { VerticalShell, type SidebarSection } from "@atiende/ui";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SECCIONES: SidebarSection[] = [
  { title: "Resumen", siempreAbierto: true, items: [{ to: "/v/demo", label: "Resumen", icon: CalendarCheck, end: true }] },
  { title: "Clientes", items: [{ to: "/v/demo/clientes", label: "Clientes", icon: Users }] },
  { title: "Configuración", items: [{ to: "/v/demo/configuracion", label: "Configuración", icon: Settings }] },
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
  delete document.documentElement.dataset.teclado;
});

function renderShell(onLogout = () => {}, ruta = "/v/demo/configuracion", extra: Partial<React.ComponentProps<typeof VerticalShell>> = {}): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <VerticalShell
        vertical="demo"
        sections={SECCIONES}
        mobileItems={[
          { to: "/v/demo", label: "Resumen", icon: CalendarCheck, end: true },
          { to: "/v/demo/clientes", label: "Clientes", icon: Users },
        ]}
        user={{ email: "ana@negocio.mx", nombre: "Ana Pérez", rolEtiqueta: "Propietaria" }}
        onLogout={onLogout}
        header={{ icon: <span />, title: "Demo" }}
        {...extra}
      >
        <p>contenido</p>
      </VerticalShell>
    </MemoryRouter>,
  );
}

const q = (sel: string, raiz: ParentNode = document.body) => raiz.querySelector<HTMLElement>(sel);

describe("ds3 — movil: marcas para la hoja", () => {
  it("cabecera, fila, titulo, menu de cuenta y barra inferior llevan su clase ds3; los testids de siempre siguen", () => {
    rendered = renderShell();
    const cabecera = q('[data-testid="mobile-header"]')!;
    expect(cabecera.classList.contains("ds3-movil-cabecera")).toBe(true);
    expect(q(".ds3-movil-cabecera-fila", cabecera)).not.toBeNull();
    expect(q(".ds3-movil-titulo [data-testid='mobile-pagina-titulo']", cabecera)!.textContent).toBe("Configuración");
    expect(q('button.ds3-movil-menu[aria-label="Abrir menú de cuenta"]', cabecera)).not.toBeNull();
    const barra = q('nav[aria-label="Navegación móvil"]')!;
    expect(barra.classList.contains("ds3-barra-inferior")).toBe(true);
    expect(barra.querySelectorAll(".ds3-barra-destino")).toHaveLength(3);
  });

  it("«Más» se marca activo (data-activo) cuando la ruta esta fuera de los destinos de la barra", () => {
    rendered = renderShell();
    const mas = [...document.body.querySelectorAll<HTMLButtonElement>("nav[aria-label='Navegación móvil'] button")].find((b) => b.textContent?.trim() === "Más")!;
    expect(mas.hasAttribute("data-activo")).toBe(true);
    rendered.unmount();
    rendered = renderShell(() => {}, "/v/demo/clientes");
    const mas2 = [...document.body.querySelectorAll<HTMLButtonElement>("nav[aria-label='Navegación móvil'] button")].find((b) => b.textContent?.trim() === "Más")!;
    expect(mas2.hasAttribute("data-activo")).toBe(false);
  });
});

describe("ds3 — hoja «Más» con el pie del sidebar", () => {
  it("suma tema, idioma y la tarjeta de cuenta con «Salir», ocultos sin la bandera", () => {
    const onLogout = vi.fn();
    rendered = renderShell(onLogout);
    click([...document.body.querySelectorAll<HTMLButtonElement>("nav[aria-label='Navegación móvil'] button")].find((b) => b.textContent?.trim() === "Más")!);
    const hoja = q(".ds3-hoja-mas")!;
    const cuenta = q('[data-testid="mas-cuenta"]', hoja)!;
    expect(cuenta.hidden).toBe(true);
    expect(q('[role="radiogroup"][aria-label="Tema de la interfaz"]', cuenta)).not.toBeNull();
    expect(q('[role="group"][aria-label="Idioma de la interfaz"]', cuenta)).not.toBeNull();
    expect(cuenta.textContent).toContain("Ana Pérez");
    expect(cuenta.textContent).toContain("Propietaria");
    const salir = [...cuenta.querySelectorAll("button")].find((b) => b.textContent === "Salir")!;
    click(salir);
    expect(onLogout).toHaveBeenCalledTimes(1);
    // El menu de cuenta de la cabecera sigue siendo el camino visible a «Cerrar sesión» sin la bandera.
    expect([...hoja.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Cerrar sesión")).toBe(false);
  });
});

// Decision de Omar 7-nov-2026 (igual que Rovaq; reemplaza «encabezado movil sin campana» y la barra fija en 4 + «Más»).
describe("ds3 — campana en la cabecera movil y «Preguntar» como 5.o destino", () => {
  it("la cabecera lleva la campana de 44 (enlace a notificaciones, contador real, 99+) entre el selector y «Más»; oculta sin la bandera", () => {
    rendered = renderShell(() => {}, "/v/demo/configuracion", { notificaciones: { to: "/v/demo/notificaciones", contador: 3, hayNoLeidas: true } });
    const fila = q(".ds3-movil-cabecera-fila")!;
    const campana = q('a[data-testid="movil-campana"]', fila) as HTMLAnchorElement;
    expect(campana.getAttribute("href")).toBe("/v/demo/notificaciones");
    expect(campana.getAttribute("aria-label")).toBe("Notificaciones: 3 sin leer");
    expect(campana.hidden).toBe(true);
    expect(campana.classList.contains("ds3-solo")).toBe(true);
    expect(campana.classList.contains("ds3-movil-campana")).toBe(true);
    expect(q('[data-testid="movil-campana-contador"]', campana)!.textContent).toBe("3");
    // Orden (Rovaq): campana justo antes de «Más» de la cabecera; el menu de cuenta del diseno actual va despues, oculto con ds3.
    expect(campana.nextElementSibling?.getAttribute("aria-label")).toBe("Abrir más secciones");
    expect(fila.textContent).not.toContain("Pregúntale a tus datos");
    rendered.unmount();
    rendered = renderShell(() => {}, "/v/demo/configuracion", { notificaciones: { to: "/v/demo/notificaciones", contador: 150, hayNoLeidas: true } });
    expect(q('[data-testid="movil-campana-contador"]')!.textContent).toBe("99+");
    rendered.unmount();
    rendered = renderShell(() => {}, "/v/demo/configuracion", { notificaciones: { to: "/v/demo/notificaciones", contador: 0, hayNoLeidas: false } });
    expect(q('a[data-testid="movil-campana"]')!.getAttribute("aria-label")).toBe("Notificaciones");
    expect(q('[data-testid="movil-campana-contador"]')).toBeNull();
    expect(q('[data-testid="movil-campana-punto"]')).toBeNull();
  });

  it("sin `notificaciones` no hay campana (no hay controles maqueta)", () => {
    rendered = renderShell();
    expect(q('[data-testid="movil-campana"]')).toBeNull();
  });

  it("«Preguntar» va entre los destinos y «Más», enlace al chat de datos, solo-ds3; sin `preguntarHref` (rol sin acceso) no existe", () => {
    rendered = renderShell(() => {}, "/v/demo/copiloto", { preguntarHref: "/v/demo/copiloto" });
    const barra = q('nav[aria-label="Navegación móvil"]')!;
    const lugares = [...barra.querySelectorAll(":scope > ul > li")];
    expect(lugares.map((li) => li.textContent?.trim())).toEqual(["Resumen", "Clientes", "Preguntar", "Más"]);
    const li = lugares[2] as HTMLLIElement;
    expect(li.hidden).toBe(true);
    expect(li.classList.contains("ds3-barra-preguntar")).toBe(true);
    const enlace = li.querySelector("a")!;
    expect(enlace.getAttribute("href")).toBe("/v/demo/copiloto");
    expect(enlace.getAttribute("aria-current")).toBe("page");
    rendered.unmount();
    rendered = renderShell();
    expect(q('[data-testid="barra-preguntar"]')).toBeNull();
  });
});

describe("ds3 — teclado abierto", () => {
  it("con un campo enfocado y el visualViewport encogido publica html[data-teclado=abierto]; al cerrarse lo quita", () => {
    const oyentes = new Map<string, () => void>();
    const vv = { height: 800, addEventListener: (t: string, f: () => void) => oyentes.set(t, f), removeEventListener: () => {} };
    vi.stubGlobal("visualViewport", vv);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    rendered = renderShell();
    const campo = document.createElement("input");
    document.body.appendChild(campo);
    act(() => campo.focus());
    vv.height = 450;
    act(() => oyentes.get("resize")!());
    expect(document.documentElement.dataset.teclado).toBe("abierto");
    vv.height = 800;
    act(() => oyentes.get("resize")!());
    expect(document.documentElement.dataset.teclado).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
