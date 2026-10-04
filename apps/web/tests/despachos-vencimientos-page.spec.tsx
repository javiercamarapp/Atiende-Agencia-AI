// @vitest-environment jsdom
//
// Smoke test real de <VencimientosPage /> (despachos — vencimientos fiscales)
// enfocado en REQ-r5: `fechaLimite`/`fechaPresentacion` son columnas `date`
// (solo día, sin hora, `001_despachos_schema.sql`) y deben mostrarse con
// `formatFechaSolo`, no con `formatDate` (que las corría un día antes en
// America/Mexico_City -- mismo bug real ya corregido en Cobranza.tsx). Mismo
// patrón de mock de `fetch` que despachos-cobranza-page.spec.tsx.
import { pulsarEnDialogo } from "./test-utils/confirm.ts";
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
  fundamento: "LISR art. 14; art. 12 CFF",
  validarConFiscalista: false,
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

describe("VencimientosPage (despachos) -- calendario fiscal D-26", () => {
  it("muestra el fundamento y la marca 'Validar con fiscalista' solo en las filas que la traen", async () => {
    stubFetch([
      { ...DEADLINE, id: "v1", tipo: "DIOT", fundamento: "RMF regla 4.5.1", validarConFiscalista: true, estado: "pendiente", fechaPresentacion: null },
      { ...DEADLINE, id: "v2", tipo: "ISR", fundamento: "LISR art. 14", validarConFiscalista: false, estado: "pendiente", fechaPresentacion: null },
    ]);
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("RMF regla 4.5.1");
    expect(text).toContain("LISR art. 14");
    expect(text.match(/Validar con fiscalista/g)).toHaveLength(1);
  });

  it("'Escalar vencidos y por vencer' llama al barrido real y muestra el resultado", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/vencimientos/barrido") && init?.method === "POST") {
        return jsonResponse({ evaluados: 1, escalados: [{ id: "v1", tipo: "ISR", periodo: "2026-07", nivel: "nivel_4", correosEncolados: 2 }], yaEscalados: 0, aunNoToca: 0, fallidos: [] });
      }
      if (url.includes("/vencimientos")) return jsonResponse([{ ...DEADLINE, estado: "pendiente", fechaPresentacion: null }]);
      throw new Error(`fetch inesperado en el test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Escalar vencidos y por vencer"));
    expect(boton).toBeDefined();
    await act(async () => {
      boton!.click();
      await flushMicrotasks();
    });
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith("/vencimientos/barrido") && (i as RequestInit)?.method === "POST")).toBe(false);
    await pulsarEnDialogo("Escalar");
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith("/vencimientos/barrido") && (i as RequestInit)?.method === "POST")).toBe(true);
    expect(rendered.container.textContent).toContain("Se escalaron 1 vencimiento(s) (2 correo(s) encolado(s)).");
  });

  it("un error del barrido se muestra, no se traga", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/vencimientos/barrido") && init?.method === "POST") return jsonResponse({ error: "boom" }, false);
        return jsonResponse([]);
      }),
    );
    rendered = renderPage();
    await esperarCarga();
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Escalar vencidos y por vencer"))!;
    await act(async () => {
      boton.click();
      await flushMicrotasks();
    });
    await pulsarEnDialogo("Escalar");
    expect(rendered.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  // UNI-C despachos: escalar y completar son irreversibles -> useConfirm; Cancelar nunca llama a la API.
  for (const [accion, boton, ruta, confirmar] of [
    ["escalar", "Escalar", "/escalar", "Escalar"],
    ["marcar completado", "Marcar completado", "/completar", "Marcar completado"],
  ] as const) {
    it(`${accion}: Cancelar no llama a la API y confirmar si`, async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && url.endsWith(ruta)) {
          return jsonResponse(ruta === "/escalar" ? { escalamiento: { nivel: "nivel_4" }, notificacion: { correosEncolados: 0 } } : {});
        }
        if (url.includes("/vencimientos")) return jsonResponse([{ ...DEADLINE, estado: "pendiente", fechaPresentacion: null }]);
        throw new Error(`fetch inesperado en el test: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const posts = () => fetchMock.mock.calls.filter(([u, i]) => (i as RequestInit | undefined)?.method === "POST" && String(u).endsWith(ruta));
      rendered = renderPage();
      await esperarCarga();
      const abrir = async () => {
        const b = [...rendered!.container.querySelectorAll("tbody button")].find((x) => x.textContent?.trim() === boton) as HTMLButtonElement;
        await act(async () => {
          b.click();
          await flushMicrotasks();
        });
      };
      await abrir();
      await pulsarEnDialogo("Cancelar");
      expect(posts()).toHaveLength(0);
      await abrir();
      await pulsarEnDialogo(confirmar);
      expect(posts()).toHaveLength(1);
    });
  }
});
