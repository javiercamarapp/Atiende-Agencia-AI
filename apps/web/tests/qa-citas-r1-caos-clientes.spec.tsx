// @vitest-environment jsdom
//
// QA-citas-R1-caos-15: en Clientes, el error de una carga fallida quedaba pegado aunque la siguiente busqueda ya respondio, no habia Reintentar y cada
// tecla disparaba una peticion.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSQUEDA_DEBOUNCE_MS, ClientesListPage } from "../src/verticals/citas/pages/Clientes.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ctx = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", orgId: "org-1", role: "staff", staffFullName: "Sam", staffEmail: "s@example.com" } as CitasShellContext;
const jsonResponse = (body: unknown, status = 200): Response => ({ ok: status < 300, status, json: async () => body }) as unknown as Response;
const pagina = (nombres: string[]) => ({ customers: nombres.map((n, i) => ({ id: `c${i}`, full_name: n, phone: `55000000${i}`, email: null })), total: nombres.length, next_offset: null });

async function avanzar(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("QA-citas-R1-caos-15: Clientes", () => {
  it("el error de una carga fallida se apaga cuando la siguiente busqueda responde; Reintentar existe y funciona; la busqueda tiene debounce", async () => {
    vi.useFakeTimers();
    let falla = true;
    const f = vi.fn(async (url: string) => {
      const q = new URL(url).searchParams.get("search");
      if (falla) return jsonResponse({ message: "Falla inyectada 503" }, 503);
      return jsonResponse(pagina(q ? [`${q} Pech`] : ["Beto", "Ana"]));
    });
    vi.stubGlobal("fetch", f);
    rendered = renderComponent(
      <MemoryRouter>
        <ClientesListPage {...ctx} />
      </MemoryRouter>,
    );
    await avanzar(0);
    expect(rendered.container.textContent).toContain("Falla inyectada 503");
    // Reintentar con el servidor ya sano.
    falla = false;
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reintentar"))!);
    await avanzar(0);
    expect(rendered.container.textContent).not.toContain("Falla inyectada 503");
    expect(rendered.container.textContent).toContain("Beto");

    // Tecleo "Ana" letra por letra: una sola busqueda, no tres.
    const llamadasAntes = f.mock.calls.length;
    const input = rendered.container.querySelector("#citas-clientes-buscar") as HTMLInputElement;
    for (const v of ["A", "An", "Ana"]) {
      changeValue(input, v);
      await avanzar(50);
    }
    expect(f.mock.calls.length).toBe(llamadasAntes);
    await avanzar(BUSQUEDA_DEBOUNCE_MS);
    expect(f.mock.calls.length).toBe(llamadasAntes + 1);
    expect(new URL(f.mock.calls.at(-1)![0]).searchParams.get("search")).toBe("Ana");
    expect(rendered.container.textContent).toContain("Ana Pech");
  });

  it("si la busqueda siguiente falla tras una exitosa, el error aparece SIN la lista de la busqueda anterior", async () => {
    vi.useFakeTimers();
    let falla = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (falla ? jsonResponse({ message: "Falla 503" }, 503) : jsonResponse(pagina(["Beto"])))),
    );
    rendered = renderComponent(
      <MemoryRouter>
        <ClientesListPage {...ctx} />
      </MemoryRouter>,
    );
    await avanzar(0);
    expect(rendered.container.textContent).toContain("Beto");
    falla = true;
    changeValue(rendered.container.querySelector("#citas-clientes-buscar") as HTMLInputElement, "Zeta");
    await avanzar(BUSQUEDA_DEBOUNCE_MS + 1);
    expect(rendered.container.textContent).toContain("Falla 503");
    expect(rendered.container.textContent).not.toContain("Beto");
  });
});
