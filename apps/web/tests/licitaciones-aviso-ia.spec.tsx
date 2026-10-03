// @vitest-environment jsdom
//
// L-33 (REQ-115): el aviso de uso de IA aparece en Requisitos y Propuesta tecnica SOLO cuando la API devuelve
// requisitos extraidos por el modelo (`extractedBy: "llm"`) y nunca cuando todo vino de reglas o no hay requisitos.
// (Junta: ver licitaciones-sala-guerra-page.spec.tsx.) `fetch` global simulado por ruta real.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AvisoIa, AVISO_IA_ETIQUETA } from "../src/verticals/licitaciones/components/AvisoIa.tsx";
import { RequisitosConvocatoriaPage } from "../src/verticals/licitaciones/pages/RequisitosConvocatoria.tsx";
import { PropuestaTecnicaPage } from "../src/verticals/licitaciones/pages/PropuestaTecnica.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: LicitacionesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };

const TENDER = { id: "t1", organizationId: "org-1", title: "Rehabilitacion de avenida", submissionDeadline: null, updatedAt: "2026-10-01T10:00:00.000Z", source: null, externalId: null, contractingBody: null, cpvCodes: [], budgetAmount: null, currency: null, state: null, procedureTypeRaw: null, status: "discovered" };

const item = (id: string, extractedBy: "rule" | "llm") => ({
  id,
  documentId: "doc-1",
  text: `Requisito ${id}`,
  requirementKind: "tecnico",
  obligatoriedad: "obligatorio",
  topicKey: null,
  requiredEvidence: [],
  extractedBy,
  page: 3,
  clause: "6.2",
  responsibleRole: "analyst",
  deadline: null,
  status: "pendiente",
  confidence: extractedBy === "llm" ? 0.82 : null,
});

function stubFetch(items: readonly unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ruta = url.replace("https://api.test/licitaciones/prop-1", "");
      const cuerpo =
        ruta === "/tenders/t1" ? TENDER : ruta === "/tenders/t1/requirements" ? { items } : ruta === "/tenders/t1/proposal" ? { id: "p1", tenderId: "t1", title: "Propuesta", ivaRate: 0.16, economicTotals: null, generationReport: null, correlationId: null, createdAt: "2026-10-01T10:00:00.000Z" } : null;
      if (cuerpo === null) return { ok: false, status: 404, json: async () => ({ message: `sin ruta ${ruta}` }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => cuerpo } as unknown as Response;
    }),
  );
}

async function montar(el: JSX.Element) {
  rendered = renderComponent(
    <MemoryRouter initialEntries={["/c/t1"]}>
      <Routes>
        <Route path="/c/:tenderId" element={el} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

const aviso = () => rendered!.container.querySelector(`[role="note"][aria-label="${AVISO_IA_ETIQUETA}"]`);

describe("AvisoIa", () => {
  it("dice que es IA, para que sirvio y que una persona debe revisarlo", () => {
    rendered = renderComponent(<AvisoIa proposito="Los borradores fueron redactados con IA." />);
    const nota = aviso()!;
    expect(nota).not.toBeNull();
    expect(nota.textContent).toContain("Contenido asistido por inteligencia artificial");
    expect(nota.textContent).toContain("Los borradores fueron redactados con IA.");
    expect(nota.textContent).toContain("una persona debe revisarlo y aprobarlo");
  });
});

describe("RequisitosConvocatoriaPage -- aviso de IA", () => {
  it("con requisitos extraidos por el modelo muestra el aviso y cuenta solo los de IA", async () => {
    stubFetch([item("a", "llm"), item("b", "rule"), item("c", "llm")]);
    await montar(<RequisitosConvocatoriaPage {...CTX} />);
    expect(aviso()).not.toBeNull();
    expect(aviso()!.textContent).toContain("2 requisitos fueron extraídos de las bases con inteligencia artificial");
  });

  it("con un solo requisito de IA usa el singular", async () => {
    stubFetch([item("a", "llm")]);
    await montar(<RequisitosConvocatoriaPage {...CTX} />);
    expect(aviso()!.textContent).toContain("1 requisito fue extraído de las bases con inteligencia artificial");
  });

  it("si todo se extrajo por reglas NO afirma IA", async () => {
    stubFetch([item("a", "rule"), item("b", "rule")]);
    await montar(<RequisitosConvocatoriaPage {...CTX} />);
    expect(rendered!.container.textContent).toContain("Requisito a");
    expect(aviso()).toBeNull();
    expect(rendered!.container.textContent).not.toContain("inteligencia artificial");
  });

  it("sin requisitos no hay aviso", async () => {
    stubFetch([]);
    await montar(<RequisitosConvocatoriaPage {...CTX} />);
    expect(aviso()).toBeNull();
  });
});

describe("PropuestaTecnicaPage -- aviso de IA", () => {
  it("si parte de los requisitos vino del modelo, avisa y aclara que las secciones se redactan con plantillas", async () => {
    stubFetch([item("a", "llm"), item("b", "rule")]);
    await montar(<PropuestaTecnicaPage {...CTX} />);
    expect(aviso()).not.toBeNull();
    expect(aviso()!.textContent).toContain("sin generar texto con IA");
  });

  it("si todos los requisitos vinieron de reglas, no hay aviso", async () => {
    stubFetch([item("a", "rule")]);
    await montar(<PropuestaTecnicaPage {...CTX} />);
    // La pantalla cargo con requisitos tecnicos (no es el estado vacio) y aun asi no declara IA.
    expect(rendered!.container.textContent).toContain("Generar propuesta técnica");
    expect(rendered!.container.textContent).not.toContain("Todavía no hay requisitos técnicos");
    expect(aviso()).toBeNull();
  });

  it("sin requisitos tecnicos no hay aviso", async () => {
    stubFetch([]);
    await montar(<PropuestaTecnicaPage {...CTX} />);
    expect(aviso()).toBeNull();
  });
});
