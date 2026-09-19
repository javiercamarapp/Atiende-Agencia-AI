// @vitest-environment jsdom
//
// Smoke tests reales de <ConvocatoriaDetallePage /> (licitaciones — la decisión
// real de negocio del vertical: aprobar/rechazar una convocatoria go/no-go).
// Mismo patrón que despachos-cobranza-page.spec.tsx: `fetch` global mockeado por
// ruta real contra go-no-go-client.ts (+ tenders/matching/checklist/resolution-
// client.ts, que la página carga en paralelo), estados de carga/error, datos
// reales (historial de decisiones), y la interacción principal (registrar una
// decisión Go/No-go) verificando método/ruta/cuerpo reales. La página usa
// `useParams<{tenderId}>()`, así que se monta con `<Routes>`/`<Route
// path=":tenderId">`, no solo `<MemoryRouter>` a secas.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConvocatoriaDetallePage } from "../src/verticals/licitaciones/pages/ConvocatoriaDetalle.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const CTX: LicitacionesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "Analista Demo",
  staffEmail: "analista@example.com",
};

const TENDER = {
  id: "tender-1",
  organizationId: "org-1",
  title: "Suministro de equipo de cómputo",
  submissionDeadline: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  source: "nuevo_leon",
  externalId: "NL-2026-001",
  contractingBody: "Secretaría de Administración",
  cpvCodes: [],
  budgetAmount: 500000,
  currency: "MXN",
  state: "Nuevo León",
  procedureTypeRaw: "Licitación pública",
  status: "matched" as const,
};

const MATCH = { tenderId: "tender-1", score: 78, criteria: [], eligibility: { status: "elegible" as const, criteria: [] } };
const DECISION_PREVIA = { id: "dec-1", organizationId: "org-1", tenderId: "tender-1", decision: "go" as const, reasons: ["Encaja con el perfil"], matchScore: 78, matchEligibilityStatus: "elegible" as const, matchInputsHash: "hash1", decidedBy: "user-1", decidedAt: "2026-09-10T00:00:00.000Z" };

interface Handlers {
  decisions?: readonly (typeof DECISION_PREVIA)[] | (() => readonly (typeof DECISION_PREVIA)[]);
  tenderOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && /\/tenders\/tender-1$/.test(url)) return jsonResponse(TENDER, handlers.tenderOk ?? true);
    if (method === "GET" && url.endsWith("/matching")) return jsonResponse(MATCH);
    if (method === "GET" && url.endsWith("/checklist")) return jsonResponse({ overallStatus: "verde", items: [] });
    if (method === "GET" && url.endsWith("/resolution")) return jsonResponse({ resolutions: [] });
    if (method === "GET" && url.endsWith("/go-no-go")) {
      const list = typeof handlers.decisions === "function" ? handlers.decisions() : (handlers.decisions ?? []);
      return jsonResponse({ decisions: list });
    }
    if (method === "POST" && url.endsWith("/go-no-go")) return jsonResponse({ ...DECISION_PREVIA, id: "dec-nueva" });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={["/licitaciones/demo/convocatorias/tender-1"]}>
      <Routes>
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId" element={<ConvocatoriaDetallePage {...CTX} />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function irATabGoNoGo(root: HTMLElement) {
  const trigger = [...root.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Go / No-go")!;
  trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("ConvocatoriaDetallePage (licitaciones)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({ decisions: [] });
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando convocatoria");
  });

  it("estado de error real cuando el fetch del tender falla — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ decisions: [], tenderOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando convocatoria");
    expect(rendered.container.textContent).toContain("No se pudo cargar");
  });

  it("renderiza datos reales de la convocatoria: título, entidad y presupuesto formateado", async () => {
    stubFetch({ decisions: [] });
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Suministro de equipo de cómputo");
    expect(text).toContain("Secretaría de Administración");
    expect(text).toContain("500,000");
  });

  it("renderiza el historial real de decisiones go/no-go", async () => {
    stubFetch({ decisions: [DECISION_PREVIA] });
    rendered = renderPage();
    await esperarCarga();
    await act(async () => {
      irATabGoNoGo(rendered!.container);
    });
    const text = rendered.container.textContent!;
    expect(text).toContain("GO");
    expect(text).toContain("Encaja con el perfil");
  });

  it("'Marcar Go' sin motivos: muestra error de validación real y NUNCA llama a la API", async () => {
    stubFetch({ decisions: [] });
    rendered = renderPage();
    await esperarCarga();
    await act(async () => {
      irATabGoNoGo(rendered!.container);
    });

    const callsAntes = fetchMock.mock.calls.length;
    const marcarGoBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Marcar Go")!;
    await act(async () => {
      marcarGoBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });

    expect(rendered.container.textContent).toContain("Escribe al menos un motivo");
    expect(fetchMock.mock.calls.length).toBe(callsAntes);
  });

  it("'Marcar Go' con motivos reales: POST .../tenders/tender-1/go-no-go con {decision:'go', reasons} reales y recarga", async () => {
    let current: readonly (typeof DECISION_PREVIA)[] = [];
    stubFetch({ decisions: () => current });
    rendered = renderPage();
    await esperarCarga();
    await act(async () => {
      irATabGoNoGo(rendered!.container);
    });

    changeValue(rendered.container.querySelector("#go-no-go-motivos") as HTMLTextAreaElement, "Margen atractivo\nCapacidad técnica suficiente");
    current = [DECISION_PREVIA];

    const marcarGoBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Marcar Go")!;
    await act(async () => {
      marcarGoBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "https://api.test/licitaciones/prop-1/tenders/tender-1/go-no-go" && init?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ decision: "go", reasons: ["Margen atractivo", "Capacidad técnica suficiente"] });
  });

  it("'Marcar No-go' con motivos reales: POST .../go-no-go con {decision:'no_go', reasons} reales", async () => {
    stubFetch({ decisions: [] });
    rendered = renderPage();
    await esperarCarga();
    await act(async () => {
      irATabGoNoGo(rendered!.container);
    });

    changeValue(rendered.container.querySelector("#go-no-go-motivos") as HTMLTextAreaElement, "Fuera de nuestra capacidad");

    const marcarNoGoBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Marcar No-go")!;
    await act(async () => {
      marcarNoGoBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "https://api.test/licitaciones/prop-1/tenders/tender-1/go-no-go" && init?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ decision: "no_go", reasons: ["Fuera de nuestra capacidad"] });
  });

  it("un rol sin permiso (viewer) NUNCA ve el formulario de decisión, solo el aviso de que no puede decidir", async () => {
    stubFetch({ decisions: [] });
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/licitaciones/demo/convocatorias/tender-1"]}>
        <Routes>
          <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId" element={<ConvocatoriaDetallePage {...CTX} role="viewer" />} />
        </Routes>
      </MemoryRouter>,
    );
    await esperarCarga();
    await act(async () => {
      irATabGoNoGo(rendered!.container);
    });
    expect(rendered.container.querySelector("#go-no-go-motivos")).toBeNull();
    expect(rendered.container.textContent).toContain("Tu rol (viewer) no puede tomar decisiones go/no-go.");
  });
});
