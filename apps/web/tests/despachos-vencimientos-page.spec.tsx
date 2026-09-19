// @vitest-environment jsdom
//
// Smoke test real de <VencimientosPage /> (despachos — vencimientos fiscales)
// enfocado en REQ-r5: `fechaLimite`/`fechaPresentacion` son columnas `date`
// (solo día, sin hora, `001_despachos_schema.sql`) y deben mostrarse con
// `formatFechaSolo`, no con `formatDate` (que las corría un día antes en
// America/Mexico_City -- mismo bug real ya corregido en Cobranza.tsx). Mismo
// patrón de mock de `fetch` que despachos-cobranza-page.spec.tsx.
import { act } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VencimientosPage } from "../src/verticals/despachos/pages/Vencimientos.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import type { FiscalDeadline } from "../src/verticals/despachos/lib/vencimientos-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const CTX: DespachosShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "admin",
  staffFullName: "Contador Demo",
  staffEmail: "contador@example.com",
};

const DEADLINE: FiscalDeadline = {
  id: "venc-1",
  tipo: "IVA",
  periodo: "2026-07",
  fechaLimite: "2026-08-15",
  prioridad: "alta",
  estado: "completado",
  fechaPresentacion: "2026-08-10",
  comprobanteUrl: null,
  diasRestantes: -4,
  creadoEn: "2026-08-01T12:00:00.000Z",
};

function stubFetch(deadlines: readonly FiscalDeadline[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/vencimientos")) return jsonResponse(deadlines);
      throw new Error(`fetch inesperado en el test: ${url}`);
    }),
  );
}

function renderPage(): RenderedComponent {
  return renderComponent(<VencimientosPage {...CTX} />);
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("VencimientosPage (despachos) -- fechaLimite/fechaPresentacion (columna `date`, solo día)", () => {
  const TZ_ORIGINAL = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = "America/Mexico_City";
  });

  afterAll(() => {
    if (TZ_ORIGINAL === undefined) delete process.env.TZ;
    else process.env.TZ = TZ_ORIGINAL;
  });

  it("fechaLimite '2026-08-15' se muestra como 15 ago, nunca 14 ago, en America/Mexico_City", async () => {
    stubFetch([DEADLINE]);
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("15 ago 2026");
    expect(text).not.toContain("14 ago 2026");
  });

  it("fechaPresentacion '2026-08-10' se muestra como 10 ago, nunca 9 ago, en America/Mexico_City", async () => {
    stubFetch([DEADLINE]);
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Presentado 10 ago 2026");
    expect(text).not.toContain("Presentado 9 ago 2026");
  });
});
