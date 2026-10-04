// @vitest-environment jsdom
//
// Paginas de L-03: Fuentes y frescura, Seguimiento y Aprobaciones.
// `fetch` global mockeado por ruta real; se verifican datos reales en pantalla,
// la honestidad de los datos (una lectura que falla nunca se pinta como cero) y que cada boton dispare el metodo/ruta/cuerpo reales.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { FuentesFrescuraPage } from "../src/verticals/licitaciones/pages/FuentesFrescura.tsx";
import { SeguimientoPage } from "../src/verticals/licitaciones/pages/Seguimiento.tsx";
import { DatosEmpresaPage } from "../src/verticals/licitaciones/pages/DatosEmpresa.tsx";
import { AprobacionesPage } from "../src/verticals/licitaciones/pages/Aprobaciones.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: LicitacionesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };
const VIEWER: LicitacionesShellContext = { ...CTX, role: "viewer" };

type Routes = Record<string, (init?: RequestInit) => { ok?: boolean; body: unknown }>;

function stubFetch(routes: Routes) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url.replace("https://api.test/licitaciones/prop-1", "")}`;
    const handler = routes[key];
    if (!handler) return { ok: false, status: 500, json: async () => ({ error: { message: `sin ruta ${key}` } }) } as unknown as Response;
    const r = handler(init);
    return { ok: r.ok ?? true, status: r.ok === false ? 500 : 200, headers: new Headers(), json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

function mount(el: JSX.Element) {
  rendered = renderComponent(<MemoryRouter>{el}</MemoryRouter>);
}

const tender = (id: string, status: string, deadline: string | null) => ({ id, title: `Conv ${id}`, submissionDeadline: deadline, status, contractingBody: "IMSS" });

describe("FuentesFrescuraPage", () => {
  it("muestra fuente obsoleta, 'Nunca' y la corrida con cobertura; no hay botones de accion", async () => {
    stubFetch({
      "GET /sources": () => ({ body: { connectors: [{ id: "nl_ocds", kind: "automated", label: "Nuevo León OCDS", termsNote: "", cadence: { minIntervalMinutes: 60, note: "cada hora" }, liveVerification: { verified: true, note: "probada" } }] } }),
      "GET /sources/freshness": () => ({ body: { freshness: [{ source: "nl_ocds", lastRunState: null, lastSuccessAt: null, staleForMs: null, staleThresholdMs: 1, stale: true }] } }),
      "GET /sources/runs?limit=20": () => ({ body: { runs: [{ id: "r1", source: "nl_ocds", state: "captcha_detected", startedAt: "2026-09-01T10:00:00Z", finishedAt: "2026-09-01T10:00:01Z", evidence: { message: "captcha", coverage: { expected: 10, obtained: 0 } } }] } }),
    });
    mount(<FuentesFrescuraPage {...CTX} />);
    await settle();
    const text = rendered!.container.textContent!;
    expect(text).toContain("Nuevo León OCDS");
    expect(text).toContain("Obsoleta");
    expect(text).toContain("Nunca");
    expect(text).toContain("Verificada");
    expect(text).toContain("Bloqueada por captcha");
    expect(text).toContain("0 de 10");
    expect(rendered!.container.querySelectorAll("button").length).toBe(0);
  });

  it("si falla la frescura, lo dice y mantiene el registro", async () => {
    stubFetch({
      "GET /sources": () => ({ body: { connectors: [{ id: "manual", kind: "manual", label: "Alta manual", termsNote: "", cadence: { minIntervalMinutes: 0, note: "a demanda" }, liveVerification: { verified: false, note: "n/a" } }] } }),
      "GET /sources/runs?limit=20": () => ({ body: { runs: [] } }),
    });
    mount(<FuentesFrescuraPage {...CTX} />);
    await settle();
    const text = rendered!.container.textContent!;
    expect(text).toContain("Alta manual");
    expect(text).toContain("Frescura:");
    expect(text).toContain("No disponible");
    expect(text).toContain("Todavía no hay corridas");
  });
});

describe("SeguimientoPage", () => {
  const reminder = { id: "rem-1", tenderId: "t1", submissionDeadline: "2026-10-05T18:00:00Z", daysRemaining: 1, message: "Cierra mañana", createdAt: "2026-10-04T00:00:00Z", acknowledgedAt: null };
  const change = { id: "chg-1", tenderId: "t1", tenderVersion: 2, reason: "Cambió la junta de aclaraciones", changedFieldNames: ["fecha"], affectedSectionKeys: ["tecnica"], createdAt: "2026-10-04T00:00:00Z", acknowledgedAt: null };
  const base: Routes = {
    "GET /tenders?limit=1&ids=t1": () => ({ body: { tenders: [tender("t1", "go", null)] } }),
    "GET /sources/deadline-reminders": () => ({ body: { reminders: [reminder] } }),
    "GET /tender-change-notifications": () => ({ body: { notifications: [change] } }),
  };

  it("reconocer un recordatorio hace POST a la ruta real y lo marca reconocido", async () => {
    stubFetch({ ...base, "POST /sources/deadline-reminders/rem-1/ack": () => ({ body: { reminder: { ...reminder, acknowledgedAt: "2026-10-04T12:00:00Z" } } }) });
    mount(<SeguimientoPage {...CTX} />);
    await settle();
    expect(rendered!.container.textContent).toContain("Cierra mañana");
    expect(rendered!.container.textContent).toContain("Conv t1");
    const btn = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === "Reconocer")!;
    click(btn);
    await settle();
    const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "POST");
    expect(post?.[0]).toBe("https://api.test/licitaciones/prop-1/sources/deadline-reminders/rem-1/ack");
    // Con el filtro "solo pendientes" activo, el recordatorio reconocido sale de la lista.
    expect(rendered!.container.textContent).toContain("No hay recordatorios pendientes.");
  });

  it("el titulo de un aviso sale de pedir ESA convocatoria por id (aunque la organizacion tenga cientos), nunca de 'todas'", async () => {
    const lejana = { ...reminder, id: "rem-9", tenderId: "t-251" };
    stubFetch({
      "GET /tenders?limit=1&ids=t-251": () => ({ body: { tenders: [tender("t-251", "go", null)] } }),
      "GET /sources/deadline-reminders": () => ({ body: { reminders: [lejana] } }),
      "GET /tender-change-notifications": () => ({ body: { notifications: [] } }),
    });
    mount(<SeguimientoPage {...CTX} />);
    await settle();
    expect(rendered!.container.textContent).toContain("Conv t-251");
    expect(fetchMock.mock.calls.every(([u]) => String(u) !== "https://api.test/licitaciones/prop-1/tenders")).toBe(true);
  });

  it("reconocer un cambio de convocatoria y mostrar el error del servidor si falla", async () => {
    stubFetch({ ...base, "POST /tender-change-notifications/chg-1/acknowledge": () => ({ ok: false, body: { error: { message: "no" } } }) });
    mount(<SeguimientoPage {...CTX} />);
    await settle();
    expect(rendered!.container.textContent).toContain("Secciones afectadas: tecnica");
    const btns = [...rendered!.container.querySelectorAll("button")].filter((b) => b.textContent === "Reconocer");
    click(btns[1]!);
    await settle();
    expect(rendered!.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("un viewer no ve botones de reconocer", async () => {
    stubFetch(base);
    mount(<SeguimientoPage {...VIEWER} />);
    await settle();
    expect([...rendered!.container.querySelectorAll("button")].some((b) => b.textContent === "Reconocer")).toBe(false);
  });
});

describe("AprobacionesPage", () => {
  const routes: Routes = {
    "GET /company/documents": () => ({ body: { documents: [{ id: "d1", type: "acta", label: "Acta constitutiva", expiresAt: null, approvalStatus: "pendiente_aprobacion" }, { id: "d2", type: "rfc", label: "Constancia", expiresAt: null, approvalStatus: "aprobado" }] } }),
    "GET /company/rates": () => ({ body: { rates: [{ id: "r1", concept: "Hora ingeniero", unitPrice: "500.00", currency: "MXN", approvalStatus: "rechazado", validFrom: "2026-01-01", validUntil: null }] } }),
    "GET /company/capabilities": () => ({ body: { capabilities: [] } }),
    "GET /company/experience": () => ({ body: { experience: [] } }),
  };

  it("aprobar un documento hace PATCH real con approvalStatus y lo saca de pendientes", async () => {
    stubFetch({ ...routes, "PATCH /company/documents/d1": (init) => ({ body: { id: "d1", ...JSON.parse(init!.body as string) } }) });
    mount(<AprobacionesPage {...CTX} />);
    await settle();
    expect(rendered!.container.textContent).toContain("Pendientes de aprobación (1)");
    expect(rendered!.container.textContent).toContain("Rechazados (1)");
    click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === "Aprobar")!);
    await settle();
    const patch = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "PATCH")!;
    expect(patch[0]).toBe("https://api.test/licitaciones/prop-1/company/documents/d1");
    expect(JSON.parse((patch[1] as RequestInit).body as string)).toEqual({ approvalStatus: "aprobado" });
    expect(rendered!.container.textContent).toContain("Pendientes de aprobación (0)");
  });

  it("si una lectura falla lo dice y un viewer no ve botones", async () => {
    stubFetch({ ...routes, "GET /company/rates": () => ({ ok: false, body: {} }) });
    mount(<AprobacionesPage {...VIEWER} />);
    await settle();
    expect(rendered!.container.textContent).toContain("Tarifas:");
    expect([...rendered!.container.querySelectorAll("button")].some((b) => b.textContent === "Aprobar")).toBe(false);
  });
});

describe("DatosEmpresaPage ?tab=", () => {
  const vacio: Routes = {
    "GET /company/documents": () => ({ body: { documents: [] } }),
    "GET /company/rates": () => ({ body: { rates: [] } }),
    "GET /company/capabilities": () => ({ body: { capabilities: [] } }),
    "GET /company/experience": () => ({ body: { experience: [] } }),
    "GET /company/signers": () => ({ body: { signers: [{ id: "s1", name: "Luis Pérez", role: "representante_legal", authorized: true }] } }),
  };

  it("?tab=firmantes abre directo la pestaña de firmantes (destino de /firmantes)", async () => {
    stubFetch(vacio);
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/x?tab=firmantes"]}>
        <DatosEmpresaPage {...CTX} />
      </MemoryRouter>,
    );
    await settle();
    expect(rendered.container.textContent).toContain("Luis Pérez");
  });

  it("sin ?tab= (o con uno desconocido) abre Documentos", async () => {
    stubFetch(vacio);
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/x?tab=nada"]}>
        <DatosEmpresaPage {...CTX} />
      </MemoryRouter>,
    );
    await settle();
    expect(rendered.container.textContent).not.toContain("Luis Pérez");
  });
});
