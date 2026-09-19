// @vitest-environment jsdom
//
// Smoke tests reales de <SucursalesPage /> — lista + edición de teléfono/
// dirección de cada sucursal. `fetch` global mockeado por ruta real contra
// apps/api/src/routes/verticals/restaurantes/admin-branches.ts, estados de
// carga/error, datos reales (nombre/slug/estado/teléfono/dirección con "—"
// honesto cuando no hay dato) y la acción principal (editar y guardar)
// verificando PATCH .../sucursales/:id con el cuerpo exacto.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SucursalesPage } from "../src/verticals/restaurantes/pages/Sucursales.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { BranchDetail } from "../src/verticals/restaurantes/lib/branches-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const CTX: RestaurantesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "Gaby Demo",
  staffEmail: "gaby@example.com",
};

const SUCURSAL_CENTRO: BranchDetail = { propertyId: "prop-1", name: "Sucursal Centro", slug: "centro", status: "active", phone: "5511112222", address: "Av. Reforma 123", lat: 19.43, lng: -99.13 };
const SUCURSAL_NORTE: BranchDetail = { propertyId: "prop-2", name: "Sucursal Norte", slug: "norte", status: "inactive", phone: null, address: null, lat: null, lng: null };

interface Handlers {
  branches?: readonly BranchDetail[] | (() => readonly BranchDetail[]);
  branchesOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "https://api.test/v1/restaurantes/prop-1/admin/sucursales") {
      const branches = typeof handlers.branches === "function" ? handlers.branches() : (handlers.branches ?? [SUCURSAL_CENTRO, SUCURSAL_NORTE]);
      return jsonResponse({ branches }, handlers.branchesOk ?? true);
    }
    if (method === "PATCH" && url === "https://api.test/v1/restaurantes/prop-1/admin/sucursales/prop-1") {
      const patch = JSON.parse(init!.body as string) as { phone: string | null; address: string | null };
      return jsonResponse({ branch: { ...SUCURSAL_CENTRO, ...patch } });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <SucursalesPage {...CTX} />
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("SucursalesPage (restaurantes)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando sucursales");
  });

  it("estado de error real con reintentar — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ branchesOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando sucursales");
    expect(rendered.container.textContent).toContain("No se pudo cargar https://api.test/v1/restaurantes/prop-1/admin/sucursales (500).");
  });

  it("renderiza sucursales reales: nombre, slug, estado activo/inactivo y '—' honesto cuando falta el dato", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Sucursal Centro");
    expect(text).toContain("/centro");
    expect(text).toContain("Activa");
    expect(text).toContain("5511112222");
    expect(text).toContain("Av. Reforma 123");
    expect(text).toContain("Sucursal Norte");
    expect(text).toContain("Inactiva");
    // La sucursal sin teléfono/dirección real muestra "—", nunca "null" ni vacío.
    const dds = [...rendered.container.querySelectorAll("dd")].map((d) => d.textContent);
    expect(dds).toContain("—");
  });

  it("editar sucursal: precarga el formulario con los valores reales actuales", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const editBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Editar"))!;
    await act(async () => {
      click(editBtn);
    });

    expect((rendered.container.querySelector("#sucursal-telefono-prop-1") as HTMLInputElement).value).toBe("5511112222");
    expect((rendered.container.querySelector("#sucursal-direccion-prop-1") as HTMLInputElement).value).toBe("Av. Reforma 123");
  });

  it("cancelar la edición no llama a la API y descarta los cambios", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const editBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Editar"))!;
    await act(async () => { click(editBtn); });
    changeValue(rendered.container.querySelector("#sucursal-telefono-prop-1") as HTMLInputElement, "0000000000");

    const callsAntes = fetchMock.mock.calls.length;
    const cancelBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Cancelar")!;
    await act(async () => { click(cancelBtn); });

    expect(fetchMock.mock.calls.length).toBe(callsAntes);
    expect(rendered.container.textContent).toContain("5511112222"); // el valor real, sin tocar
  });

  it("guardar sucursal real: PATCH .../sucursales/prop-1 con teléfono/dirección exactos, cierra edición y recarga", async () => {
    let branchesActuales = [SUCURSAL_CENTRO, SUCURSAL_NORTE];
    stubFetch({ branches: () => branchesActuales });
    rendered = renderPage();
    await esperarCarga();

    const editBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Editar"))!;
    await act(async () => { click(editBtn); });

    changeValue(rendered.container.querySelector("#sucursal-telefono-prop-1") as HTMLInputElement, "5599998888");
    changeValue(rendered.container.querySelector("#sucursal-direccion-prop-1") as HTMLInputElement, "Nueva Dirección 456");
    branchesActuales = [{ ...SUCURSAL_CENTRO, phone: "5599998888", address: "Nueva Dirección 456" }, SUCURSAL_NORTE];

    const saveBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Guardar")!;
    await act(async () => {
      click(saveBtn);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/restaurantes/prop-1/admin/sucursales/prop-1" && init?.method === "PATCH");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ phone: "5599998888", address: "Nueva Dirección 456" });
    // La edición se cierra y el nuevo dato real aparece.
    expect(rendered.container.querySelector("#sucursal-telefono-prop-1")).toBeNull();
    expect(rendered.container.textContent).toContain("Nueva Dirección 456");
  });

  it("guardar con campos vacíos manda null (no cadena vacía) — mismo criterio que el resto del panel", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const editBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Editar"))!;
    await act(async () => { click(editBtn); });
    changeValue(rendered.container.querySelector("#sucursal-telefono-prop-1") as HTMLInputElement, "");
    changeValue(rendered.container.querySelector("#sucursal-direccion-prop-1") as HTMLInputElement, "");

    const saveBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Guardar")!;
    await act(async () => {
      click(saveBtn);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/restaurantes/prop-1/admin/sucursales/prop-1" && init?.method === "PATCH");
    expect(JSON.parse(call![1].body as string)).toEqual({ phone: null, address: null });
  });
});
