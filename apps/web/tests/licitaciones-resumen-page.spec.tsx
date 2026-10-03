// @vitest-environment jsdom
//
// Resumen de licitaciones (UNI-RES-licitaciones): composicion del Resumen de Likida. TODA cifra sale de las lecturas
// existentes (API simulada por ruta real); una lectura caida dice "No se pudo leer" (nunca un cero); sin ninguna lectura
// muestra el error con reintento; los agentes sin bitacora dicen "Sin corridas registradas.".
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelPage } from "../src/verticals/licitaciones/pages/Panel.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { cierranEnVentana, convocatoriasAbiertas, corridaKyc, corridaSeguimiento, fechaMasReciente, saludoEnZona, ultimaCorridaPorFuente, zonaEfectiva } from "../src/verticals/licitaciones/lib/resumen.ts";
import type { TenderSummary } from "../src/verticals/licitaciones/lib/tenders-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const CTX: LicitacionesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana María Torres", staffEmail: "ana@example.com" };

type Routes = Record<string, () => { ok?: boolean; body: unknown }>;

function stubFetch(routes: Routes) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace("https://api.test/licitaciones/prop-1", "")}`;
    const handler = routes[key];
    if (!handler) return { ok: false, status: 500, json: async () => ({ error: { message: `sin ruta ${key}` } }) } as unknown as Response;
    const r = handler();
    return { ok: r.ok ?? true, status: r.ok === false ? 500 : 200, json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

function mount(ctx: LicitacionesShellContext = CTX) {
  rendered = renderComponent(
    <MemoryRouter>
      <PanelPage {...ctx} />
    </MemoryRouter>,
  );
}

const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const tender = (id: string, status: string, deadline: string | null) => ({ id, title: `Conv ${id}`, submissionDeadline: deadline, status, contractingBody: "IMSS" });
const texto = () => rendered?.container.textContent ?? "";
/** Tarjeta enlazada (KPI o tile) por parte de su texto. */
const enlace = (parte: string) => [...rendered!.container.querySelectorAll("a")].find((a) => a.textContent?.includes(parte));

const CONECTORES = [
  { id: "compranet", kind: "automated", label: "CompraNet", termsNote: "", cadence: { minIntervalMinutes: 60, note: "" }, liveVerification: { verified: true, note: "" } },
  { id: "manual", kind: "manual", label: "Alta manual", termsNote: "", cadence: { minIntervalMinutes: 0, note: "" }, liveVerification: { verified: false, note: "" } },
];
const CORRIDAS = [
  { id: "r1", source: "compranet", state: "down", startedAt: "2026-09-30T10:00:00Z", finishedAt: "2026-09-30T10:00:01Z", evidence: { message: "caida" } },
  { id: "r2", source: "compranet", state: "ok", startedAt: "2026-10-01T10:00:00Z", finishedAt: "2026-10-01T10:00:05Z", evidence: { message: "ok", coverage: { expected: 10, obtained: 9 } } },
];

const COMPLETAS: Routes = {
  "GET /tenders": () => ({ body: { tenders: [tender("a", "go", hours(48)), tender("b", "won", hours(24)), tender("c", "discovered", null), tender("d", "in_progress", hours(24 * 30))] } }),
  "GET /sources/freshness": () => ({ body: { freshness: [{ source: "compranet", stale: true }, { source: "manual", stale: false }] } }),
  "GET /sources": () => ({ body: { connectors: CONECTORES } }),
  "GET /sources/runs?limit=50": () => ({ body: { runs: CORRIDAS } }),
  "GET /sources/deadline-reminders": () => ({ body: { reminders: [{ acknowledgedAt: null }, { acknowledgedAt: "x" }] } }),
  "GET /tender-change-notifications": () => ({ body: { notifications: [{ acknowledgedAt: null }, { acknowledgedAt: null }] } }),
  "GET /renewals/alerts": () => ({ body: { alerts: [{ status: "pendiente" }] } }),
  "GET /company/documents": () => ({ body: { documents: [{ approvalStatus: "pendiente_aprobacion" }] } }),
  "GET /company/rates": () => ({ body: { rates: [] } }),
  "GET /company/capabilities": () => ({ body: { capabilities: [{ approvalStatus: "pendiente_aprobacion" }] } }),
  "GET /company/experience": () => ({ body: { experience: [] } }),
  "GET /company/signers": () => ({ body: { signers: [{ authorized: true }, { authorized: false }] } }),
};

describe("Resumen de licitaciones (PanelPage)", () => {
  it("pinta saludo con el primer nombre, destacado y KPIs con lo que devuelve la API, y un solo h1", async () => {
    stubFetch(COMPLETAS);
    mount();
    await settle();

    expect(rendered!.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered!.container.querySelector("h1")?.textContent).toMatch(/^(Buenos días|Buenas tardes|Buenas noches), Ana$/);
    expect(texto()).toContain("3 convocatorias abiertas"); // a, c, d (b ganada no cuenta)
    expect(rendered!.container.querySelector('[data-testid="odometro"]')?.getAttribute("aria-label")).toContain("Convocatorias abiertas");
    expect(enlace("Cierran en 7 días")?.textContent).toContain("1"); // solo a (d cae a 30 días; b esta ganada)
    expect(enlace("Propuestas en preparación")?.textContent).toContain("1");
    expect(enlace("Recordatorios de plazo")?.textContent).toContain("1");
    expect(enlace("Cambios de convocatoria")?.textContent).toContain("2");
    expect(enlace("Renovaciones por vencer")?.textContent).toContain("1");
    expect(enlace("Datos por aprobar")?.textContent).toContain("2");
    expect(enlace("Firmantes autorizados")?.textContent).toContain("1");
    expect(enlace("Fuentes obsoletas")?.textContent).toContain("1 de 2");
  });

  it("cada KPI, píldora y tile navega a una ruta real del vertical", async () => {
    stubFetch(COMPLETAS);
    mount();
    await settle();
    const hrefs = new Set([...rendered!.container.querySelectorAll("a")].map((a) => a.getAttribute("href")));
    for (const ruta of ["convocatorias", "seguimiento", "radar-renovaciones", "aprobaciones", "firmantes", "fuentes", "whatsapp", "kyc-69b", "copiloto"]) {
      expect(hrefs.has(`/licitaciones/demo/${ruta}`)).toBe(true);
    }
    expect(enlace("Ver convocatorias")?.getAttribute("href")).toBe("/licitaciones/demo/convocatorias");
    expect(enlace("Ver seguimiento")?.getAttribute("href")).toBe("/licitaciones/demo/seguimiento");
  });

  it("orquestación: la ingesta sale de la frescura real; el resto lleva texto sin cifras inventadas", async () => {
    stubFetch(COMPLETAS);
    mount();
    await settle();
    expect(enlace("Descubrimiento e ingesta")?.textContent).toContain("1 fuente obsoleta de 2");
    expect(enlace("Descubrimiento e ingesta")?.textContent).toContain("Obsoleta");
    expect(enlace("Alertas y recordatorios")?.textContent).toContain("1 recordatorio pendiente · 2 cambios por revisar");
    expect(texto()).toContain("Orquestación de agentes");
    expect(texto()).toContain("Agentes — última corrida");
  });

  it("última corrida: la más reciente por fuente (OK con cobertura) y 'Sin corridas registradas.' para quien no tiene bitácora", async () => {
    stubFetch(COMPLETAS);
    mount();
    await settle();
    const t = texto();
    const compranet = [...rendered!.container.querySelectorAll("div")].find((d) => d.className.includes("px-3 py-2.5") && d.textContent?.startsWith("Ingesta · CompraNet"));
    expect(compranet?.textContent).toContain("OK");
    expect(compranet?.textContent).toContain("9 de 10 resultados");
    expect(compranet?.textContent).not.toContain("Caída");
    const manual = [...rendered!.container.querySelectorAll("div")].find((d) => d.className.includes("px-3 py-2.5") && d.textContent?.startsWith("Ingesta · Alta manual"));
    expect(manual?.textContent).toContain("Sin corridas registradas.");
    for (const agente of ["Extractor de requisitos", "Borrador de junta de aclaraciones", "WhatsApp", "KYC proveedores (69-B)"]) expect(t).toContain(agente);
    expect((t.match(/Sin corridas registradas\./g) ?? []).length).toBe(1 + 5); // alta manual + 5 agentes sin bitacora
  });

  it("una lectura caída dice 'No se pudo leer' (nunca cero) y 'Datos por aprobar' no suma parcial", async () => {
    stubFetch({ ...COMPLETAS, "GET /tender-change-notifications": () => ({ ok: false, body: {} }), "GET /company/rates": () => ({ ok: false, body: {} }), "GET /sources/runs?limit=50": () => ({ ok: false, body: {} }) });
    mount();
    await settle();
    expect(enlace("Cambios de convocatoria")?.textContent).toContain("No se pudo leer");
    expect(enlace("Cambios de convocatoria")?.textContent).not.toMatch(/\b0\b/);
    expect(enlace("Datos por aprobar")?.textContent).toContain("No se pudo leer");
    expect(enlace("Alertas y recordatorios")?.textContent).toContain("No se pudo leer el seguimiento.");
    expect(rendered!.container.querySelector('[data-testid="corridas-sin-lectura"]')?.textContent).toContain("No se pudo leer el registro de corridas");
    // Lo que sí respondió se sigue pintando.
    expect(enlace("Recordatorios de plazo")?.textContent).toContain("1");
  });

  it("sin convocatorias legibles: odómetro y subtítulo dicen 'no disponible', no 0", async () => {
    stubFetch({ ...COMPLETAS, "GET /tenders": () => ({ ok: false, body: {} }) });
    mount();
    await settle();
    expect(texto()).toContain("convocatorias no disponibles");
    expect(rendered!.container.querySelector('[data-testid="odometro"]')?.textContent).toContain("—");
    expect(enlace("Cierran en 7 días")?.textContent).toContain("No se pudo leer");
    expect(enlace("Propuestas en preparación")?.textContent).toContain("No se pudo leer");
  });

  it("si fallan TODAS las lecturas muestra el error con reintento, y reintentar vuelve a leer", async () => {
    const fetchMock = stubFetch({});
    mount();
    await settle();
    expect(texto()).toContain("No se pudo cargar el resumen de licitaciones.");
    const antes = fetchMock.mock.calls.length;
    const reintentar = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reintentar"));
    expect(reintentar).toBeDefined();
    await act(async () => {
      reintentar!.click();
    });
    await settle();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(antes);
  });

  it("muestra el estado de carga antes de que respondan las lecturas", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    mount();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(texto()).toContain("Cargando resumen");
  });
});

const TZ_URL = "GET https://api.test/v1/licitaciones/demo/admin/tenant-config";
const tenantConfig = (timezone: string | null): Routes[string] => () => ({ body: { tenant_config: { organization_id: "org-1", timezone } } });
/** 2026-10-03T06:00Z = 00:00 del 3 de octubre en Ciudad de Mexico (UTC-6) y 08:00 en Madrid (UTC+2). */
const AHORA_FIJO = new Date("2026-10-03T06:00:00Z");
const saludoPintado = () => rendered!.container.querySelector("h1")?.textContent?.split(",")[0];

describe("Resumen de licitaciones: zona horaria de la organizacion (tenant-config)", () => {
  async function montarConZona(rutaZona: Routes[string] | undefined) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AHORA_FIJO);
    stubFetch(rutaZona ? { ...COMPLETAS, [TZ_URL]: rutaZona } : COMPLETAS);
    mount();
    await settle();
  }

  it("usa la zona configurada por la organización para el saludo", async () => {
    await montarConZona(tenantConfig("Europe/Madrid"));
    expect(saludoPintado()).toBe("Buenos días");
  });

  it("timezone null cae a America/Mexico_City", async () => {
    await montarConZona(tenantConfig(null));
    expect(saludoPintado()).toBe("Buenas noches");
  });

  it("si la lectura de tenant-config falla (base sin migrar) cae a America/Mexico_City y el resto se pinta", async () => {
    await montarConZona(() => ({ ok: false, body: {} }));
    expect(saludoPintado()).toBe("Buenas noches");
    expect(enlace("Recordatorios de plazo")?.textContent).toContain("1");
  });

  it("una zona guardada que no es IANA válida cae a America/Mexico_City en vez de romper la pantalla", async () => {
    await montarConZona(tenantConfig("Marte/Olimpo"));
    expect(saludoPintado()).toBe("Buenas noches");
  });
});

describe("Resumen de licitaciones: ultima corrida de KYC 69-B y de seguimiento (registros reales)", () => {
  const tarjeta = (nombre: string) => [...rendered!.container.querySelectorAll("div")].find((d) => d.className.includes("px-3 py-2.5") && d.textContent?.startsWith(nombre));
  const LISTA = { periodo: "2026-09", filas: 1200, ingestadoEn: "2026-10-01T16:00:00Z" };

  it("KYC: con listado ingerido pinta su periodo, filas y fecha real", async () => {
    stubFetch({ ...COMPLETAS, "GET /kyc-69b": () => ({ body: { available: true, lista: LISTA, listaDisponible: true, periodo: "2026-09", fichas: [], alertas: [] } }) });
    mount();
    await settle();
    const k = tarjeta("KYC proveedores (69-B)");
    expect(k?.textContent).toContain("Lista ingerida");
    expect(k?.textContent).toContain("Listado SAT 2026-09");
    expect(k?.textContent).toContain("1200 filas");
    expect(k?.textContent).not.toContain("Sin corridas registradas.");
    expect(k?.querySelector("a")?.getAttribute("href")).toBe("/licitaciones/demo/kyc-69b");
  });

  it("KYC: sin listado (available:false, lista:null) o con la lectura caída, el vacío honesto", async () => {
    for (const ruta of [() => ({ body: { available: false, lista: null, listaDisponible: false, periodo: null, fichas: [], alertas: [] } }), () => ({ body: { available: true, lista: null, listaDisponible: false, periodo: null, fichas: [], alertas: [] } }), () => ({ ok: false, body: {} })]) {
      stubFetch({ ...COMPLETAS, "GET /kyc-69b": ruta });
      mount();
      await settle();
      expect(tarjeta("KYC proveedores (69-B)")?.textContent).toContain("Sin corridas registradas.");
      rendered?.unmount();
      rendered = undefined;
    }
  });

  it("Alertas y recordatorios: la última corrida es el aviso más reciente (createdAt real) y sin avisos dice vacío", async () => {
    stubFetch({
      ...COMPLETAS,
      "GET /sources/deadline-reminders": () => ({ body: { reminders: [{ acknowledgedAt: null, createdAt: "2026-09-29T10:00:00Z" }] } }),
      "GET /tender-change-notifications": () => ({ body: { notifications: [{ acknowledgedAt: null, createdAt: "2026-10-01T10:00:00Z" }] } }),
    });
    mount();
    await settle();
    const a = tarjeta("Alertas y recordatorios");
    expect(a?.textContent).toContain("Último aviso generado");
    expect(a?.textContent).toContain("1 oct");
    rendered?.unmount();
    rendered = undefined;

    stubFetch({ ...COMPLETAS, "GET /sources/deadline-reminders": () => ({ body: { reminders: [] } }), "GET /tender-change-notifications": () => ({ body: { notifications: [] } }) });
    mount();
    await settle();
    expect(tarjeta("Alertas y recordatorios")?.textContent).toContain("Sin corridas registradas.");
  });
});

describe("helpers del Resumen de licitaciones", () => {
  const t = (id: string, status: TenderSummary["status"], deadline: string | null) => ({ id, status, submissionDeadline: deadline }) as TenderSummary;

  it("convocatorias abiertas excluye ganadas, perdidas, canceladas y no-go; la ventana de 7 días excluye pasadas y lejanas", () => {
    const ahora = Date.parse("2026-10-03T12:00:00Z");
    const todas = [t("1", "go", "2026-10-05T00:00:00Z"), t("2", "no_go", "2026-10-05T00:00:00Z"), t("3", "won", null), t("4", "lost", null), t("5", "cancelled", null), t("6", "in_review", "2026-10-02T00:00:00Z"), t("7", "discovered", "2026-11-01T00:00:00Z")];
    const abiertas = convocatoriasAbiertas(todas);
    expect(abiertas.map((x) => x.id)).toEqual(["1", "6", "7"]);
    expect(cierranEnVentana(abiertas, ahora).map((x) => x.id)).toEqual(["1"]);
  });

  it("'cierran en 7 días' no cuenta propuestas ya presentadas (submitted)", () => {
    const ahora = Date.parse("2026-10-03T12:00:00Z");
    const abiertas = convocatoriasAbiertas([t("1", "submitted", "2026-10-05T00:00:00Z"), t("2", "in_progress", "2026-10-05T00:00:00Z")]);
    expect(abiertas.map((x) => x.id)).toEqual(["1", "2"]); // siguen abiertas (sin resultado)...
    expect(cierranEnVentana(abiertas, ahora).map((x) => x.id)).toEqual(["2"]); // ...pero su plazo ya no pide accion
  });

  it("zonaEfectiva: configurada válida, null, vacía o inválida", () => {
    expect(zonaEfectiva("America/Tijuana")).toBe("America/Tijuana");
    expect(zonaEfectiva(null)).toBe("America/Mexico_City");
    expect(zonaEfectiva(undefined)).toBe("America/Mexico_City");
    expect(zonaEfectiva("")).toBe("America/Mexico_City");
    expect(zonaEfectiva("no/es-zona")).toBe("America/Mexico_City");
  });

  it("corridaKyc y corridaSeguimiento: null cuando no hay registro real", () => {
    expect(corridaKyc(null)).toBeNull();
    expect(corridaKyc({ periodo: "2026-09", filas: 1, ingestadoEn: "no-fecha" })).toBeNull();
    expect(corridaKyc({ periodo: "2026-09", filas: 1, ingestadoEn: "2026-10-01T16:00:00Z" })?.meta).toContain("1 fila");
    expect(corridaSeguimiento([])).toBeNull();
    expect(corridaSeguimiento(["basura"])).toBeNull();
    expect(fechaMasReciente(["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "x"])).toBe("2026-10-01T00:00:00Z");
  });

  it("el saludo usa la zona de la organización, no la del navegador", () => {
    // 2026-10-03T03:00Z = 21:00 del 2 de octubre en Ciudad de Mexico (UTC-6) y 11:00 en Madrid.
    const f = new Date("2026-10-03T03:00:00Z");
    expect(saludoEnZona(f, "America/Mexico_City")).toBe("Buenas noches");
    expect(saludoEnZona(f, "Europe/Madrid")).toBe("Buenos días");
    expect(saludoEnZona(new Date("2026-10-03T19:00:00Z"), "America/Mexico_City")).toBe("Buenas tardes");
  });

  it("una fuente en el registro sin corridas queda sin estado; una corrida de fuente no registrada aparece con su id", () => {
    const filas = ultimaCorridaPorFuente(
      [{ id: "a", label: "Fuente A" }] as never,
      [{ id: "r", source: "zzz", state: "captcha_detected", startedAt: "2026-10-01T10:00:00Z", finishedAt: "2026-10-01T10:00:01Z", evidence: { message: "" } }] as never,
    );
    expect(filas[0]).toMatchObject({ source: "a", nombre: "Fuente A" });
    expect(filas[0]!.estado).toBeUndefined();
    expect(filas[1]).toMatchObject({ source: "zzz", nombre: "zzz", estado: { tone: "warning", etiqueta: "Bloqueada por captcha" } });
  });
});
