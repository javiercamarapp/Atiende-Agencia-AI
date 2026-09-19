// @vitest-environment jsdom
//
// Smoke tests de <ImpersonacionBanner /> -- el banner PERMANENTE e
// inconfundible que el Bloque C exige mientras hay una sesión activa.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImpersonacionBanner } from "../src/superadmin/components/ImpersonacionBanner.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

async function esperar(): Promise<void> {
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

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

function renderBanner(): RenderedComponent {
  return renderComponent(<ImpersonacionBanner apiBaseUrl="https://api.test" token="tok-123" />);
}

describe("ImpersonacionBanner", () => {
  it("no renderiza NADA cuando no hay sesión activa", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ available: true, session: null })),
    );
    rendered = renderBanner();
    await esperar();
    expect(rendered.container.textContent).toBe("");
  });

  it("renderiza el banner permanente e inconfundible con el botón de terminar mientras hay sesión activa", async () => {
    const ahora = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          available: true,
          session: {
            id: "s1",
            organizationId: "org-1",
            reason: "Ticket SOP-9001: revisar configuración del checkout público.",
            actorEmail: "superadmin@atiende.ai",
            startedAtMs: ahora,
            expiresAtMs: ahora + 15 * 60_000,
            activa: true,
            remainingMs: 15 * 60_000,
          },
        }),
      ),
    );
    rendered = renderBanner();
    await esperar();

    expect(rendered.container.textContent).toContain("Impersonando (solo lectura)");
    expect(rendered.container.textContent).toContain("org-1");
    const banner = rendered.container.querySelector('[role="alert"]');
    expect(banner).not.toBeNull();
    const terminarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Terminar impersonación"));
    expect(terminarBtn).toBeDefined();
  });

  it("no revienta cuando el fetch falla -- simplemente no muestra el banner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    rendered = renderBanner();
    await esperar();
    expect(rendered.container.textContent).toBe("");
  });

  it("hallazgo no bloqueante corregido: deja de sondear (setInterval) en cuanto available:false (base sin migrar) -- nunca sigue generando un 42883 nuevo cada 30s", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ available: false, session: null }));
      vi.stubGlobal("fetch", fetchMock);
      rendered = renderBanner();
      await esperar();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Dos vueltas completas del intervalo de 30s -- si el poll no se hubiera
      // detenido, esto habría disparado 2 llamadas más (3 en total).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
