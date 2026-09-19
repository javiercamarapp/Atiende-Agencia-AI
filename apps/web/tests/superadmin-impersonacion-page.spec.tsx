// @vitest-environment jsdom
//
// Smoke tests reales de <SuperAdminImpersonacionPage /> -- mismo patrón que
// superadmin-break-glass-page.spec.tsx.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminImpersonacionPage } from "../src/superadmin/pages/Impersonacion.tsx";
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

function stubFetch(handlers: { sesiones?: unknown; bitacora?: unknown; post?: (url: string, body: unknown) => void }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      handlers.post?.(url, init.body ? JSON.parse(String(init.body)) : null);
      return jsonResponse({ ok: true });
    }
    if (url.includes("/superadmin/impersonacion/sesiones")) return jsonResponse(handlers.sesiones ?? { available: true, sessions: [] });
    if (url.includes("/superadmin/impersonacion/bitacora")) return jsonResponse(handlers.bitacora ?? { available: true, entries: [] });
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<SuperAdminImpersonacionPage apiBaseUrl="https://api.test" token="tok-123" />);
}

describe("SuperAdminImpersonacionPage", () => {
  it("muestra el estado de carga primero, y después el estado vacío real sin sesiones ni bitácora", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando impersonación");

    await esperarCarga();
    expect(rendered.container.textContent).toContain("Impersonación de superadmin");
    expect(rendered.container.textContent).toContain("Todavía no se ha iniciado ninguna sesión");
    expect(rendered.container.textContent).toContain("Sin eventos de impersonación registrados");
  });

  it("estado de error cuando el fetch falla -- nunca se queda atorado en 'Cargando'", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No se pudo cargar el estado de impersonación");
  });

  it("renderiza una sesión activa con su tiempo restante y el botón de terminar", async () => {
    const ahora = Date.now();
    stubFetch({
      sesiones: {
        available: true,
        sessions: [
          {
            id: "s1",
            organizationId: "org-1",
            reason: "Ticket SOP-9001: revisar configuración del checkout público.",
            actorEmail: "superadmin@atiende.ai",
            startedAtMs: ahora,
            expiresAtMs: ahora + 15 * 60_000,
            activa: true,
            remainingMs: 15 * 60_000,
          },
        ],
      },
    });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("org-1");
    expect(rendered.container.textContent).toContain("Activa");
    expect(rendered.container.textContent).toContain("15 min restantes");
    const terminarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Terminar");
    expect(terminarBtn).toBeDefined();
  });

  it("muestra el estado 'no disponible' honesto cuando la base aún no tiene la migración aplicada", async () => {
    stubFetch({ sesiones: { available: false, sessions: [] }, bitacora: { available: false, entries: [] } });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("todavía no está disponible en esta base");
  });

  it("iniciar con motivo corto muestra el error de validación y NO llama al backend", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const iniciarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Iniciar impersonación"));
    expect(iniciarBtn).toBeDefined();
    click(iniciarBtn!);

    const orgInput = document.body.querySelector("#impersonacion-org-id") as HTMLInputElement;
    const motivoInput = document.body.querySelector("#impersonacion-motivo") as HTMLTextAreaElement;
    expect(orgInput).not.toBeNull();
    expect(motivoInput).not.toBeNull();

    changeValue(orgInput, "org-1");
    changeValue(motivoInput, "corto");

    const form = document.body.querySelector("#form-iniciar-impersonacion") as HTMLFormElement;
    await submitForm(form);

    expect(document.body.textContent).toContain("El motivo debe tener al menos 20 caracteres");
    expect(fetchMock.mock.calls.every((call: unknown[]) => (call[1] as RequestInit | undefined)?.method !== "POST")).toBe(true);
  });

  it("iniciar con datos válidos arma el POST correcto (sin durationMinutes -- lo calcula SIEMPRE el servidor) y recarga", async () => {
    let capturedBody: unknown = null;
    stubFetch({
      post: (_url, body) => {
        capturedBody = body;
      },
    });
    rendered = renderPage();
    await esperarCarga();

    const iniciarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Iniciar impersonación"));
    click(iniciarBtn!);

    const orgInput = document.body.querySelector("#impersonacion-org-id") as HTMLInputElement;
    const motivoInput = document.body.querySelector("#impersonacion-motivo") as HTMLTextAreaElement;
    changeValue(orgInput, "org-1");
    changeValue(motivoInput, "Ticket SOP-9001: el tenant reporta que su checkout público falla.");

    const form = document.body.querySelector("#form-iniciar-impersonacion") as HTMLFormElement;
    await submitForm(form);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(capturedBody).toMatchObject({ organizationId: "org-1" });
    expect((capturedBody as { reason: string }).reason).toContain("SOP-9001");
    expect(capturedBody).not.toHaveProperty("durationMinutes");
  });
});
