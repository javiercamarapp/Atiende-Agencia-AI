// @vitest-environment jsdom
//
// Smoke tests reales de <ServiciosListPage /> y <ServicioFichaPage /> (catálogo
// de servicios del panel de citas — nombre, duración, colchones y precio).
// `fetch` global mockeado por ruta real contra
// apps/api/src/routes/verticals/citas/admin.ts (GET/POST/PATCH .../services,
// filas en snake_case reales — `services-client.ts::mapService`), estados de
// carga/vacío/error, render con datos reales (precio con formato/"Sin precio"
// honesto) y las acciones principales: crear servicio y editar/guardar.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ServiciosListPage, ServicioFichaPage } from "../src/verticals/citas/pages/Servicios.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

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

const CTX: CitasShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  orgId: "org-1",
  role: "owner",
  staffFullName: "Sam Demo",
  staffEmail: "sam@example.com",
};

interface ServiceApiRowFixture {
  readonly id: string;
  readonly name: string;
  readonly duration_minutes: number;
  readonly buffer_minutes_before: number;
  readonly buffer_minutes_after: number;
  readonly price_cents: number | null;
  readonly is_active: boolean;
}

const SERVICIO_ROW_CORTE: ServiceApiRowFixture = {
  id: "svc-1",
  name: "Corte de cabello",
  duration_minutes: 30,
  buffer_minutes_before: 5,
  buffer_minutes_after: 10,
  price_cents: 25000,
  is_active: true,
};

const SERVICIO_ROW_SIN_PRECIO: ServiceApiRowFixture = {
  id: "svc-2",
  name: "Consulta inicial",
  duration_minutes: 15,
  buffer_minutes_before: 0,
  buffer_minutes_after: 0,
  price_cents: null,
  is_active: false,
};

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("ServiciosListPage (citas)", () => {
  interface Handlers {
    services?: readonly ServiceApiRowFixture[] | (() => readonly ServiceApiRowFixture[]);
    servicesOk?: boolean;
  }

  function stubFetch(handlers: Handlers) {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "https://api.test/v1/citas/properties/prop-1/services") {
        const services = typeof handlers.services === "function" ? handlers.services() : (handlers.services ?? [SERVICIO_ROW_CORTE]);
        return jsonResponse({ services }, handlers.servicesOk ?? true);
      }
      if (method === "POST" && url === "https://api.test/v1/citas/properties/prop-1/services") {
        const input = JSON.parse(init!.body as string) as Record<string, unknown>;
        return jsonResponse({ service: { id: "svc-nuevo", name: input.name, duration_minutes: input.duration_minutes, buffer_minutes_before: 0, buffer_minutes_after: 0, price_cents: input.price_cents ?? null, is_active: true } });
      }
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  function renderPage(): RenderedComponent {
    return renderComponent(
      <MemoryRouter>
        <ServiciosListPage {...CTX} />
      </MemoryRouter>,
    );
  }

  it("muestra el estado de carga primero", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando servicios");
  });

  it("estado vacío honesto cuando no hay servicios activos", async () => {
    stubFetch({ services: [] });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Este negocio todavía no tiene servicios activos.");
  });

  it("estado de error real — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ servicesOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando servicios");
    expect(rendered.container.textContent).toContain("No se pudo cargar https://api.test/v1/citas/properties/prop-1/services (500).");
  });

  it("renderiza servicios reales: duración, precio con formato, y 'Sin precio' honesto cuando no hay precio fijo", async () => {
    stubFetch({ services: [SERVICIO_ROW_CORTE, SERVICIO_ROW_SIN_PRECIO] });
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Corte de cabello");
    expect(text).toContain("30 min");
    expect(text).toContain("$250.00");
    expect(text).toContain("Consulta inicial");
    expect(text).toContain("15 min");
    expect(text).toContain("Sin precio");
  });

  it("crear servicio: valida nombre/duración y NUNCA llama a la API con datos inválidos", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    changeValue(rendered.container.querySelector("#citas-nuevo-servicio-nombre") as HTMLInputElement, "Manicure");
    changeValue(rendered.container.querySelector("#citas-nuevo-servicio-duracion") as HTMLInputElement, "0"); // inválido

    const callsAntes = fetchMock.mock.calls.length;
    const form = [...rendered.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Crear servicio"))!;
    await submitForm(form);
    expect(fetchMock.mock.calls.length).toBe(callsAntes);
  });

  it("crear servicio real: POST .../services con name/duration_minutes/price_cents reales (precio convertido a centavos) y recarga", async () => {
    let serviciosActuales = [SERVICIO_ROW_CORTE];
    stubFetch({ services: () => serviciosActuales });
    rendered = renderPage();
    await esperarCarga();

    changeValue(rendered.container.querySelector("#citas-nuevo-servicio-nombre") as HTMLInputElement, "Manicure");
    changeValue(rendered.container.querySelector("#citas-nuevo-servicio-duracion") as HTMLInputElement, "45");
    changeValue(rendered.container.querySelector("#citas-nuevo-servicio-precio") as HTMLInputElement, "180.5");
    serviciosActuales = [SERVICIO_ROW_CORTE, { id: "svc-nuevo", name: "Manicure", duration_minutes: 45, buffer_minutes_before: 0, buffer_minutes_after: 0, price_cents: 18050, is_active: true }];

    const form = [...rendered.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Crear servicio"))!;
    await submitForm(form);
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/citas/properties/prop-1/services" && init?.method === "POST");
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body.name).toBe("Manicure");
    expect(body.duration_minutes).toBe(45);
    expect(body.price_cents).toBe(18050);
    expect(rendered.container.textContent).toContain("Manicure");
  });

  it("crear servicio sin precio: price_cents queda undefined (nunca 0 inventado)", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    changeValue(rendered.container.querySelector("#citas-nuevo-servicio-nombre") as HTMLInputElement, "Consulta");
    changeValue(rendered.container.querySelector("#citas-nuevo-servicio-duracion") as HTMLInputElement, "20");

    const form = [...rendered.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Crear servicio"))!;
    await submitForm(form);

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/citas/properties/prop-1/services" && init?.method === "POST");
    const body = JSON.parse(call![1].body as string);
    expect(body.price_cents).toBeUndefined();
  });
});

describe("ServicioFichaPage (citas)", () => {
  interface Handlers {
    service?: ServiceApiRowFixture | (() => ServiceApiRowFixture);
    serviceOk?: boolean;
  }

  function stubFetch(handlers: Handlers) {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "https://api.test/v1/citas/properties/prop-1/services/svc-1") {
        const service = typeof handlers.service === "function" ? handlers.service() : (handlers.service ?? SERVICIO_ROW_CORTE);
        return jsonResponse({ service }, handlers.serviceOk ?? true);
      }
      if (method === "PATCH" && url === "https://api.test/v1/citas/properties/prop-1/services/svc-1") {
        const patch = JSON.parse(init!.body as string) as Record<string, unknown>;
        return jsonResponse({ service: { ...SERVICIO_ROW_CORTE, ...patch } });
      }
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  function renderPage(): RenderedComponent {
    return renderComponent(
      <MemoryRouter>
        <ServicioFichaPage {...CTX} serviceId="svc-1" />
      </MemoryRouter>,
    );
  }

  it("muestra el estado de carga primero", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando servicio");
  });

  it("estado de error real — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ serviceOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando servicio");
    expect(rendered.container.textContent).toContain("No se pudo cargar https://api.test/v1/citas/properties/prop-1/services/svc-1 (500).");
  });

  it("renderiza la ficha real: duración, colchones, precio y estado activo", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Corte de cabello");
    expect(text).toContain("30 min");
    expect(text).toContain("5 min"); // colchón antes
    expect(text).toContain("10 min"); // colchón después
    expect(text).toContain("$250.00");
    expect(text).toContain("Activo");
  });

  it("editar precarga el formulario con los valores reales actuales", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const editBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Editar servicio"))!;
    await act(async () => { click(editBtn); });

    expect((rendered.container.querySelector("#citas-servicio-nombre") as HTMLInputElement).value).toBe("Corte de cabello");
    expect((rendered.container.querySelector("#citas-servicio-duracion") as HTMLInputElement).value).toBe("30");
    expect((rendered.container.querySelector("#citas-servicio-precio") as HTMLInputElement).value).toBe("250");
    expect((rendered.container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  });

  it("guardar cambios real: PATCH .../services/svc-1 con duration_minutes/buffers/price_cents/is_active reales, cierra edición y recarga", async () => {
    let servicioActual = SERVICIO_ROW_CORTE;
    stubFetch({ service: () => servicioActual });
    rendered = renderPage();
    await esperarCarga();

    const editBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Editar servicio"))!;
    await act(async () => { click(editBtn); });

    changeValue(rendered.container.querySelector("#citas-servicio-duracion") as HTMLInputElement, "40");
    changeValue(rendered.container.querySelector("#citas-servicio-precio") as HTMLInputElement, "300");
    const checkbox = rendered.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { click(checkbox); }); // desactivar

    servicioActual = { ...SERVICIO_ROW_CORTE, duration_minutes: 40, price_cents: 30000, is_active: false };

    const form = [...rendered.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Guardar cambios"))!;
    await submitForm(form);
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/citas/properties/prop-1/services/svc-1" && init?.method === "PATCH");
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body.duration_minutes).toBe(40);
    expect(body.price_cents).toBe(30000);
    expect(body.is_active).toBe(false);
    // Cierra la edición y refleja el nuevo estado real.
    expect(rendered.container.querySelector("#citas-servicio-nombre")).toBeNull();
    expect(rendered.container.textContent).toContain("Inactivo");
  });

  it("guardar con precio vacío: manda price_cents null (nunca 0 ni el precio anterior)", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const editBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Editar servicio"))!;
    await act(async () => { click(editBtn); });
    changeValue(rendered.container.querySelector("#citas-servicio-precio") as HTMLInputElement, "");

    const form = [...rendered.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Guardar cambios"))!;
    await submitForm(form);

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/citas/properties/prop-1/services/svc-1" && init?.method === "PATCH");
    const body = JSON.parse(call![1].body as string);
    expect(body.price_cents).toBeNull();
  });
});
