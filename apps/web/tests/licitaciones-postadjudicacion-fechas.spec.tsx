// @vitest-environment jsdom
//
// REQ-r5: `PostAdjudicacionPage` formateaba `receivables.asOfDate`,
// `invoice.invoiceVerifiedOn`, `invoice.dueDate` y `draft.plazo.fechaLimite`
// (todas columnas `date`/valores "YYYY-MM-DD" de solo día, ver
// 013_contract_billing.sql) con `formatDate(\`${valor}T00:00:00Z\`)` --
// `formatDate` (licitaciones/lib/format.ts) formatea sin fijar `timeZone`
// (usa la zona LOCAL del navegador), así que anclar a medianoche UTC y
// formatear en America/Mexico_City (UTC-6) pintaba el día ANTERIOR. Mismo
// bug real que Cobranza.tsx (despachos), encontrado durante el barrido de
// esta ronda. Ahora usa `formatFechaSolo` (apps/web/src/lib/formato-fecha.ts).
//
// La página usa `useParams<{tenderId}>()` -- se monta con `<Routes>`/`<Route
// path=":tenderId">`, mismo patrón que
// licitaciones-convocatoria-detalle-page.spec.tsx.
import { act } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PostAdjudicacionPage } from "../src/verticals/licitaciones/pages/PostAdjudicacion.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

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
  status: "won" as const,
};

const INVOICE = {
  id: "inv-1",
  contractId: "contract-1",
  concepto: "Primera exhibición",
  amount: "12345.67",
  invoiceVerifiedOn: "2026-08-15",
  dueDate: "2026-09-10",
  legalReference: "Art. 73 LAASSP",
  paidAt: null,
  status: "pendiente" as const,
  createdBy: "user-1",
  createdAt: "2026-08-15T18:00:00.000Z",
};

const RECEIVABLES = {
  asOfDate: "2026-08-20",
  totalPending: "12345.67",
  totalOverdue: "0",
  countPending: 1,
  countOverdue: 0,
  invoices: [INVOICE],
};

const DRAFT = {
  id: "draft-1",
  version: 1,
  tenderId: "tender-1",
  status: "borrador" as const,
  contentHash: "hash-1",
  hechos: ["Hecho 1"],
  agravios: ["Agravio 1"],
  pruebas: ["Prueba 1"],
  fundamentos: [],
  plazo: { fechaLimite: "2026-08-12", diasHabiles: 6 },
  viability: "viable" as const,
  viabilityRecommendation: "Recomendación de viabilidad de prueba.",
  disclaimer: "Este borrador requiere revisión humana antes de presentarse.",
  reviewedBy: null,
  reviewedAt: null,
  createdBy: "user-1",
  createdAt: "2026-08-06T12:00:00.000Z",
};

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (/\/tenders\/tender-1$/.test(url)) return jsonResponse(TENDER);
      if (url.endsWith("/contract/invoices")) return jsonResponse({ invoices: [INVOICE] });
      if (url.endsWith("/contract/receivables")) return jsonResponse(RECEIVABLES);
      if (url.endsWith("/inconformidad")) return jsonResponse({ drafts: [DRAFT] });
      throw new Error(`fetch inesperado en el test: ${url}`);
    }),
  );
}

/** `TabsContent value="inconformidades"` (Radix) no se monta hasta activar esa
 * pestaña -- mismo patrón que licitaciones-convocatoria-detalle-page.spec.tsx. */
function irATabInconformidades(root: HTMLElement) {
  const trigger = [...root.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Inconformidades")!;
  trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={["/licitaciones/demo/post-adjudicacion/tender-1"]}>
      <Routes>
        <Route path="/licitaciones/:orgSlug/post-adjudicacion/:tenderId" element={<PostAdjudicacionPage {...CTX} />} />
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

describe("PostAdjudicacionPage (licitaciones) -- fechas de solo-día de facturación/inconformidad, REQ-r5", () => {
  const TZ_ORIGINAL = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = "America/Mexico_City";
  });

  afterAll(() => {
    if (TZ_ORIGINAL === undefined) delete process.env.TZ;
    else process.env.TZ = TZ_ORIGINAL;
  });

  afterEach(() => {
    rendered?.unmount();
    rendered = undefined;
    vi.unstubAllGlobals();
  });

  it("asOfDate/invoiceVerifiedOn/dueDate/fechaLimite se muestran en su día real, nunca un día antes, en America/Mexico_City", async () => {
    stubFetch();
    rendered = renderPage();
    await esperarCarga();

    // Pestaña "Cobranza" (default): asOfDate/invoiceVerifiedOn/dueDate.
    const textCobranza = rendered.container.textContent!;
    expect(textCobranza).toContain("20 ago 2026"); // receivables.asOfDate
    expect(textCobranza).not.toContain("19 ago 2026");

    expect(textCobranza).toContain("15 ago 2026"); // invoice.invoiceVerifiedOn
    expect(textCobranza).not.toContain("14 ago 2026");

    expect(textCobranza).toContain("10 sep 2026"); // invoice.dueDate
    expect(textCobranza).not.toContain("9 sep 2026");

    // Pestaña "Inconformidades" (Radix no monta su contenido hasta activarla):
    // draft.plazo.fechaLimite.
    await act(async () => {
      irATabInconformidades(rendered!.container);
    });
    const textInconformidades = rendered.container.textContent!;
    expect(textInconformidades).toContain("12 ago 2026"); // draft.plazo.fechaLimite
    expect(textInconformidades).not.toContain("11 ago 2026");
  });

  it("el default de 'fecha de verificación' de una factura nueva es el día de hoy en CDMX, no en UTC", async () => {
    vi.useFakeTimers();
    // 22:00 hora de CDMX == 04:00 UTC del día siguiente.
    vi.setSystemTime(new Date("2026-01-02T04:00:00.000Z"));
    stubFetch();
    rendered = renderPage();
    await esperarCarga();
    const input = rendered.container.querySelector<HTMLInputElement>("#factura-verificacion");
    expect(input?.value).toBe("2026-01-01");
    vi.useRealTimers();
  });
});
