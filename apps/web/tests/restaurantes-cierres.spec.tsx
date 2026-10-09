// @vitest-environment jsdom
//
// <CierresPage />: cierre del día y resumen semanal (R-42). `fetch` inyectado por ruta real (lib/cierres-client.ts).
// Cubre: cifras exactas, "—" con su razón (nunca 0 inventado), periodos pendientes con botón REAL que llama al API y recarga, vista de
// semana con por-día, selección de un cierre anterior, base sin migrar, error con reintento, rol sin acceso y ausencia de PII.
import { act } from "react";
import { afterEach, describe, expect, it, vi, beforeAll } from "vitest";
import { CierresPage } from "../src/verticals/restaurantes/pages/Cierres.tsx";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

const BASE = "https://api.test/v1/restaurantes/prop-1/admin/cierres";
const CANALES = [
  { canal: "web", pedidos: 1, ventasCentavos: 1000, cancelados: 1 },
  { canal: "whatsapp", pedidos: 2, ventasCentavos: 30050, cancelados: 0 },
  { canal: "voice", pedidos: 1, ventasCentavos: 5000, cancelados: 0 },
  { canal: "admin", pedidos: 1, ventasCentavos: 2525, cancelados: 0 },
];

function cierre(parcial: Record<string, unknown> = {}) {
  return {
    id: "c1", tipo: "dia", fechaInicio: "2026-03-09", fechaFin: "2026-03-09", zonaHoraria: "America/Mexico_City", generadoPor: "sistema", generadoAt: "2026-03-10T12:00:00.000Z",
    pedidos: 5, ventasCentavos: 38575, ticketPromedioCentavos: 7715, conProblema: 0, cancelados: 1, canceladosCentavos: 8000, noRecogidos: 1, cancelacionPct: 16.7,
    porCanal: CANALES, tiempos: { entregados: 2, promedioMin: 45, medianaMin: 45, p90Min: 57 },
    comparativo: { fechaInicio: "2026-03-02", fechaFin: "2026-03-02", pedidos: 2, ventasCentavos: 20000, variacionPedidosPct: 150, variacionVentasPct: 92.9 }, porDia: null,
    ...parcial,
  };
}
function lista(parcial: Record<string, unknown> = {}) {
  return { disponible: true, tipo: "dia", zonaHoraria: "America/Mexico_City", hoy: "2026-03-10", cierres: [cierre()], pendientes: [], ...parcial };
}

type Respuesta = { status: number; body?: unknown };
const res = (r: Respuesta) => ({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} }) as unknown as Response;

function stub(rutas: Record<string, Respuesta | (() => Respuesta)>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const clave = `${init?.method ?? "GET"} ${url}`;
    const r = rutas[clave];
    if (!r) throw new Error(`fetch inesperado: ${clave}`);
    return res(typeof r === "function" ? r() : r);
  });
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
async function pintar(fetchMock: ReturnType<typeof stub>, role = "owner") {
  rendered = renderComponent(
    <CierresPage apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" orgSlug="demo" role={role} staffFullName={undefined} staffEmail="a@b.c" fetchImpl={fetchMock as unknown as typeof fetch} />,
  );
  await settle();
}
const texto = () => rendered!.container.textContent ?? "";

describe("<CierresPage />", () => {
  it("el canal web se muestra como «Pedido en línea (histórico)» solo si tiene datos; sin datos la línea no aparece", async () => {
    await pintar(stub({ [`GET ${BASE}?tipo=dia`]: { status: 200, body: lista() } }));
    expect(texto()).toContain("Pedido en línea (histórico)");
    rendered?.unmount();
    const sinWeb = CANALES.map((c) => (c.canal === "web" ? { ...c, pedidos: 0, ventasCentavos: 0, cancelados: 0 } : c));
    await pintar(stub({ [`GET ${BASE}?tipo=dia`]: { status: 200, body: lista({ cierres: [cierre({ porCanal: sinWeb })] }) } }));
    expect(texto()).not.toContain("Pedido en línea");
    expect(texto()).toContain("WhatsApp");
  });

  it("muestra las cifras reales del cierre, la variación contra el comparativo y los tiempos con su base", async () => {
    await pintar(stub({ [`GET ${BASE}?tipo=dia`]: { status: 200, body: lista() } }));
    const t = texto();
    expect(t).toContain("Cierre del día");
    expect(t).toContain("$385.75 MXN");
    expect(t).toContain("$77.15 MXN");
    expect(t).toContain("16.7% de los pedidos");
    expect(t).toContain("1 no recogidos");
    expect(t).toContain("45 min");
    expect(t).toContain("Mediana 45 min");
    expect(t).toContain("2 entregados");
    expect(t).toContain("vs mismo día de la semana pasada");
    expect(t).toContain("WhatsApp");
    expect(t).toContain("$300.50 MXN");
    expect(t).toContain("Un cierre generado no se recalcula");
    expect(t).not.toMatch(/\+52|telefono|teléfono:/i);
  });

  it("sin pedidos: guiones con razón, nunca 0 inventado en ticket ni tiempos", async () => {
    const vacio = cierre({ pedidos: 0, ventasCentavos: 0, ticketPromedioCentavos: null, cancelados: 0, canceladosCentavos: 0, noRecogidos: 0, cancelacionPct: null, tiempos: { entregados: 0, promedioMin: null, medianaMin: null, p90Min: null }, comparativo: null });
    await pintar(stub({ [`GET ${BASE}?tipo=dia`]: { status: 200, body: lista({ cierres: [vacio] }) } }));
    const t = texto();
    expect(t).toContain("Sin pedidos en el periodo.");
    expect(t).toContain("Ningún pedido entregado con hora registrada en el periodo.");
    expect(t).toContain("Sin cancelaciones ni pedidos en el periodo");
  });

  it("sin cierres: estado vacío honesto y los periodos pendientes se ofrecen como botones", async () => {
    await pintar(stub({ [`GET ${BASE}?tipo=dia`]: { status: 200, body: lista({ cierres: [], pendientes: ["2026-03-09", "2026-03-08"] }) } }));
    expect(texto()).toContain("Aún no hay cierres del día");
    const botones = Array.from(rendered!.container.querySelectorAll("[data-testid=cierres-pendientes] button"));
    expect(botones.map((b) => b.getAttribute("data-fecha"))).toEqual(["2026-03-09", "2026-03-08"]);
  });

  it("el botón de un periodo pendiente llama al API real con tipo y fecha, y recarga la lista con el cierre nuevo", async () => {
    let generado = false;
    const fetchMock = stub({
      [`GET ${BASE}?tipo=dia`]: () => (generado ? { status: 200, body: lista({ cierres: [cierre()], pendientes: [] }) } : { status: 200, body: lista({ cierres: [], pendientes: ["2026-03-09"] }) }),
      [`POST ${BASE}/generar`]: () => {
        generado = true;
        return { status: 201, body: { estado: "creado", cierre: cierre() } };
      },
    });
    await pintar(fetchMock);
    click(rendered!.container.querySelector("[data-testid=cierres-pendientes] button")!);
    await settle();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(String(post![1]!.body))).toEqual({ tipo: "dia", fecha: "2026-03-09" });
    expect(rendered!.container.querySelector("[data-testid=cierres-pendientes]")).toBeNull();
    expect(texto()).toContain("$385.75 MXN");
  });

  it("si generar falla (503), no se inventa el cierre y el botón sigue disponible", async () => {
    const fetchMock = stub({
      [`GET ${BASE}?tipo=dia`]: { status: 200, body: lista({ cierres: [], pendientes: ["2026-03-09"] }) },
      [`POST ${BASE}/generar`]: { status: 503 },
    });
    await pintar(fetchMock);
    click(rendered!.container.querySelector("[data-testid=cierres-pendientes] button")!);
    await settle();
    expect(texto()).toContain("Aún no hay cierres del día");
    expect(rendered!.container.querySelector("[data-testid=cierres-pendientes] button")).not.toBeNull();
  });

  it("resumen semanal: cambia el tipo, pide tipo=semana y muestra el por-día", async () => {
    const semana = cierre({
      id: "s1", tipo: "semana", fechaInicio: "2026-03-02", fechaFin: "2026-03-08",
      porDia: [{ fecha: "2026-03-02", pedidos: 3, ventasCentavos: 12345 }, { fecha: "2026-03-03", pedidos: 0, ventasCentavos: 0 }],
    });
    const fetchMock = stub({
      [`GET ${BASE}?tipo=dia`]: { status: 200, body: lista() },
      [`GET ${BASE}?tipo=semana`]: { status: 200, body: lista({ tipo: "semana", cierres: [semana] }) },
    });
    await pintar(fetchMock);
    elegirValor(rendered!.container.querySelector("#tipo-cierre") as HTMLElement, "semana");
    await settle();
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}?tipo=semana`, expect.anything());
    expect(texto()).toContain("Resumen de la semana del");
    expect(texto()).toContain("vs semana anterior");
    const dias = Array.from(rendered!.container.querySelectorAll("tr[data-dia]")).map((f) => f.getAttribute("data-dia"));
    expect(dias).toEqual(["2026-03-02", "2026-03-03"]);
    expect(texto()).toContain("$123.45 MXN");
  });

  it("elegir un cierre anterior muestra su detalle", async () => {
    const otro = cierre({ id: "c0", fechaInicio: "2026-03-08", fechaFin: "2026-03-08", ventasCentavos: 99900, pedidos: 9, ticketPromedioCentavos: 11100 });
    await pintar(stub({ [`GET ${BASE}?tipo=dia`]: { status: 200, body: lista({ cierres: [cierre(), otro] }) } }));
    expect(rendered!.container.querySelector("[data-testid=cierre-detalle]")!.getAttribute("data-cierre-id")).toBe("c1");
    const ver = Array.from(rendered!.container.querySelectorAll("tr[data-cierre='2026-03-08'] button"))[0]!;
    click(ver);
    await settle();
    expect(rendered!.container.querySelector("[data-testid=cierre-detalle]")!.getAttribute("data-cierre-id")).toBe("c0");
    expect(texto()).toContain("$999.00 MXN");
  });

  it("base sin migrar (disponible=false o 503): estado honesto, sin cifras", async () => {
    await pintar(stub({ [`GET ${BASE}?tipo=dia`]: { status: 200, body: { disponible: false, cierres: [], pendientes: [] } } }));
    expect(texto()).toContain("Cierres no disponibles todavía");
    expect(rendered!.container.querySelector("[data-testid=cierres]")).toBeNull();
    rendered!.unmount();
    await pintar(stub({ [`GET ${BASE}?tipo=dia`]: { status: 503 } }));
    expect(texto()).toContain("Cierres no disponibles todavía");
  });

  it("error de servidor: mensaje y reintento que vuelve a pedir", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>().mockResolvedValueOnce(res({ status: 500 })).mockResolvedValueOnce(res({ status: 200, body: lista() }));
    await pintar(fetchMock as unknown as ReturnType<typeof stub>);
    const reintentar = Array.from(rendered!.container.querySelectorAll("button")).find((b) => /reintentar/i.test(b.textContent ?? ""));
    expect(reintentar).toBeDefined();
    click(reintentar!);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(texto()).toContain("$385.75 MXN");
  });

  it("rol sin acceso (staff): aviso y NO se llama a la API", async () => {
    const fetchMock = stub({});
    await pintar(fetchMock, "staff");
    expect(texto()).toContain("Solo los roles");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
