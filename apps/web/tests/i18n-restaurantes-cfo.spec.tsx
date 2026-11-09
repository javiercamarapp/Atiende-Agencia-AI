// @vitest-environment jsdom
//
// i18n ES/EN — CFO de restaurantes. En espanol el DOM de cada pestana es identico con y sin IdiomaProvider (nadie que no elija EN
// ve un byte distinto); en ingles (diseno ds3) el marco, los filtros y las pestanas salen en ingles natural, sin claves crudas.
// Los datos que arma el servidor (etiquetas de KPI, hallazgos, narrativa) siguen como llegan.
import { act } from "react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { CfoLayout } from "../src/verticals/restaurantes/cfo/CfoLayout.tsx";
import { ETIQUETA_COMPARAR, errorDeRango, etiquetaFecha, etiquetaRango } from "../src/verticals/restaurantes/cfo/filtros-url.ts";
import { ETIQUETA_CONFIANZA, etiquetaMes, textoVariacion } from "../src/verticals/restaurantes/cfo/formato.ts";
import { describirFiltro } from "../src/verticals/restaurantes/cfo/contexto.ts";
import { DIAS_CORTOS, diaCorto } from "../src/verticals/restaurantes/cfo/piezas-b.tsx";
import { PAGINAS_CFO } from "../src/verticals/restaurantes/cfo/paginas.ts";
import { API, PROPIEDAD, crearApiCfo } from "./test-utils/cfo-api-simulada.ts";
import { esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

let rendered: RenderedComponent | undefined;
const RANGO = "desde=2026-09-21&hasta=2026-09-27&comparar=periodo_anterior";
const CLAVE_CRUDA = /\brestaurantes\.[a-zA-Z]+\.[A-Za-z0-9.]+/;
/** Los ids de `useId` dependen de la profundidad del arbol (el proveedor agrega un nivel): se normalizan antes de comparar. */
const sinIdsDeReact = (html: string): string => html.replace(/([-:])r[0-9][0-9a-z]*:?/g, "$1rID");
const PESTANAS = ["resumen", "ventas", "estado-resultados", "clientes", "platillos", "sucursales", "analisis-clientes", "patrones", "operacion", "softrestaurant"] as const;
const LISTO: Readonly<Record<(typeof PESTANAS)[number], string>> = {
  resumen: "[data-testid=hallazgo], [data-testid=kpis]",
  ventas: "[data-testid=ventas-estadisticas]",
  "estado-resultados": "[data-testid=cfo-pyl] table",
  clientes: "[data-testid=clientes-resumen], [data-testid=clientes-aviso-mostrador]",
  platillos: "[data-testid=platillos-sin-margen], [data-testid=cfo-platillos] [role=status]",
  sucursales: "[data-testid=cfo-tabla-sucursales], [data-testid=cfo-sucursales] [role=status]",
  "analisis-clientes": "[data-testid=analisis-periodo]",
  patrones: "[data-testid=patrones-frecuencia], [data-testid=cfo-patrones] [role=status]",
  operacion: "[data-testid=costo-agente], [data-testid=cfo-operacion] [role=status]",
  softrestaurant: "[data-testid=sr-bloque-importar]",
};

beforeAll(async () => {
  prepararJsdomParaRadix();
  await cargarIdioma("en");
});
beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.dataset.diseno = "ds3";
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  fijarIdiomaActivo("es");
  delete document.documentElement.dataset.diseno;
});

function arbol(pestana: string, idioma?: "es" | "en"): ReactElement {
  const layout = (
    <MemoryRouter initialEntries={[`/restaurantes/demo/cfo/${pestana}?${RANGO}`]}>
      <Routes>
        <Route path="/restaurantes/:orgSlug/cfo/*" element={<CfoLayout apiBaseUrl={API} token="tok" propertyId={PROPIEDAD} orgSlug="demo" role="owner" staffFullName={undefined} staffEmail="a@b.c" fetchImpl={crearApiCfo().fetch} hoy="2026-09-28" />} />
      </Routes>
    </MemoryRouter>
  );
  return idioma ? <IdiomaProvider idiomaInicial={idioma}>{layout}</IdiomaProvider> : layout;
}

async function montar(pestana: (typeof PESTANAS)[number], idioma?: "es" | "en"): Promise<HTMLElement> {
  rendered = renderComponent(arbol(pestana, idioma));
  // Lista: su marca de contenido y ningun estado de carga pendiente (SoftRestaurant carga tres bloques por separado).
  await esperarHasta(() => rendered!.container.querySelector(LISTO[pestana]) !== null && rendered!.container.querySelector('[aria-busy="true"]') === null, `pestana ${pestana}`);
  await act(async () => {
    await Promise.resolve();
  });
  return rendered.container;
}

describe("CFO ES/EN", () => {
  it.each(PESTANAS)("%s: en espanol el DOM es identico con y sin IdiomaProvider", async (pestana) => {
    const sin = sinIdsDeReact((await montar(pestana)).innerHTML);
    rendered?.unmount();
    const con = sinIdsDeReact((await montar(pestana, "es")).innerHTML);
    expect(con).toBe(sin);

  });

  it.each(PESTANAS)("%s: en ingles no quedan frases fijas del CFO en espanol ni claves crudas", async (pestana) => {
    const c = await montar(pestana, "en");
    const texto = c.textContent ?? "";
    for (const en of ["Your sales, branches and P&L in one place", "Compare with", "Overview", "Sales", "Profit & loss", "Customers", "Dishes", "Customer analysis", "Patterns", "Operations & agent", "By branch"]) expect(texto, en).toContain(en);
    for (const es of ["Tus ventas, sucursales", "Comparar contra", "Estado de resultados", "Platillos", "Análisis de clientes", "Patrones", "Operación y agente", "Cargando", "Por sucursal", "Este tablero organiza", "Ver pedidos"]) expect(texto.match(new RegExp(`.{0,60}${es}.{0,40}`))?.[0] ?? "", es).toBe("");
    expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
    expect(c.querySelector("nav")?.getAttribute("aria-label")).toBe("CFO sections");
  });
});

describe("etiquetas de lib/ del CFO (siguen al idioma activo)", () => {
  it("en espanol son las de siempre", () => {
    expect(PAGINAS_CFO.map((p) => p.etiqueta)).toEqual(["Resumen", "Ventas", "Sucursales", "Estado de resultados", "Clientes", "Análisis de clientes", "Platillos", "Patrones", "Operación y agente", "SoftRestaurant"]);
    expect(ETIQUETA_COMPARAR.anio_anterior).toBe("Mismo periodo del año pasado");
    expect(etiquetaFecha("2026-10-07")).toBe("7 oct 2026");
    expect(etiquetaRango("2026-10-01", "2026-10-07")).toBe("1 oct al 7 oct 2026");
    expect(errorDeRango("2026-10-08", "2026-10-07")).toBe("La fecha inicial no puede ser posterior a la final.");
    expect(etiquetaMes("2026-10")).toBe("octubre 2026");
    expect(ETIQUETA_CONFIANZA.capturado).toBe("Capturado");
    expect(textoVariacion({ tipo: "pct", valor: null })).toBe("sin base");
    expect(describirFiltro({ canal: "domicilio", dow_negocio: 3, hora_local: 14 })).toEqual(["A domicilio", "Día: miércoles", "Hora: 14 h"]);
    expect([...DIAS_CORTOS]).toEqual(["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]);
    expect(diaCorto("2026-09-21")).toBe("21 sep");
  });

  it("en ingles", () => {
    fijarIdiomaActivo("en");
    expect(PAGINAS_CFO[3]?.etiqueta).toBe("Profit & loss");
    expect(ETIQUETA_COMPARAR.anio_anterior).toBe("Same period last year");
    expect(etiquetaFecha("2026-10-07")).toBe("Oct 7, 2026");
    expect(etiquetaRango("2026-10-01", "2026-10-07")).toBe("Oct 1 – Oct 7, 2026");
    expect(errorDeRango("2026-10-08", "2026-10-07")).toBe("The start date can't be after the end date.");
    expect(etiquetaMes("2026-10")).toBe("October 2026");
    expect(describirFiltro({ canal: "domicilio", dow_negocio: 3, hora_local: 14 })).toEqual(["Delivery", "Day: Wednesday", "Hour: 14:00"]);
    expect(DIAS_CORTOS[0]).toBe("Mon");
    expect(diaCorto("2026-09-21")).toBe("Sep 21");
  });
});
