// @vitest-environment jsdom
//
// i18n ES/EN — componentes comunes de @atiende/ui: estados vacio/error/cargando, tabla con paginacion y seleccion, campos,
// KPIs y filtros. En ingles hablan ingles natural; en espanol quedan IDENTICOS a antes; un texto que pasa quien llama gana.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Activity } from "lucide-react";
import type { ReactElement } from "react";
import { DataTable, EstadoCargando, EstadoError, EstadoVacio, FormField, GlobalFilter, IdiomaProvider, Input, StatCard, cargarIdioma, resolverRango } from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

let r: RenderedComponent | undefined;
// El ingles es un chunk perezoso: se precarga para que el render sea sincrono.
beforeAll(() => cargarIdioma("en"));
beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
  // El idioma solo cambia con el diseno ds3 (el unico con selector ES/EN).
  document.documentElement.dataset.diseno = "ds3";
});
afterEach(() => {
  r?.unmount();
  r = undefined;
});

const filas = Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), nombre: `Fila ${i + 1}` }));

function pantalla(idioma: "es" | "en"): ReactElement {
  return (
    <IdiomaProvider idiomaInicial={idioma}>
      <MemoryRouter>
        <EstadoVacio mensaje="—" />
        <EstadoError onReintentar={() => {}} />
        <EstadoError integracion="Stripe" />
        <EstadoCargando />
        <DataTable
          columnas={[{ id: "nombre", encabezado: "Nombre", celda: (f: { nombre: string }) => f.nombre, principal: true }]}
          filas={filas}
          obtenerId={(f) => f.id}
          etiqueta="filas"
          paginacion={{ tamano: 5 }}
          seleccionable
        />
        <FormField label="Correo" required>
          <Input />
        </FormField>
        <StatCard icon={Activity} label="Ventas" value="$10" delta={{ pct: 0, bueno: true }} />
        <GlobalFilter base="/x" r={resolverRango("7", "7")} />
      </MemoryRouter>
    </IdiomaProvider>
  );
}

const texto = (c: HTMLElement) => `${c.textContent ?? ""} ${[...c.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join(" ")}`;

describe("componentes comunes", () => {
  it("en espanol, los textos de siempre", () => {
    r = renderComponent(pantalla("es"));
    const t = texto(r.container);
    for (const s of ["Sin datos aún", "No disponible ahora", "Reintentar", "No se pudo conectar con Stripe", "Mostrando 1–5 de 12", "Página 1 de 3", "Siguiente", "(obligatorio)", "sin cambio vs periodo anterior", "Rango de fechas", "Todo"]) {
      expect(t, s).toContain(s);
    }
  });

  it("en ingles, ingles natural y nada del espanol del marco", () => {
    r = renderComponent(pantalla("en"));
    const t = texto(r.container);
    for (const s of ["No data yet", "Not available right now", "Try again", "We couldn't connect to Stripe", "Showing 1–5 of 12", "Page 1 of 3", "Next", "Previous", "(required)", "no change vs. previous period", "Date range", "All", "Select all"]) {
      expect(t, s).toContain(s);
    }
    for (const s of ["Sin datos", "No se pudo", "Reintentar", "Mostrando", "Página", "Siguiente", "obligatorio", "periodo anterior", "Rango de fechas"]) {
      expect(t, s).not.toContain(s);
    }
  });

  it("el texto que pasa quien llama gana sobre el del catalogo", () => {
    r = renderComponent(
      <IdiomaProvider idiomaInicial="en">
        <EstadoVacio titulo="Propio" mensaje="—" />
      </IdiomaProvider>,
    );
    expect(r.container.textContent).toContain("Propio");
  });
});
