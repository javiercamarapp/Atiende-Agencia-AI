// @vitest-environment jsdom
//
// UNI-RES-hoteles: Resumen de hoteles (pages/Dashboard.tsx). Se afirma el EFECTO con la API simulada por ruta real:
//   - por rol: cada rol pide SOLO los endpoints que el servidor le deja leer (cero 403) y ve sus KPIs;
//   - KPI parcial: el endpoint que falla pinta su propio error en su tarjeta sin tumbar el resto;
//   - ultima corrida: el ultimo night audit real, o un vacio honesto (nada inventado);
//   - un solo h1; sin migracion (`disponible:false`) = estado honesto, no un cero;
//   - el rango de P&L usa el dia de calendario de CDMX, no el dia UTC (hallazgo de auditoria a4, antes en
//     hoteles-dashboard-resumen-ejecutivo-rango-cdmx.spec.tsx).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { DashboardPage } from "../src/verticals/hoteles/pages/Dashboard.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { formatFechaSolo } from "../src/lib/formato-fecha.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T15:00:00.000Z"));
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const BASE = "https://api.test/hoteles/prop-1";

function ctxDe(role: string, extra: Partial<HotelesShellContext> = {}): HotelesShellContext {
  return { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Ana María Torres", staffEmail: "ana@example.com", propertyName: "Hotel Casa Azul", ...extra };
}

const CUERPOS: Record<string, unknown> = {
  pl: {
    periodo: { desde: "2026-09-03", hasta: "2026-10-02" },
    kpis: { adr: 1200, revpar: 900, occupancyPct: 75, occupiedRoomNights: 300, availableRoomNights: 400 },
    total: { ingresosTotales: 130000, gop: 55000, gopMarginPct: 42.3, ebitda: 50000, utilidadNeta: 42000 },
  },
  recepcion: {
    fecha: "2026-10-02",
    tareasDisponibles: true,
    identidadDisponible: true,
    resumen: { llegadas: 3, llegadasPendientes: 2, salidas: 4, salidasPendientes: 1, enCasa: 12, habitacionesLibres: 5, habitacionesSucias: 1, habitacionesFueraDeServicio: 0 },
    llegadas: [],
    salidas: [],
    enCasa: [],
    rack: [],
  },
  tickets: {
    disponible: true,
    ahora: "2026-10-02T15:00:00.000Z",
    tickets: [{ id: "t1", estadoSla: "vencido" }, { id: "t2", estadoSla: "vencido" }, { id: "t3", estadoSla: "en_tiempo" }],
  },
  aprobaciones: { disponible: true, ahora: "2026-10-02T15:00:00.000Z", aprobaciones: [{ id: "a1", estado: "pendiente" }, { id: "a2", estado: "pendiente" }, { id: "a3", estado: "aprobada" }] },
  holds: { disponible: true, holds: [{ id: "h1", estado: "pendiente_pago", canal: "whatsapp" }] },
  agentes: {
    disponible: true,
    mes: "2026-10",
    agentes: [
      { clave: "recepcion_whatsapp", nombre: "Agente de reservas", descripcion: "", gobernado: true, activo: true, estado: "activo", motivoPausa: null, pausadoEn: null, presupuestoUsd: 50, gastoUsd: 10, porcentajeUso: 20, llamadas: 41, tokensEntrada: 0, tokensSalida: 0 },
      { clave: "revenue", nombre: "Agente de revenue", descripcion: "", gobernado: true, activo: false, estado: "pausado", motivoPausa: null, pausadoEn: null, presupuestoUsd: null, gastoUsd: 0, porcentajeUso: null, llamadas: 0, tokensEntrada: 0, tokensSalida: 0 },
    ],
  },
  nightAudit: [
    { fecha: "2026-09-30", estado: "completado", completadoEn: "2026-10-01T07:00:00.000Z" },
    { fecha: "2026-10-01", estado: "completado", completadoEn: "2026-10-02T07:30:00.000Z" },
  ],
  mantenimiento: [{ id: "m1" }, { id: "m2" }],
  pedidosFnb: [
    { id: "p1", alergiaDeclarada: true, cocineroConfirmoEn: null },
    { id: "p2", alergiaDeclarada: true, cocineroConfirmoEn: "2026-10-02T14:00:00.000Z" },
    { id: "p3", alergiaDeclarada: false, cocineroConfirmoEn: null },
  ],
};

function ruta(url: string): string {
  const resto = url.slice(BASE.length + 1).split("?")[0]!;
  return resto;
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

/** API simulada: `fallos` fuerza un 500 en esa ruta; `cuerpos` sustituye el cuerpo por defecto. Una ruta no listada es un fallo del test. */
function stubApi(opciones: { fallos?: readonly string[]; cuerpos?: Record<string, unknown> } = {}): void {
  const mapa: Record<string, string> = {
    pl: "pl",
    recepcion: "recepcion",
    tickets: "tickets",
    aprobaciones: "aprobaciones",
    "reservas-agente/holds": "holds",
    agentes: "agentes",
    "night-audit": "nightAudit",
    "mantenimiento/tickets": "mantenimiento",
    "pedidos-fnb": "pedidosFnb",
  };
  fetchMock = vi.fn(async (url: string) => {
    const r = ruta(url);
    const clave = mapa[r];
    if (clave === undefined) throw new Error(`fetch inesperado en el test: ${url}`);
    if (opciones.fallos?.includes(r)) return jsonResponse({ message: `fallo simulado de ${r}` }, 500);
    return jsonResponse(opciones.cuerpos && clave in opciones.cuerpos ? opciones.cuerpos[clave] : CUERPOS[clave]);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function pintar(ctx: HotelesShellContext): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <DashboardPage {...ctx} />
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function rutasPedidas(): string[] {
  return fetchMock.mock.calls.map(([url]) => ruta(url as string)).sort();
}

/** La tarjeta (`StatCard`) cuyo rotulo es `label`. */
function tarjeta(container: HTMLElement, label: string): HTMLElement | null {
  const span = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === label);
  return (span?.closest(".bg-card") as HTMLElement | null) ?? null;
}

function cifra(container: HTMLElement, label: string): string | null | undefined {
  return tarjeta(container, label)?.querySelector("p.font-display")?.textContent;
}

describe("Resumen de hoteles (UNI-RES-hoteles) -- cada rol pide solo lo que el servidor le deja leer", () => {
  it("owner: ocupacion/ADR/RevPAR (P&L), recepcion, tickets, aprobaciones, holds, agentes y night audit; ni reservas ni mantenimiento ni F&B", async () => {
    stubApi();
    rendered = pintar(ctxDe("owner"));
    await esperarCarga();

    expect(rutasPedidas()).toEqual(["agentes", "aprobaciones", "night-audit", "pl", "recepcion", "reservas-agente/holds", "tickets"]);
    const c = rendered.container;
    expect(cifra(c, "Ocupación")).toBe("75.0%");
    expect(cifra(c, "ADR")).toBe("$1,200");
    expect(cifra(c, "Llegadas")).toBe("3");
    expect(cifra(c, "Salidas")).toBe("4");
    expect(cifra(c, "En casa")).toBe("12");
    expect(cifra(c, "Tickets con SLA vencido")).toBe("2");
    expect(cifra(c, "Aprobaciones pendientes")).toBe("2");
    expect(cifra(c, "Holds del agente")).toBe("1");
    // RevPAR en el destacado (Odometro) y en texto para movil.
    expect(c.textContent).toContain("RevPAR");
    expect(c.querySelector('[data-testid="odometro"]')?.getAttribute("aria-label")).toBe("RevPAR · 30 días: $900");
    // Saludo con el primer nombre y la property en el subtitulo.
    expect(c.querySelector("h1")?.textContent).toMatch(/^(Buenos días|Buenas tardes|Buenas noches), Ana$/);
    expect(c.textContent).toContain("Hotel Casa Azul · 30 días");
    // Pildoras de accion con su ruta real.
    const hrefs = Array.from(c.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/hoteles/demo/recepcion", "/hoteles/demo/revenue", "/hoteles/demo/copiloto"]));
  });

  it("un solo h1 y las secciones llevan su rotulo", async () => {
    stubApi();
    rendered = pintar(ctxDe("owner"));
    await esperarCarga();
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    const rotulos = Array.from(rendered.container.querySelectorAll("h2")).map((h) => h.textContent);
    expect(rotulos).toEqual(["Orquestación de agentes", "Última corrida"]);
  });

  it("frontdesk: recepcion, tickets, aprobaciones, holds y agentes; sin P&L ni night audit (el servidor daria 403)", async () => {
    stubApi();
    rendered = pintar(ctxDe("frontdesk"));
    await esperarCarga();

    expect(rutasPedidas()).toEqual(["agentes", "aprobaciones", "recepcion", "reservas-agente/holds", "tickets"]);
    const c = rendered.container;
    expect(cifra(c, "Llegadas")).toBe("3");
    expect(tarjeta(c, "Ocupación")).toBeNull();
    expect(c.querySelector('[data-testid="odometro"]')).toBeNull();
    expect(Array.from(c.querySelectorAll("h2")).map((h) => h.textContent)).toEqual(["Orquestación de agentes"]);
    const hrefs = Array.from(c.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).not.toContain("/hoteles/demo/revenue");
    expect(hrefs).not.toContain("/hoteles/demo/copiloto");
  });

  it("accountant: P&L, tickets, aprobaciones, holds, agentes y night audit; sin recepcion", async () => {
    stubApi();
    rendered = pintar(ctxDe("accountant"));
    await esperarCarga();

    expect(rutasPedidas()).toEqual(["agentes", "aprobaciones", "night-audit", "pl", "reservas-agente/holds", "tickets"]);
    expect(cifra(rendered.container, "Ocupación")).toBe("75.0%");
    expect(tarjeta(rendered.container, "Llegadas")).toBeNull();
  });

  it("housekeeping: solo tickets del huesped y de mantenimiento (ni recepcion, ni reservas, ni agentes)", async () => {
    stubApi();
    rendered = pintar(ctxDe("housekeeping"));
    await esperarCarga();

    expect(rutasPedidas()).toEqual(["mantenimiento/tickets", "tickets"]);
    expect(cifra(rendered.container, "Tickets de mantenimiento abiertos")).toBe("2");
    expect(cifra(rendered.container, "Tickets con SLA vencido")).toBe("2");
    const hrefs = Array.from(rendered.container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/hoteles/demo/reservas", "/hoteles/demo/mantenimiento"]));
  });

  it("fnb: pedidos activos y alergias sin confirmar; el rol fnb no pide mantenimiento", async () => {
    stubApi();
    rendered = pintar(ctxDe("fnb"));
    await esperarCarga();

    expect(rutasPedidas()).toEqual(["pedidos-fnb", "tickets"]);
    expect(cifra(rendered.container, "Pedidos activos")).toBe("3");
    expect(cifra(rendered.container, "Alergia sin confirmar")).toBe("1");
  });
});

describe("Resumen de hoteles -- un KPI que falla pinta su propio error sin tumbar la pagina", () => {
  it("recepcion cae (500): sus tres tarjetas dicen por que, y ocupacion, tickets y agentes siguen con su dato real", async () => {
    stubApi({ fallos: ["recepcion"] });
    rendered = pintar(ctxDe("owner"));
    await esperarCarga();

    const c = rendered.container;
    for (const label of ["Llegadas", "Salidas", "En casa"]) {
      expect(cifra(c, label)).toBe("—");
      expect(tarjeta(c, label)?.textContent).toContain("No se pudo cargar: fallo simulado de recepcion");
    }
    expect(cifra(c, "Ocupación")).toBe("75.0%");
    expect(cifra(c, "Tickets con SLA vencido")).toBe("2");
    expect(c.textContent).toContain("Agente de reservas");
    expect(c.querySelectorAll("h1")).toHaveLength(1);
  });

  it("el P&L cae: el odometro queda en '—' con el motivo y el resto no se afecta", async () => {
    stubApi({ fallos: ["pl"] });
    rendered = pintar(ctxDe("owner"));
    await esperarCarga();

    const c = rendered.container;
    expect(cifra(c, "Ocupación")).toBe("—");
    expect(c.querySelector('[data-testid="odometro"]')?.getAttribute("aria-label")).toContain("No se pudo cargar: fallo simulado de pl");
    expect(cifra(c, "Llegadas")).toBe("3");
  });

  it("base sin migrar (`disponible:false`): tickets, aprobaciones, holds y agentes dicen 'aun no disponible', nunca un cero", async () => {
    stubApi({
      cuerpos: {
        tickets: { disponible: false, ahora: "2026-10-02T15:00:00.000Z", tickets: [] },
        aprobaciones: { disponible: false, ahora: "2026-10-02T15:00:00.000Z", aprobaciones: [] },
        holds: { disponible: false, holds: [] },
        agentes: { disponible: false, mes: "2026-10", agentes: [] },
      },
    });
    rendered = pintar(ctxDe("owner"));
    await esperarCarga();

    const c = rendered.container;
    for (const label of ["Tickets con SLA vencido", "Aprobaciones pendientes", "Holds del agente"]) {
      expect(cifra(c, label)).toBe("—");
      expect(tarjeta(c, label)?.textContent).toContain("Aún no disponible");
    }
    expect(c.textContent).toContain("esta base todavía no tiene el catálogo de agentes");
  });
});

describe("Resumen de hoteles -- Ultima corrida: dato real o vacio honesto", () => {
  it("muestra el night audit MAS RECIENTE por fecha de negocio (sin asumir el orden del servidor), con badge OK", async () => {
    stubApi();
    rendered = pintar(ctxDe("owner"));
    await esperarCarga();

    const c = rendered.container;
    const region = c.querySelector('[role="region"][aria-labelledby="resumen-ultima-corrida"]');
    expect(region?.textContent).toContain("Night audit");
    expect(region?.textContent).toContain("OK");
    expect(region?.textContent).toContain("Fecha de negocio");
    expect(region?.textContent).toContain("completado");
    // La lista llega en orden ascendente: gana la fecha de negocio mas reciente (1-oct), no la primera de la lista.
    expect(region?.textContent).toContain(formatFechaSolo("2026-10-01"));
    expect(region?.textContent).not.toContain(formatFechaSolo("2026-09-30"));
    expect(region?.textContent).not.toContain("Sin bitácora de corridas");
  });

  it("sin corridas: estado vacio honesto, ninguna corrida inventada", async () => {
    stubApi({ cuerpos: { nightAudit: [] } });
    rendered = pintar(ctxDe("owner"));
    await esperarCarga();

    const region = rendered.container.querySelector('[role="region"][aria-labelledby="resumen-ultima-corrida"]');
    expect(region?.textContent).toContain("Sin bitácora de corridas");
    expect(region?.textContent).not.toContain("Night audit");
    expect(region?.textContent).not.toContain("OK");
  });

  it("night audit en progreso: badge 'En curso' y 'sin cerrar todavia'", async () => {
    stubApi({ cuerpos: { nightAudit: [{ fecha: "2026-10-02", estado: "en_progreso", completadoEn: null }] } });
    rendered = pintar(ctxDe("owner"));
    await esperarCarga();

    const region = rendered.container.querySelector('[role="region"][aria-labelledby="resumen-ultima-corrida"]');
    expect(region?.textContent).toContain("En curso");
    expect(region?.textContent).toContain("sin cerrar todavía");
  });

  it("si el night audit falla, la seccion dice el error y no pinta ninguna corrida", async () => {
    stubApi({ fallos: ["night-audit"] });
    rendered = pintar(ctxDe("owner"));
    await esperarCarga();

    const region = rendered.container.querySelector('[role="region"][aria-labelledby="resumen-ultima-corrida"]');
    expect(region?.textContent).toContain("No se pudo cargar: fallo simulado de night-audit");
    expect(region?.textContent).not.toContain("Night audit");
  });
});

describe("Resumen de hoteles -- el rango del P&L es el dia de calendario CDMX, no el dia UTC (hallazgo a4)", () => {
  it("pide 30 dias por defecto contra 'hoy' en CDMX", async () => {
    stubApi();
    rendered = pintar(ctxDe("owner"));
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url]) => (url as string).startsWith(`${BASE}/pl?`));
    expect(call![0]).toBe(`${BASE}/pl?desde=2026-09-03&hasta=2026-10-02`);
  });

  it("a las 19:30 de CDMX (01:30 UTC del dia siguiente) 'hoy' sigue siendo el dia de CDMX", async () => {
    vi.setSystemTime(new Date("2026-10-03T01:30:00.000Z"));
    stubApi();
    rendered = pintar(ctxDe("owner"));
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url]) => (url as string).startsWith(`${BASE}/pl?`));
    expect(call![0]).toBe(`${BASE}/pl?desde=2026-09-03&hasta=2026-10-02`);
  });

  it("cambiar el periodo vuelve a pedir SOLO el P&L con el rango nuevo", async () => {
    stubApi();
    rendered = pintar(ctxDe("owner"));
    await esperarCarga();
    fetchMock.mockClear();

    const radio = rendered.container.querySelector<HTMLInputElement>('input[name="resumen-periodo"][value="7"]')!;
    await act(async () => {
      radio.click();
    });
    await esperarCarga();

    expect(rutasPedidas()).toEqual(["pl"]);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/pl?desde=2026-09-26&hasta=2026-10-02`);
  });
});
