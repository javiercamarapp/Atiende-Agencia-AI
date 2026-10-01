// @vitest-environment jsdom
//
// D-01 — <DashboardPage /> (dashboard gerencial): estados de carga/vacío/error, KPIs reales
// formateados, "sin dato" (nunca cero) cuando falta una fuente, aviso de fuentes no
// disponibles, ranking con anomalías y detalle del cliente activo.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "../src/verticals/despachos/pages/Dashboard.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import type { DashboardDespacho, KpisCliente } from "../src/verticals/despachos/lib/dashboard-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role: "readonly", staffFullName: "Auditor", staffEmail: "a@example.com" };

const CLIENTE_CRITICO: KpisCliente = {
  propertyId: "prop-1",
  nombre: "Cliente Uno SA de CV",
  hoy: "2026-09-30",
  fuentesNoDisponibles: [],
  cartera: {
    cuentasPendientes: 2,
    montoPendiente: 11600,
    cuentasVencidas: 1,
    montoVencido: 5800,
    cuentas90Mas: 1,
    monto90Mas: 5800,
    porAntiguedad: { "0-30": { count: 1, monto: 5800 }, "31-60": { count: 0, monto: 0 }, "61-90": { count: 0, monto: 0 }, "90+": { count: 1, monto: 5800 } },
    scorePromedio: 0.5,
    cuentasSinCorreo: 0,
    cuentasSinMonto: 0,
    cuentasCobradas: 1,
    montoCobrado: 2900,
    tasaCobranzaPct: 20,
  },
  cargaTrabajo: { revisionesPendientes: 1, revisionesAntiguas: 0, vencimientosAbiertos: 2, vencimientosVencidos: 1, vencimientosProximos: 0, tareasCierrePendientes: 3, tareasCierreVencidas: 0, totalPendientes: 6 },
  cierres: { periodosSinCerrar: 1, periodosVencidos: 0, mesAnterior: { year: 2026, month: 8, estado: "abierto" }, periodoReciente: null },
  cfdiMes: { periodo: "2026-09", total: 4, invalidos: 1, requierenRevision: 1 },
  anomalias: [{ codigo: "cartera_90_mas", severidad: "alta", mensaje: "1 cuenta(s) por cobrar con más de 90 días de atraso.", cantidad: 1, monto: 5800 }],
  nivelAtencion: "critico",
};

const CLIENTE_SIN_DATOS: KpisCliente = {
  propertyId: "prop-2",
  nombre: "Cliente Dos",
  hoy: "2026-09-30",
  fuentesNoDisponibles: ["cartera", "revisiones", "vencimientos", "cierre", "cfdi"],
  cartera: null,
  cargaTrabajo: null,
  cierres: null,
  cfdiMes: null,
  anomalias: [],
  nivelAtencion: "sin_datos",
};

const DASHBOARD: DashboardDespacho = {
  organizacion: { slug: "demo", nombre: "Despacho Demo" },
  totalClientesVisibles: 2,
  truncado: false,
  totalClientes: 2,
  clientesPorNivel: { critico: 1, atencion: 0, al_corriente: 0, sin_datos: 1 },
  cartera: { cuentasPendientes: 2, montoPendiente: 11600, montoVencido: 5800, monto90Mas: 5800, montoCobrado: 2900, tasaCobranzaPct: 20, clientesConDato: 1 },
  cargaTrabajo: { revisionesPendientes: 1, vencimientosAbiertos: 2, vencimientosVencidos: 1, tareasCierrePendientes: 3, totalPendientes: 6 },
  cierres: { periodosSinCerrar: 1, periodosVencidos: 0, clientesMesAnteriorSinCerrar: 1 },
  anomaliasPorSeveridad: { alta: 1, media: 0, baja: 0 },
  fuentesNoDisponibles: ["cartera", "revisiones", "vencimientos", "cierre", "cfdi"],
  ranking: [CLIENTE_CRITICO, CLIENTE_SIN_DATOS],
};

function stub(respuesta: () => Response) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respuesta());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("DashboardPage (despachos)", () => {
  it("muestra carga y luego los KPIs reales con formato MXN", async () => {
    const fetchMock = stub(() => new Response(JSON.stringify(DASHBOARD), { status: 200 }));
    rendered = renderComponent(<DashboardPage {...CTX} />);
    expect(rendered.container.textContent).toContain("Cargando dashboard");
    await esperar();
    const text = rendered.container.textContent!;
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.test/v1/despachos/demo/dashboard");
    expect(text).toContain("$11,600.00"); // cartera pendiente
    expect(text).toContain("$5,800.00"); // vencida / 90+
    expect(text).toContain("20.0 %"); // tasa de cobranza
    expect(text).toContain("Pendientes de trabajo");
    expect(text).toContain("1 cliente(s) con el mes anterior abierto");
  });

  it("detalle del cliente activo y anomalías visibles en el ranking", async () => {
    stub(() => new Response(JSON.stringify(DASHBOARD), { status: 200 }));
    rendered = renderComponent(<DashboardPage {...CTX} />);
    await esperar();
    const text = rendered.container.textContent!;
    expect(text).toContain("Cliente activo · Cliente Uno SA de CV");
    expect(text).toContain("1 cuenta(s) por cobrar con más de 90 días de atraso.");
    expect(text).toContain("Crítico");
    expect(text).toContain("agosto 2026"); // cierre del mes anterior, formateado
  });

  it("un cliente sin fuentes muestra 'Sin dato' (nunca 0) y el aviso de fuentes no disponibles", async () => {
    stub(() => new Response(JSON.stringify({ ...DASHBOARD, cartera: null, cargaTrabajo: null, cierres: null, ranking: [CLIENTE_SIN_DATOS] }), { status: 200 }));
    rendered = renderComponent(<DashboardPage {...CTX} propertyId="prop-2" />);
    await esperar();
    const text = rendered.container.textContent!;
    expect(text).toContain("Sin dato");
    expect(text).toContain("Algunos indicadores aún no están disponibles");
    expect(text).toContain("cartera y cobranza");
    expect(text).not.toContain("$0.00");
    // StatCard.sinDato publica aria-label "<label>: sin dato".
    expect(rendered.container.querySelector('[aria-label="Cartera pendiente: sin dato"]')).not.toBeNull();
  });

  it("despacho sin clientes visibles: estado vacío explícito", async () => {
    stub(() => new Response(JSON.stringify({ ...DASHBOARD, totalClientes: 0, totalClientesVisibles: 0, ranking: [] }), { status: 200 }));
    rendered = renderComponent(<DashboardPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Todavía no hay clientes");
  });

  it("error del servidor: mensaje real y no se queda en 'Cargando'", async () => {
    stub(() => new Response(JSON.stringify({ message: "No perteneces a esta organización." }), { status: 403 }));
    rendered = renderComponent(<DashboardPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).not.toContain("Cargando dashboard");
    expect(rendered.container.textContent).toContain("No perteneces a esta organización.");
  });

  it("avisa cuando el consolidado está truncado", async () => {
    stub(() => new Response(JSON.stringify({ ...DASHBOARD, truncado: true, totalClientesVisibles: 250, totalClientes: 100 }), { status: 200 }));
    rendered = renderComponent(<DashboardPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("primeros 100 de 250 clientes");
  });
});
