// @vitest-environment jsdom
//
// Smoke tests reales de <PromocionesPage /> (códigos de descuento — dinero
// real, afecta el total de cada pedido). `fetch` global mockeado por ruta
// real contra apps/api/src/routes/verticals/restaurantes/admin-promotions.ts,
// TZ fija (America/Mexico_City, mismo criterio que
// despachos-cobranza-page.spec.tsx/citas-agenda-rango-label.spec.tsx) porque
// `dateInputToIso` construye la fecha con el constructor local de `Date`. Los
// dos formularios viven en un `<Dialog>` real (Portal a `document.body`), así
// que sus campos se consultan ahí, no en `rendered.container`.
import { act } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { PromocionesPage } from "../src/verticals/restaurantes/pages/Promociones.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { Promotion } from "../src/verticals/restaurantes/lib/promotions-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const TZ_ORIGINAL = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/Mexico_City";
});

afterAll(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

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

const PROMO_1: Promotion = {
  id: "promo-1",
  code: "BIENVENIDA10",
  name: "Bienvenida 10%",
  description: null,
  type: "percentage",
  value: 10,
  minOrderTotal: 200,
  startsAt: "2026-09-01T06:00:00.000Z",
  endsAt: "2026-09-30T05:59:59.000Z",
  daysOfWeek: [1, 2, 3],
  startTime: "12:00",
  endTime: "18:00",
  maxUses: 100,
  timesUsed: 37,
  isActive: true,
  createdAt: "2026-08-25T10:00:00.000Z",
  updatedAt: "2026-08-25T10:00:00.000Z",
};

interface Handlers {
  promotions?: readonly Promotion[] | (() => readonly Promotion[]);
  promotionsOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "https://api.test/v1/restaurantes/prop-1/admin/promotions") {
      const promotions = typeof handlers.promotions === "function" ? handlers.promotions() : (handlers.promotions ?? [PROMO_1]);
      return jsonResponse({ promotions }, handlers.promotionsOk ?? true);
    }
    if (method === "POST" && url === "https://api.test/v1/restaurantes/prop-1/admin/promotions") {
      const input = JSON.parse(init!.body as string) as Record<string, unknown>;
      return jsonResponse({ promotion: { ...PROMO_1, id: "promo-nuevo", timesUsed: 0, ...input } });
    }
    if (method === "PATCH" && url === "https://api.test/v1/restaurantes/prop-1/admin/promotions/promo-1") {
      const patch = JSON.parse(init!.body as string) as Record<string, unknown>;
      return jsonResponse({ promotion: { ...PROMO_1, ...patch } });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <PromocionesPage {...CTX} />
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("PromocionesPage (restaurantes)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando promociones");
  });

  it("estado vacío honesto cuando no hay ninguna promoción", async () => {
    stubFetch({ promotions: [] });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Todavía no hay ninguna promoción creada.");
  });

  it("estado de error real con reintentar — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ promotionsOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando promociones");
    expect(rendered.container.textContent).toContain("No se pudo cargar https://api.test/v1/restaurantes/prop-1/admin/promotions (500).");
  });

  it("renderiza la promoción real: código, valor, pedido mínimo, uso real/tope, días/horario y vigencia", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("BIENVENIDA10");
    expect(text).toContain("Bienvenida 10%");
    expect(text).toContain("10% de descuento");
    expect(text).toContain("pedido mín. $200.00");
    expect(text).toContain("usado 37/100");
    expect(text).toContain("Lun/Mar/Mié");
    expect(text).toContain("12:00-18:00");
    expect(text).toContain("Vigencia:");
  });

  it("promoción inactiva muestra la etiqueta 'Inactiva' y el botón para reactivar", async () => {
    stubFetch({ promotions: [{ ...PROMO_1, isActive: false }] });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Inactiva");
    expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent === "Activar")).toBe(true);
  });

  it("desactivar una promoción activa: PATCH .../promotions/promo-1 con isActive:false y recarga", async () => {
    let promoActual = PROMO_1;
    stubFetch({ promotions: () => [promoActual] });
    rendered = renderPage();
    await esperarCarga();

    const toggleBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Desactivar")!;
    promoActual = { ...PROMO_1, isActive: false };
    await act(async () => {
      click(toggleBtn);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/restaurantes/prop-1/admin/promotions/promo-1" && init?.method === "PATCH");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ isActive: false });
    expect(rendered.container.textContent).toContain("Inactiva");
  });

  it("editar vigencia: el modal precarga las fechas reales y guarda con las fechas convertidas a ISO real", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const editBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Editar vigencia"))!;
    await act(async () => { click(editBtn); });

    const desdeInput = document.body.querySelector("#promocion-edit-desde") as HTMLInputElement;
    const hastaInput = document.body.querySelector("#promocion-edit-hasta") as HTMLInputElement;
    expect(desdeInput.value).toBe("2026-09-01");
    expect(hastaInput.value).toBe("2026-09-30");

    changeValue(hastaInput, "2026-10-15");
    const guardarBtn = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Guardar")!;
    await act(async () => {
      click(guardarBtn);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/restaurantes/prop-1/admin/promotions/promo-1" && init?.method === "PATCH");
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body.startsAt).toBe(new Date("2026-09-01T00:00:00").toISOString());
    expect(body.endsAt).toBe(new Date("2026-10-15T23:59:59").toISOString());
  });

  it("crear código nuevo: valida código/nombre/valor y NUNCA llama a la API con datos inválidos", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const abrirBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Crear un código nuevo"))!;
    await act(async () => { click(abrirBtn); });

    changeValue(document.body.querySelector("#promocion-codigo") as HTMLInputElement, "PRUEBA");
    changeValue(document.body.querySelector("#promocion-nombre") as HTMLInputElement, "Prueba");
    changeValue(document.body.querySelector("#promocion-valor") as HTMLInputElement, "0"); // inválido: value <= 0

    const callsAntes = fetchMock.mock.calls.length;
    const form = document.body.querySelector("#restaurantes-promocion-nueva") as HTMLFormElement;
    await submitForm(form);

    expect(fetchMock.mock.calls.length).toBe(callsAntes);
  });

  it("crear código nuevo real: POST .../promotions con el cuerpo exacto (código en mayúsculas, tipo/valor/vigencia/tope), cierra el modal y recarga", async () => {
    let promotionsActuales: readonly Promotion[] = [PROMO_1];
    stubFetch({ promotions: () => promotionsActuales });
    rendered = renderPage();
    await esperarCarga();

    const abrirBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Crear un código nuevo"))!;
    await act(async () => { click(abrirBtn); });

    changeValue(document.body.querySelector("#promocion-codigo") as HTMLInputElement, "verano25");
    changeValue(document.body.querySelector("#promocion-nombre") as HTMLInputElement, "Promo de verano");
    changeValue(document.body.querySelector("#promocion-tipo") as HTMLSelectElement, "fixed");
    changeValue(document.body.querySelector("#promocion-valor") as HTMLInputElement, "50");
    changeValue(document.body.querySelector("#promocion-minimo") as HTMLInputElement, "300");
    changeValue(document.body.querySelector("#promocion-tope") as HTMLInputElement, "20");
    changeValue(document.body.querySelector("#promocion-desde") as HTMLInputElement, "2026-10-01");
    changeValue(document.body.querySelector("#promocion-hasta") as HTMLInputElement, "2026-10-31");

    const nuevaPromo: Promotion = { ...PROMO_1, id: "promo-nuevo", code: "VERANO25", name: "Promo de verano", type: "fixed", value: 50, minOrderTotal: 300, maxUses: 20, timesUsed: 0 };
    promotionsActuales = [PROMO_1, nuevaPromo];

    const form = document.body.querySelector("#restaurantes-promocion-nueva") as HTMLFormElement;
    await submitForm(form);
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/restaurantes/prop-1/admin/promotions" && init?.method === "POST");
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body).toEqual({
      code: "VERANO25",
      name: "Promo de verano",
      type: "fixed",
      value: 50,
      minOrderTotal: 300,
      maxUses: 20,
      startsAt: new Date("2026-10-01T00:00:00").toISOString(),
      endsAt: new Date("2026-10-31T23:59:59").toISOString(),
    });
    // El modal se cierra y la promoción nueva ya aparece en la lista.
    expect(document.body.querySelector("#promocion-codigo")).toBeNull();
    expect(rendered.container.textContent).toContain("VERANO25");
  });
});
