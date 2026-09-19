// @vitest-environment jsdom
//
// Smoke tests reales de <SuperAdminBreakGlassPage /> -- mismo patrón que
// superadmin-gasto-api-page.spec.tsx: `renderComponent`/`changeValue`/
// `submitForm`/`click` de ./test-utils/render.tsx, `fetch` global mockeado
// (este componente llama `fetch` directo, sin cliente aparte).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminBreakGlassPage } from "../src/superadmin/pages/BreakGlass.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

function stubFetch(handlers: {
  sesiones?: unknown;
  bitacora?: unknown;
  post?: (url: string, body: unknown) => void;
  reservas?: unknown;
}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      handlers.post?.(url, init.body ? JSON.parse(String(init.body)) : null);
      return jsonResponse({ ok: true });
    }
    if (url.includes("/superadmin/break-glass/sesiones")) return jsonResponse(handlers.sesiones ?? { sessions: [] });
    if (url.includes("/superadmin/break-glass/bitacora")) return jsonResponse(handlers.bitacora ?? { entries: [] });
    if (url.includes("/reservas")) return jsonResponse(handlers.reservas ?? { reservas: [] });
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<SuperAdminBreakGlassPage apiBaseUrl="https://api.test" token="tok-123" />);
}

describe("SuperAdminBreakGlassPage", () => {
  it("muestra el estado de carga primero, y después el estado vacío real sin accesos ni bitácora", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando romper-cristal");

    await esperarCarga();
    expect(rendered.container.textContent).toContain("Romper cristal");
    expect(rendered.container.textContent).toContain("Todavía no has abierto ningún acceso");
    expect(rendered.container.textContent).toContain("Sin lecturas de romper-cristal registradas");
  });

  it("estado de error cuando el fetch falla -- nunca se queda atorado en 'Cargando'", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No se pudo cargar el estado de romper-cristal");
  });

  it("renderiza una sesión activa con su tiempo restante y el botón de cerrar", async () => {
    const ahora = Date.now();
    stubFetch({
      sesiones: {
        sessions: [
          {
            id: "s1",
            organizationId: "org-1",
            reason: "Ticket SOP-4821: investigar cobro duplicado.",
            openedAtMs: ahora,
            expiresAtMs: ahora + 30 * 60_000,
            closedAtMs: null,
            closedBy: null,
            activa: true,
            remainingMs: 30 * 60_000,
          },
        ],
      },
    });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("org-1");
    expect(rendered.container.textContent).toContain("Activa");
    expect(rendered.container.textContent).toContain("30min restantes");
    const cerrarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cerrar");
    expect(cerrarBtn).toBeDefined();
  });

  it("renderiza la bitácora con el resumen de resultado", async () => {
    stubFetch({
      bitacora: {
        entries: [
          {
            id: "e1",
            organizationId: "org-1",
            reason: "Ticket SOP-4821.",
            resourceType: "reservas",
            resourceScope: {},
            resultSummary: { total: 3 },
            occurredAtMs: Date.now(),
            seq: 1,
            hash: "abc",
          },
        ],
      },
    });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("reservas");
    expect(rendered.container.textContent).toContain("3 registro(s)");
  });

  it("abrir un acceso con motivo corto muestra el error de validación y NO llama al backend", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const abrirBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Abrir acceso de emergencia"));
    expect(abrirBtn).toBeDefined();
    click(abrirBtn!);

    const orgInput = document.body.querySelector("#break-glass-org-id") as HTMLInputElement;
    const motivoInput = document.body.querySelector("#break-glass-motivo") as HTMLTextAreaElement;
    expect(orgInput).not.toBeNull();
    expect(motivoInput).not.toBeNull();

    changeValue(orgInput, "org-1");
    changeValue(motivoInput, "corto");

    const form = document.body.querySelector("#form-abrir-break-glass") as HTMLFormElement;
    await submitForm(form);

    expect(document.body.textContent).toContain("El motivo debe tener al menos 20 caracteres");
    expect(fetchMock.mock.calls.every((call: unknown[]) => (call[1] as RequestInit | undefined)?.method !== "POST")).toBe(true);
  });

  it("abrir un acceso válido arma el POST correcto y recarga", async () => {
    let capturedBody: unknown = null;
    stubFetch({
      post: (_url, body) => {
        capturedBody = body;
      },
    });
    rendered = renderPage();
    await esperarCarga();

    const abrirBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Abrir acceso de emergencia"));
    click(abrirBtn!);

    const orgInput = document.body.querySelector("#break-glass-org-id") as HTMLInputElement;
    const motivoInput = document.body.querySelector("#break-glass-motivo") as HTMLTextAreaElement;
    changeValue(orgInput, "org-1");
    changeValue(motivoInput, "Ticket SOP-4821: investigar un cobro duplicado reportado por el tenant.");

    const form = document.body.querySelector("#form-abrir-break-glass") as HTMLFormElement;
    await submitForm(form);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(capturedBody).toMatchObject({ organizationId: "org-1", durationMinutes: 30 });
    expect((capturedBody as { reason: string }).reason).toContain("SOP-4821");
  });
});
