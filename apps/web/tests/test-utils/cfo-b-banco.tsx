// CFO-08 · banco de pruebas de componente de las pestañas del CFO B: pinta una pestaña con la API simulada SINTÉTICA y expone los selectores comunes.
import type { ComponentType } from "react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach } from "vitest";
import type { CfoPaginaProps } from "../../src/verticals/restaurantes/cfo/contexto.ts";
import { esperarHasta, renderComponent, type RenderedComponent } from "./render.tsx";
import { propsPagina, type crearApiCfo } from "./cfo-api-simulada.ts";

export function bancoCfoB() {
  let rendered: RenderedComponent | undefined;
  afterEach(() => {
    rendered?.unmount();
    rendered = undefined;
  });
  const banco = {
    async pintar(Pagina: ComponentType<CfoPaginaProps>, api: ReturnType<typeof crearApiCfo>, sobre: Parameters<typeof propsPagina>[1] = {}) {
      const props = await propsPagina(api, sobre);
      rendered = renderComponent(
        <MemoryRouter>
          <Pagina {...props} />
        </MemoryRouter>,
      );
      await act(async () => {
        await Promise.resolve();
      });
    },
    desmontar() {
      rendered?.unmount();
      rendered = undefined;
    },
    q: (sel: string): Element | null => rendered!.container.querySelector(sel),
    qa: (sel: string): Element[] => [...rendered!.container.querySelectorAll(sel)],
    texto: (): string => rendered!.container.textContent ?? "",
    /** Cada nodo de texto por separado (el `textContent` de un contenedor pega los números de celdas vecinas). */
    nodosDeTexto: (): string[] => {
      const out: string[] = [];
      const it = document.createTreeWalker(rendered!.container, NodeFilter.SHOW_TEXT);
      for (let n = it.nextNode(); n; n = it.nextNode()) out.push(n.textContent ?? "");
      return out;
    },
    boton: (nombre: string): HTMLButtonElement => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === nombre || b.getAttribute("aria-label") === nombre) as HTMLButtonElement,
    /** El diálogo (Radix) vive en un portal fuera del contenedor. */
    dialogo: (): HTMLElement | null => document.body.querySelector("[role=dialog]"),
    esperar: esperarHasta,
  };
  return banco;
}
