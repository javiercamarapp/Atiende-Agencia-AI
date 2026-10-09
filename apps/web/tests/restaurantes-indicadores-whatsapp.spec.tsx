// @vitest-environment jsdom
//
// <IndicadoresWhatsappPage />: KPI del agente de WhatsApp (R-31). `fetch` inyectado por ruta real (lib/whatsapp-kpi-client.ts).
// Cubre: cifras exactas, "—" con su razón (nunca 0 inventado), rótulo veraz "Costo LLM promedio por pedido", organización demo,
// sin alcance de organización, base sin migrar, error con reintento, cambio de periodo, rol sin acceso y ausencia de teléfonos.
import { act } from "react";
import { afterEach, describe, expect, it, vi, beforeAll } from "vitest";
import { IndicadoresWhatsappPage } from "../src/verticals/restaurantes/pages/IndicadoresWhatsapp.tsx";
import { changeValue, click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

const URL_KPI = (dias: number) => `https://api.test/v1/restaurantes/prop-1/admin/whatsapp/kpi?dias=${dias}`;

function resumen(parcial: Record<string, unknown> = {}) {
  return {
    dias: 2, conversaciones: 10, conversacionesConPedido: 4, conversacionesConHandoff: 1, conversionPct: 40, handoffPct: 10, pedidos: 5, handoffs: 2,
    pedidosOrg: 6, orgEsDemo: false, costoLlmOrgCentavosMxn: 1600, costoLlmPorPedidoCentavosMxn: 267, ...parcial,
  };
}
function kpi(parcial: Record<string, unknown> = {}, resumenParcial: Record<string, unknown> = {}) {
  return {
    disponible: true, zonaHoraria: "America/Mexico_City", hoy: "2026-03-10", desde: "2026-03-09", hasta: "2026-03-10", resumen: resumen(resumenParcial),
    serie: [
      { fecha: "2026-03-09", conversaciones: 4, conversacionesConPedido: 1, conversionPct: 25, handoffPct: 25, pedidos: 1, handoffs: 1, pedidosOrg: 2, costoLlmOrgCentavosMxn: 600, costoLlmPorPedidoCentavosMxn: 300 },
      { fecha: "2026-03-10", conversaciones: 6, conversacionesConPedido: 3, conversionPct: 50, handoffPct: 0, pedidos: 4, handoffs: 1, pedidosOrg: 4, costoLlmOrgCentavosMxn: 1000, costoLlmPorPedidoCentavosMxn: 250 },
    ],
    ...parcial,
  };
}

type Respuesta = { status: number; body?: unknown };
const res = (r: Respuesta) => ({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} }) as unknown as Response;

function stub(porDias: Record<number, Respuesta>) {
  return vi.fn(async (url: string) => {
    for (const [dias, r] of Object.entries(porDias)) if (url === URL_KPI(Number(dias))) return res(r);
    throw new Error(`fetch inesperado: ${url}`);
  });
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
async function pintar(fetchMock: ReturnType<typeof stub>, role = "owner") {
  rendered = renderComponent(
    <IndicadoresWhatsappPage apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" orgSlug="demo" role={role} staffFullName={undefined} staffEmail="a@b.c" fetchImpl={fetchMock as unknown as typeof fetch} />,
  );
  await settle();
}
const texto = () => rendered!.container.textContent ?? "";

describe("<IndicadoresWhatsappPage />", () => {
  it("muestra las cifras reales, el rótulo veraz del costo y la serie diaria (más reciente primero)", async () => {
    await pintar(stub({ 14: { status: 200, body: kpi() } }));
    const t = texto();
    expect(t).toContain("Conversaciones nuevas");
    expect(t).toContain("Conversión a pedido");
    expect(t).toContain("40%");
    expect(t).toContain("4 de 10 conversaciones nuevas terminaron en pedido");
    expect(t).toContain("Tasa de handoff a una persona");
    expect(t).toContain("Costo LLM promedio por pedido");
    expect(t).not.toMatch(/costo por pedido real/i);
    expect(t).toContain("$2.67 MXN");
    expect(t).toContain("no es el costo real de cada pedido");
    expect(t).toContain("$16.00 MXN");
    const filas = Array.from(rendered!.container.querySelectorAll("tr[data-dia]")).map((f) => f.getAttribute("data-dia"));
    expect(filas).toEqual(["2026-03-10", "2026-03-09"]);
    expect(t).not.toMatch(/\+52|telefono|teléfono:/i);
  });

  it("sin conversaciones: guiones con razón, nunca 0%", async () => {
    await pintar(stub({ 14: { status: 200, body: kpi({ serie: [] }, { conversaciones: 0, conversacionesConPedido: 0, conversionPct: null, handoffPct: null, pedidos: 0, pedidosOrg: 0, costoLlmPorPedidoCentavosMxn: null, costoLlmOrgCentavosMxn: 0 }) } }));
    const t = texto();
    expect(t).toContain("Sin conversaciones nuevas en el periodo.");
    expect(t).toContain("Sin pedidos de WhatsApp en el periodo.");
    expect(t).not.toContain("0%");
    expect(t).toContain("Sin días con datos");
  });

  it("admin acotado a una sucursal: el costo de la organización no se muestra y se dice por qué", async () => {
    await pintar(stub({ 14: { status: 200, body: kpi({}, { pedidosOrg: null, costoLlmOrgCentavosMxn: null, costoLlmPorPedidoCentavosMxn: null }) } }), "admin");
    expect(texto()).toContain("Solo se muestra con acceso a toda la organización");
  });

  it("organización demo: avisa y no muestra costo", async () => {
    await pintar(stub({ 14: { status: 200, body: kpi({}, { orgEsDemo: true, costoLlmOrgCentavosMxn: null, costoLlmPorPedidoCentavosMxn: null }) } }));
    expect(rendered!.container.querySelector("[data-testid=aviso-demo]")).not.toBeNull();
    expect(texto()).toContain("widget público");
  });

  it("falta el tipo de cambio: se dice y no se inventa el costo", async () => {
    await pintar(stub({ 14: { status: 200, body: kpi({}, { costoLlmOrgCentavosMxn: null, costoLlmPorPedidoCentavosMxn: null }) } }));
    expect(texto()).toContain("Falta el tipo de cambio");
  });

  it("base sin migrar (disponible=false o 503): estado honesto, sin cifras", async () => {
    await pintar(stub({ 14: { status: 200, body: { disponible: false, serie: [] } } }));
    expect(texto()).toContain("Indicadores no disponibles todavía");
    expect(rendered!.container.querySelector("[data-testid=indicadores-whatsapp]")).toBeNull();
    rendered!.unmount();
    await pintar(stub({ 14: { status: 503 } }));
    expect(texto()).toContain("Indicadores no disponibles todavía");
  });

  it("error de red/servidor: mensaje y reintento que vuelve a pedir", async () => {
    const fetchMock = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(res({ status: 500 }))
      .mockResolvedValueOnce(res({ status: 200, body: kpi() }));
    await pintar(fetchMock as unknown as ReturnType<typeof stub>);
    const reintentar = Array.from(rendered!.container.querySelectorAll("button")).find((b) => /reintentar/i.test(b.textContent ?? ""));
    expect(reintentar).toBeDefined();
    click(reintentar!);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(texto()).toContain("Conversión a pedido");
  });

  it("cambiar el periodo vuelve a pedir ese rango", async () => {
    const fetchMock = stub({ 14: { status: 200, body: kpi() }, 30: { status: 200, body: kpi({}, { conversaciones: 99, conversionPct: 12.5 }) } });
    await pintar(fetchMock);
    elegirValor(rendered!.container.querySelector("#periodo-whatsapp") as HTMLElement, "30");
    await settle();
    expect(fetchMock).toHaveBeenLastCalledWith(URL_KPI(30), expect.anything());
    expect(texto()).toContain("12.5%");
  });

  it("rol sin acceso (staff): aviso y NO se llama a la API", async () => {
    const fetchMock = stub({});
    await pintar(fetchMock, "staff");
    expect(texto()).toContain("Solo los roles");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("entrega y lectura de los avisos de pedido (migración 066)", () => {
    const entrega = (parcial: Record<string, unknown> = {}) => ({
      disponible: true,
      resumen: { dias: 2, enviados: 10, entregados: 6, leidos: 3, fallidos: 3, sinEstado: 1, entregaPct: 60, lecturaPct: 50, fallosPorMotivo: { fuera_de_ventana: 2, numero_no_entregable: 1 } },
      serie: [
        { fecha: "2026-03-09", enviados: 4, entregados: 3, leidos: 1, fallidos: 1, sinEstado: 0, fallosPorMotivo: { fuera_de_ventana: 1 } },
        { fecha: "2026-03-10", enviados: 6, entregados: 3, leidos: 2, fallidos: 2, sinEstado: 1, fallosPorMotivo: { fuera_de_ventana: 1, numero_no_entregable: 1 } },
      ],
      ...parcial,
    });

    it("muestra tasa de entrega y de lectura, los avisos no entregados con sus motivos y la serie diaria (más reciente primero)", async () => {
      await pintar(stub({ 14: { status: 200, body: kpi({ entrega: entrega() }) } }));
      const t = texto();
      expect(t).toContain("Tasa de entrega");
      expect(t).toContain("60%");
      expect(t).toContain("6 de 10 llegaron al teléfono del cliente · 1 sin confirmación todavía");
      expect(t).toContain("Tasa de lectura");
      expect(t).toContain("3 de 6 entregados fueron leídos");
      expect(t).toContain("Avisos no entregados");
      expect(rendered!.container.querySelector("[data-testid=entrega-motivos]")?.textContent).toBe("Motivos de fallo: Fuera de la ventana de 24 h (2) · Número no entregable (1).");
      const filas = Array.from(rendered!.container.querySelectorAll("tr[data-dia-entrega]")).map((f) => f.getAttribute("data-dia-entrega"));
      expect(filas).toEqual(["2026-03-10", "2026-03-09"]);
      expect(t).not.toMatch(/\+52|wamid|teléfono:/i);
    });

    it("sin avisos enviados: guiones con su razón, nunca 0%", async () => {
      await pintar(stub({ 14: { status: 200, body: kpi({ entrega: entrega({ resumen: { dias: 2, enviados: 0, entregados: 0, leidos: 0, fallidos: 0, sinEstado: 0, entregaPct: null, lecturaPct: null, fallosPorMotivo: {} }, serie: [] }) }) } }));
      const t = texto();
      expect(t).toContain("Sin avisos enviados en el periodo.");
      expect(t).toContain("Todavía no hay avisos entregados.");
      expect(rendered!.container.querySelector("[data-testid=entrega-motivos]")).toBeNull();
    });

    it("base sin la 066 (entrega.disponible=false) o API sin el bloque: estado honesto 'no disponible aún' y el KPI de conversaciones sigue", async () => {
      await pintar(stub({ 14: { status: 200, body: kpi({ entrega: entrega({ disponible: false, serie: [] }) }) } }));
      expect(rendered!.container.querySelector("[data-testid=entrega-no-disponible]")?.textContent).toContain("no disponible aún");
      expect(texto()).toContain("Conversión a pedido");
      expect(rendered!.container.querySelector("[data-testid=entrega-avisos]")).toBeNull();
      rendered!.unmount();
      await pintar(stub({ 14: { status: 200, body: kpi() } }));
      expect(rendered!.container.querySelector("[data-testid=entrega-no-disponible]")).not.toBeNull();
    });
  });
});
