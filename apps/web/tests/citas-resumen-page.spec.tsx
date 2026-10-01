// @vitest-environment jsdom
//
// Smoke test real de <ResumenPage /> (citas, C-05): carga, cifras reales, error honesto.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumenPage } from "../src/verticals/citas/pages/Resumen.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX = { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", orgId: "org-1", role: "owner", staffFullName: "Sam", staffEmail: "sam@example.com" } as CitasShellContext;

const BODY = {
  timezone: "America/Merida",
  generated_at: "2026-09-30T05:00:00.000Z",
  today: { date: "2026-09-29", total: 3, by_status: { pending: 1, confirmed: 2, completed: 0, cancelled: 1, no_show: 0 } },
  week: { from_date: "2026-09-28", to_date: "2026-10-04", total: 9, by_status: { pending: 2, confirmed: 5, completed: 2, cancelled: 1, no_show: 0 } },
  pending_to_confirm: 4,
  no_shows_last_30_days: 2,
  new_customers_last_30_days: 7,
};

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function render() {
  return renderComponent(
    <MemoryRouter>
      <ResumenPage {...CTX} />
    </MemoryRouter>,
  );
}

describe("ResumenPage (citas)", () => {
  it("muestra las cifras reales del servidor, el día del negocio y el enlace a la agenda", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => BODY }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    rendered = render();
    await esperar();

    const text = rendered.container.textContent ?? "";
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://api.test/v1/citas/properties/prop-1/resumen");
    expect(text).toContain("Citas hoy");
    expect(text).toContain("Citas esta semana");
    expect(text).toContain("Por confirmar");
    expect(text).toContain("No asistieron");
    expect(text).toContain("Clientes nuevos");
    expect(text).toContain("29 de septiembre");
    expect(text).toContain("America/Merida");
    expect(rendered.container.querySelector('a[href="/citas/demo/agenda"]')).not.toBeNull();
  });

  it("si la carga falla muestra el error y NINGUNA cifra inventada", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ message: "Error interno" }) }) as unknown as Response));
    rendered = render();
    await esperar();

    const text = rendered.container.textContent ?? "";
    expect(text).toContain("No se pudo cargar");
    expect(text).not.toContain("Citas hoy");
  });
});
