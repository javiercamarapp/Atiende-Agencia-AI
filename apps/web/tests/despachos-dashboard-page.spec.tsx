// @vitest-environment jsdom
//
// D-01 + UNI-RES-despachos — <DashboardPage /> (Resumen del despacho): estados de carga/vacío/error, los 7 KPI en orden con
// formato real, "sin dato" (nunca cero) cuando falta una fuente, saludo por hora de México con reloj fijo, píldoras con su
// href, un solo h1, aviso de fuentes no disponibles, ranking con anomalías y detalle del cliente activo.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { cfdiDelMes, DashboardPage } from "../src/verticals/despachos/pages/Dashboard.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import type { DashboardDespacho, KpisCliente } from "../src/verticals/despachos/lib/dashboard-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

function montar(el: ReactElement) {
  return renderComponent(<MemoryRouter>{el}</MemoryRouter>);
}

afterEach(() => {
  vi.useRealTimers();
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role: "readonly", staffFullName: "Ana María Torres", staffEmail: "a@example.com" };

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
    rendered = montar(<DashboardPage {...CTX} />);
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
    rendered = montar(<DashboardPage {...CTX} />);
    await esperar();
    const text = rendered.container.textContent!;
    expect(text).toContain("Cliente activo · Cliente Uno SA de CV");
    expect(text).toContain("1 cuenta(s) por cobrar con más de 90 días de atraso.");
    expect(text).toContain("Crítico");
    expect(text).toContain("agosto 2026"); // cierre del mes anterior, formateado
  });

  it("un cliente sin fuentes muestra 'Sin dato' (nunca 0) y el aviso de fuentes no disponibles", async () => {
    stub(() => new Response(JSON.stringify({ ...DASHBOARD, cartera: null, cargaTrabajo: null, cierres: null, ranking: [CLIENTE_SIN_DATOS] }), { status: 200 }));
    rendered = montar(<DashboardPage {...CTX} propertyId="prop-2" />);
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
    rendered = montar(<DashboardPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Todavía no hay clientes");
  });

  it("error del servidor: mensaje real y no se queda en 'Cargando'", async () => {
    stub(() => new Response(JSON.stringify({ message: "No perteneces a esta organización." }), { status: 403 }));
    rendered = montar(<DashboardPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).not.toContain("Cargando dashboard");
    expect(rendered.container.textContent).toContain("No perteneces a esta organización.");
  });

  it("avisa cuando el consolidado está truncado", async () => {
    stub(() => new Response(JSON.stringify({ ...DASHBOARD, truncado: true, totalClientesVisibles: 250, totalClientes: 100 }), { status: 200 }));
    rendered = montar(<DashboardPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("primeros 100 de 250 clientes");
  });

  it("los 7 KPI salen en el orden pedido y cada uno enlaza a su pantalla", async () => {
    stub(() => new Response(JSON.stringify(DASHBOARD), { status: 200 }));
    rendered = montar(<DashboardPage {...CTX} />);
    await esperar();
    const etiquetas = [...rendered.container.querySelectorAll('[data-testid="stat-card-chip"]')].map((chip) => chip.nextElementSibling?.textContent);
    expect(etiquetas).toEqual(["Clientes", "Cartera vencida", "Tasa de cobranza", "Pendientes de trabajo", "Cierres sin cerrar", "Anomalías", "CFDI del mes"]);
    const hrefs = (texto: string) => [...rendered!.container.querySelectorAll("a")].filter((a) => a.textContent?.includes(texto)).map((a) => a.getAttribute("href"));
    expect(hrefs("Cartera vencida")).toEqual(["/despachos/demo/cobranza"]);
    expect(hrefs("Pendientes de trabajo")).toEqual(["/despachos/demo/vencimientos"]);
    expect(hrefs("Cierres sin cerrar")).toEqual(["/despachos/demo/cierre-mensual"]);
    expect(hrefs("CFDI del mes")).toEqual(["/despachos/demo/cfdi"]);
  });

  it("destacado 'Cartera pendiente' con el monto real y píldoras 'Ver cobranza' / 'Ver cierre' con su href", async () => {
    stub(() => new Response(JSON.stringify(DASHBOARD), { status: 200 }));
    rendered = montar(<DashboardPage {...CTX} />);
    await esperar();
    const odometro = rendered.container.querySelector('[data-testid="odometro"]');
    expect(odometro?.getAttribute("aria-label")).toBe("Cartera pendiente: $11,600");
    const pildora = (texto: string) => [...rendered!.container.querySelectorAll("a")].find((a) => a.textContent?.trim() === texto)?.getAttribute("href");
    expect(pildora("Ver cobranza")).toBe("/despachos/demo/cobranza");
    expect(pildora("Ver cierre")).toBe("/despachos/demo/cierre-mensual");
  });

  it("un solo h1 (el saludo) con el primer nombre del staff", async () => {
    stub(() => new Response(JSON.stringify(DASHBOARD), { status: 200 }));
    rendered = montar(<DashboardPage {...CTX} />);
    await esperar();
    const h1s = rendered.container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toMatch(/^(Buenos días|Buenas tardes|Buenas noches), Ana$/);
  });

  it.each([
    ["2026-10-02T15:00:00.000Z", "Buenos días"], // 09:00 en CDMX (UTC-6)
    ["2026-10-02T20:00:00.000Z", "Buenas tardes"], // 14:00 en CDMX
    ["2026-10-03T03:30:00.000Z", "Buenas noches"], // 21:30 en CDMX
  ])("saludo por hora de México con reloj fijo (%s -> %s)", async (instante, saludo) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(instante));
    stub(() => new Response(JSON.stringify(DASHBOARD), { status: 200 }));
    rendered = montar(<DashboardPage {...CTX} />);
    await esperar();
    expect(rendered.container.querySelector("h1")?.textContent).toBe(`${saludo}, Ana`);
  });

  it("sin fuentes (cartera/trabajo/cierres null y sin cfdiMes): cada KPI sin fuente es '—' y no hay ceros inventados", async () => {
    stub(() => new Response(JSON.stringify({ ...DASHBOARD, cartera: null, cargaTrabajo: null, cierres: null, ranking: [CLIENTE_SIN_DATOS] }), { status: 200 }));
    rendered = montar(<DashboardPage {...CTX} propertyId="prop-2" />);
    await esperar();
    for (const etiqueta of ["Cartera vencida", "Tasa de cobranza", "Pendientes de trabajo", "Cierres sin cerrar", "CFDI del mes"]) {
      expect(rendered.container.querySelector(`[aria-label="${etiqueta}: sin dato"]`), etiqueta).not.toBeNull();
    }
    // El odómetro del destacado tampoco inventa una cifra.
    expect(rendered.container.querySelector('[data-testid="odometro"]')?.getAttribute("aria-label")).toBe("Cartera pendiente: sin cartera registrada");
    expect(rendered.container.textContent).not.toContain("$0.00");
  });

  it("'Última corrida' declara honestamente que no hay registro de corridas y las tiles de agentes enlazan a pantallas reales", async () => {
    stub(() => new Response(JSON.stringify(DASHBOARD), { status: 200 }));
    rendered = montar(<DashboardPage {...CTX} />);
    await esperar();
    const text = rendered.container.textContent!;
    expect(text).toContain("Orquestación de agentes");
    expect(text).toContain("Sin registro de corridas");
    const hrefs = [...rendered.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const ruta of ["cola-cobranza", "cfdi", "conciliacion", "copiloto"]) expect(hrefs).toContain(`/despachos/demo/${ruta}`);
  });

  it("cfdiDelMes suma los clientes que lo reportan y es null si ninguno", () => {
    expect(cfdiDelMes([CLIENTE_CRITICO, CLIENTE_SIN_DATOS])).toEqual({ total: 4, periodo: "2026-09", clientes: 1 });
    expect(cfdiDelMes([CLIENTE_SIN_DATOS])).toBeNull();
    expect(cfdiDelMes([])).toBeNull();
  });
});
