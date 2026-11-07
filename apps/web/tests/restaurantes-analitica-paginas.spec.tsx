// @vitest-environment jsdom
//
// Analítica del dueño: pestañas Demanda, Zonas, Productos y combos y Ratios (<AnaliticaLayout /> reutiliza el marco del CFO). Las vistas se construyen con el servicio del
// dominio sobre un repositorio en memoria (datos 100 % sintéticos) y se sirven por un fetch simulado de `/admin/analitica/*`.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAnaliticaRepository, ServicioAnalitica } from "@atiende/domain-restaurantes/analitica";
import type { DemandaCruda, ProductosCrudo, RatiosCrudo, ZonaCruda } from "@atiende/domain-restaurantes/analitica";
import { CfoCombos } from "../src/verticals/restaurantes/cfo/CfoCombos.tsx";
import { CfoDemanda } from "../src/verticals/restaurantes/cfo/CfoDemanda.tsx";
import { CfoRatios } from "../src/verticals/restaurantes/cfo/CfoRatios.tsx";
import { CfoZonas } from "../src/verticals/restaurantes/cfo/CfoZonas.tsx";
import { PAGINAS_ANALITICA } from "../src/verticals/restaurantes/cfo/AnaliticaLayout.tsx";
import type { CfoPaginaProps } from "../src/verticals/restaurantes/cfo/contexto.ts";
import { esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const ORG = "00000000-0000-0000-0000-00000000aa01";
const P1 = "00000000-0000-0000-0000-00000000aa11";
const API = "http://api.test";

const demanda: DemandaCruda = {
  matriz: [
    { propertyId: P1, dow: 5, hora: 13, canal: "domicilio", source: "whatsapp", pedidos: 10, netaCentavos: 300_000 },
    { propertyId: P1, dow: 6, hora: 19, canal: "recoger", source: "voice", pedidos: 6, netaCentavos: 120_000 },
  ],
  semanas: [{ propertyId: P1, semana: "2026-09-21", dias: 7, pedidos: 16, netaCentavos: 420_000 }],
  ticket: [{ propertyId: P1, canal: "domicilio", pedidos: 10, netaCentavos: 300_000, medianaCentavos: 30_000, p90Centavos: 45_000 }],
  pago: [{ propertyId: P1, formaPago: "efectivo", pedidos: 16, netaCentavos: 420_000 }],
  promesa: [{ propertyId: P1, domicilios: 10, entregados: 8, conPromesa: 8, aTiempo: 6, sinPromesa: 0, sinCierre: 2, realMedianaMin: 41, prometidoMedianaMin: 45, desvioMedianaMin: -3 }],
  totales: [{ propertyId: P1, pedidos: 16, netaCentavos: 420_000 }],
  diasConVenta: 12,
};
const zonas: ZonaCruda[] = [
  { propertyId: P1, colonia: "Centro", pedidos: 8, domicilios: 8, recogidas: 0, netaCentavos: 240_000, clientes: 6, entregados: 7, sinCierre: 1, medianaMin: 38, p90Min: 61, masDe60: 1 },
  { propertyId: P1, colonia: "(otras)", pedidos: 5, domicilios: 5, recogidas: 0, netaCentavos: 90_000, clientes: 5, entregados: 5, sinCierre: 0, medianaMin: 40, p90Min: 52, masDe60: 0 },
  { propertyId: P1, colonia: "sin colonia / recoge", pedidos: 8, domicilios: 2, recogidas: 6, netaCentavos: 180_000, clientes: 7, entregados: 1, sinCierre: 1, medianaMin: null, p90Min: null, masDe60: 0 },
];
const productos: ProductosCrudo = {
  productos: [{ propertyId: P1, productoRef: "p1", nombre: "Bistec", categoria: "Tacos", unidades: 30, ingresoCentavos: 150_000, pedidos: 20, costoUnitarioCentavos: null, margenCentavos: null }],
  pares: [{ propertyId: P1, productoA: "p1", productoB: "p2", nombreA: "Bistec", nombreB: "Frijoles", juntos: 9, pedidosA: 20, pedidosB: 12, pedidosTotal: 40, enMenu: false, promocionCodigo: null }],
  costosCargados: 0,
};
const fila = (propertyId: string | null) => ({
  propertyId, pedidos: 16, netaCentavos: 420_000, ticketCentavos: 26_250, clientes: 10, pedidosConCliente: 14, clientesNuevos: 4,
  recompra: { d14: { elegibles: 2, recompraron: 1 }, d30: { elegibles: 0, recompraron: 0 }, d60: { elegibles: 0, recompraron: 0 } },
  cancelados: 4, grandes: 1, convChats: 20, convConPedido: 10, convEscaladas: 5, vozLlamadas: 0, vozConPedido: 0, vozEscaladas: 0,
  respN: 10, respMedianaSeg: 30, respP90Seg: 200, respHasta5min: 9, respAgenteN: 9, respHumanoN: 1, conversacionesAgente: 20, costoTotalCentavos: null, costoPorConversacionCentavos: null,
});
const ratios: RatiosCrudo = { grandeCentavos: 400_000, filas: [fila(P1)] };

const servicio = (sinMigrar = false) =>
  new ServicioAnalitica(new InMemoryAnaliticaRepository({ demanda, zonas, productos, ratios, sinMigrar }), { organizationId: ORG, propertyIds: null, sucursales: [{ propertyId: P1, nombre: "Centro" }] });

function fetchDe(opciones: { sinMigrar?: boolean; status?: number } = {}) {
  const s = servicio(opciones.sinMigrar);
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    if (opciones.status) return new Response(JSON.stringify({ message: "no" }), { status: opciones.status, headers: { "content-type": "application/json" } });
    const ruta = new URL(String(input)).pathname.replace(/^.*\/admin\/analitica/, "");
    const [d, h] = ["2026-09-01", "2026-09-27"] as const;
    const cuerpo = ruta === "/demanda" ? await s.demanda(d, h) : ruta === "/zonas" ? await s.zonas(d, h) : ruta === "/productos" ? await s.productos(d, h) : await s.ratios(d, h);
    return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "content-type": "application/json" } });
  });
}

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

async function pintar(Pagina: (p: CfoPaginaProps) => JSX.Element, f: ReturnType<typeof fetchDe>) {
  const props = {
    api: { fetchImpl: f as unknown as typeof fetch, apiBaseUrl: API, token: "tok", propertyId: P1 },
    role: "owner", orgSlug: "demo", base: "/restaurantes/demo",
    filtros: { desde: "2026-09-01", hasta: "2026-09-27", sucursales: null, comparar: "periodo_anterior", vista: "total" },
    alcance: {}, setFiltros: () => undefined, abrirPedidos: () => undefined, pestanasDisponibles: new Set<string>(),
  } as unknown as CfoPaginaProps;
  rendered = renderComponent(
    <MemoryRouter>
      <Pagina {...props} />
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
}
const texto = () => rendered!.container.textContent ?? "";
const q = (s: string) => rendered!.container.querySelector(s);

describe("registro de pestañas de la analítica", () => {
  it("cuatro pestañas con slug único y sin exportación (no hay vista de exportación todavía)", () => {
    expect(PAGINAS_ANALITICA.map((p) => p.slug)).toEqual(["demanda", "zonas", "combos", "ratios"]);
    expect(PAGINAS_ANALITICA.every((p) => p.vistaExportacion === null)).toBe(true);
  });
});

describe("Demanda", () => {
  it("pinta resumen, horas pico calculadas, aviso de poco historial y la entrega contra la promesa", async () => {
    const f = fetchDe();
    await pintar(CfoDemanda, f);
    await esperarHasta(() => q("[data-testid=demanda-resumen]") !== null, "demanda pintada");
    expect(q("[data-testid=demanda-resumen]")!.textContent).toContain("13:00 y 19:00");
    expect(texto()).toContain("estacionalidad");
    expect(texto()).toContain("Entrega real contra la promesa");
    expect(String(f.mock.calls[0]![0])).toContain("/admin/analitica/demanda?");
  });
});

describe("Zonas", () => {
  it("nota de privacidad con k = 5, «(otras)» y «Sin colonia / recoge» visibles; sin tiempo inventado", async () => {
    await pintar(CfoZonas, fetchDe());
    await esperarHasta(() => q("[data-testid=zonas-privacidad]") !== null, "zonas pintadas");
    expect(q("[data-testid=zonas-privacidad]")!.textContent).toMatch(/menos de 5 pedidos o 5 clientes/);
    const filas = [...rendered!.container.querySelectorAll("tr[data-colonia]")].map((r) => r.getAttribute("data-colonia"));
    expect(filas).toEqual(expect.arrayContaining(["Centro", "(otras)", "sin colonia / recoge"]));
    expect(texto()).toContain("Sin colonia / recoge");
    expect(q("[data-testid=zonas-mosaico]")!.textContent).toContain("Centro");
  });
});

describe("Productos y combos", () => {
  it("sin costo no hay margen; el par sin promoción dice «No existe como combo»", async () => {
    await pintar(CfoCombos, fetchDe());
    await esperarHasta(() => q("[data-testid=cfo-combos] [data-testid=chart-card]") !== null, "combos pintados");
    expect(q("[data-testid=combos-sin-margen]")).not.toBeNull();
    expect(texto()).toContain("Sin costo registrado");
    expect(texto()).toContain("No existe como combo");
    expect(q("[data-testid=combos-oportunidades]")!.textContent).toContain("solo sugiere combos que ya existen en el menú");
  });
});

describe("Ratios", () => {
  it("tarjetas con sus razones, «—» donde no hay dato y la tabla de definiciones", async () => {
    await pintar(CfoRatios, fetchDe());
    await esperarHasta(() => q("[data-testid=ratios-tarjetas]") !== null, "ratios pintados");
    const t = q("[data-testid=ratios-tarjetas]")!.textContent!;
    expect(t).toContain("20 %"); // cancelación 4 / (16 + 4)
    expect(t).toContain("50 %"); // conversión 10 / 20
    expect(t).toContain("30 s");
    expect(t).toContain("—"); // costo por conversación sin tipo de cambio
    expect(texto()).toContain("Cómo se calcula cada ratio");
  });
});

describe("estados honestos", () => {
  it("base sin migrar: «aún no está disponible», sin cifras", async () => {
    await pintar(CfoDemanda, fetchDe({ sinMigrar: true }));
    await esperarHasta(() => texto().includes("aún no está disponible"), "no disponible");
    expect(q("[data-testid=demanda-resumen]")).toBeNull();
  });
  it("403: sin acceso y ninguna cifra", async () => {
    await pintar(CfoRatios, fetchDe({ status: 403 }));
    await esperarHasta(() => texto().includes("no tiene acceso"), "sin acceso");
    expect(q("[data-testid=ratios-tarjetas]")).toBeNull();
  });
});
