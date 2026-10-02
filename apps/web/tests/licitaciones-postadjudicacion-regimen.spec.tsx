// @vitest-environment jsdom
//
// L-23 (REQ-050): los formularios de factura e inconformidad de `PostAdjudicacionPage` transportan
// la fecha de publicacion de la convocatoria (opcional) que decide el regimen legal del plazo, y
// muestran el rechazo 422 del servidor (plazo del regimen abrogado sin verificar) en vez de tragarlo.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PostAdjudicacionPage } from "../src/verticals/licitaciones/pages/PostAdjudicacion.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

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

interface PostCapturado {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function stubFetch(opciones: { readonly inconformidad422?: string } = {}): PostCapturado[] {
  const posts: PostCapturado[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        if (url.endsWith("/inconformidad") && opciones.inconformidad422) return { ok: false, status: 422, json: async () => ({ error: "plazo_regimen_no_verificable", message: opciones.inconformidad422 }) } as unknown as Response;
        if (url.endsWith("/contract/invoices")) return jsonResponse(INVOICE, true);
        return jsonResponse(DRAFT, true);
      }
      if (/\/tenders\/tender-1$/.test(url)) return jsonResponse(TENDER);
      if (url.endsWith("/contract/invoices")) return jsonResponse({ invoices: [INVOICE] });
      if (url.endsWith("/contract/receivables")) return jsonResponse(RECEIVABLES);
      if (url.endsWith("/inconformidad")) return jsonResponse({ drafts: [DRAFT] });
      throw new Error(`fetch inesperado en el test: ${url}`);
    }),
  );
  return posts;
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

describe("PostAdjudicacionPage (licitaciones) -- regimen legal por fecha de convocatoria, L-23", () => {
  afterEach(() => {
    rendered?.unmount();
    rendered = undefined;
    vi.unstubAllGlobals();
  });

  it("la factura envia convocatoriaPublicadaEn solo cuando se declara y avisa del regimen", async () => {
    const posts = stubFetch();
    rendered = renderPage();
    await esperarCarga();
    const root = rendered.container;
    expect(root.textContent).toContain("17-abr-2025");
    expect(root.textContent).toContain("validar con abogado");

    changeValue(root.querySelector<HTMLInputElement>("#factura-concepto")!, "Anticipo");
    changeValue(root.querySelector<HTMLInputElement>("#factura-monto")!, "100.00");
    const form = root.querySelector<HTMLFormElement>("#factura-concepto")!.closest("form")!;
    await submitForm(form);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).not.toHaveProperty("convocatoriaPublicadaEn");

    changeValue(root.querySelector<HTMLInputElement>("#factura-concepto")!, "Segunda");
    changeValue(root.querySelector<HTMLInputElement>("#factura-monto")!, "200.00");
    changeValue(root.querySelector<HTMLInputElement>("#factura-convocatoria")!, "2025-04-16");
    await submitForm(form);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toMatchObject({ concepto: "Segunda", amount: "200.00", convocatoriaPublicadaEn: "2025-04-16" });
  });

  it("el borrador de inconformidad envia la fecha de la convocatoria y muestra el 422 del servidor", async () => {
    const posts = stubFetch({ inconformidad422: "La convocatoria se publico el 2025-04-16: validar con abogado." });
    rendered = renderPage();
    await esperarCarga();
    await act(async () => {
      irATabInconformidades(rendered!.container);
    });
    const root = rendered.container;
    changeValue(root.querySelector<HTMLTextAreaElement>("#inc-hechos")!, "Un hecho");
    changeValue(root.querySelector<HTMLTextAreaElement>("#inc-agravios")!, "Un agravio");
    changeValue(root.querySelector<HTMLInputElement>("#inc-fallo")!, "2026-01-05");
    changeValue(root.querySelector<HTMLInputElement>("#inc-convocatoria")!, "2025-04-16");
    await submitForm(root.querySelector<HTMLFormElement>("#inc-hechos")!.closest("form")!);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ falloNotifiedOn: "2026-01-05", convocatoriaPublicadaEn: "2025-04-16" });
    const alerta = root.querySelector('[role="alert"]');
    expect(alerta?.textContent).toContain("validar con abogado");
  });
});
