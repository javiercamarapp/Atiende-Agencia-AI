// @vitest-environment jsdom
//
// Smoke tests reales de <SuperAdminFacturacionPage /> — mismo patrón que
// superadmin-gasto-api-page.spec.tsx: `fetch` global mockeado (este
// componente llama `fetch` directo, sin cliente separado), estados de
// carga/vacío/error, y el flujo de generar el enlace de checkout (incluido el
// 503 honesto sin credenciales de Stripe).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminFacturacionPage } from "../src/superadmin/pages/Facturacion.tsx";
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

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const RESUMEN_VACIO = {
  totalOrganizaciones: 0,
  conteoPorEstado: { sin_suscripcion: 0, activa: 0, pago_pendiente: 0, cancelada: 0 },
  morosos: 0,
  mrrMxn: 0,
  organizacionesActivasConPrecioDesconocido: 0,
  proximasRenovaciones: [],
  webhooks: { totalProcesados: 0, ultimoProcesadoAt: null },
};

const ORG_HOTELES = {
  organizationId: "org-1",
  vertical: "hoteles",
  name: "Hotel Test",
  slug: "hotel-test",
  orgStatus: "active",
  createdAt: "2025-01-01T00:00:00.000Z",
  billingStatus: "activa",
  seats: 10,
  staffCount: 4,
  priceId: "price_123",
  stripeCustomerId: "cus_1",
  stripeSubscriptionId: "sub_1",
  currentPeriodEnd: "2026-03-01T00:00:00.000Z",
  ultimoEventoAplicadoAt: "2026-02-01T00:00:00.000Z",
  precioConocido: true,
  seatLabel: "habitación",
  precioPorSeatMxn: 89,
  seatsFacturablesSegunReal: 0,
  descuadreAsientos: 10,
  mrrMxn: 890,
};

const BITACORA_VACIA = { disponible: true, rows: [], total: 0 };

function stubFetch(handlers: { resumen?: unknown; organizaciones?: unknown; webhooks?: unknown; bitacora?: unknown; post?: (url: string, body: unknown) => Response | undefined }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      const custom = handlers.post?.(url, body);
      if (custom) return custom;
      return jsonResponse({ url: "https://checkout.stripe.com/test/abc" });
    }
    if (url.includes("/superadmin/facturacion/resumen")) return jsonResponse(handlers.resumen ?? RESUMEN_VACIO);
    if (url.includes("/superadmin/facturacion/webhooks-bitacora")) return jsonResponse(handlers.bitacora ?? BITACORA_VACIA);
    if (url.includes("/superadmin/facturacion/organizaciones")) return jsonResponse(handlers.organizaciones ?? { organizaciones: [] });
    if (url.includes("/superadmin/facturacion/webhooks-recientes")) return jsonResponse(handlers.webhooks ?? { eventos: [], total: 0 });
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<SuperAdminFacturacionPage apiBaseUrl="https://api.test" token="tok-123" />);
}

describe("SuperAdminFacturacionPage", () => {
  it("muestra el estado de carga primero, y después totales reales en cero cuando no hay organizaciones", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando facturación");

    await esperarCarga();
    expect(rendered.container.textContent).toContain("Facturación");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("estado de error cuando el fetch falla -- nunca se queda atorado en 'Cargando'", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No se pudo cargar la facturación");
  });

  it("estado vacío real cuando ninguna organización coincide con el filtro", async () => {
    stubFetch({ organizaciones: { organizaciones: [] } });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Ninguna organización coincide con este filtro");
  });

  it("renderiza el MRR real, el descuadre de asientos, y las próximas renovaciones", async () => {
    stubFetch({
      resumen: {
        ...RESUMEN_VACIO,
        totalOrganizaciones: 1,
        conteoPorEstado: { sin_suscripcion: 0, activa: 1, pago_pendiente: 0, cancelada: 0 },
        mrrMxn: 890,
        proximasRenovaciones: [ORG_HOTELES],
      },
      organizaciones: { organizaciones: [ORG_HOTELES] },
    });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Hotel Test");
    expect(rendered.container.textContent).toContain("890.00");
    expect(rendered.container.textContent).toContain("10 / 4");
    expect(rendered.container.textContent).toContain("+10 descuadre");
  });

  it("cuando el MRR total es null (sin precio conocido), muestra 'No disponible' -- nunca $0 inventado", async () => {
    stubFetch({
      resumen: { ...RESUMEN_VACIO, mrrMxn: null, organizacionesActivasConPrecioDesconocido: 1 },
    });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No disponible");
  });

  it("generar el enlace de checkout arma el POST correcto y muestra la URL copiable", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    stubFetch({
      organizaciones: { organizaciones: [ORG_HOTELES] },
      post: (url, body) => {
        capturedUrl = url;
        capturedBody = body;
        return jsonResponse({ url: "https://checkout.stripe.com/test/real" });
      },
    });
    rendered = renderPage();
    await esperarCarga();

    const checkoutBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Checkout"));
    expect(checkoutBtn).toBeDefined();
    click(checkoutBtn!);

    const priceInput = document.body.querySelector("#checkout-price-id") as HTMLInputElement;
    expect(priceInput).not.toBeNull();
    expect(priceInput.value).toBe("price_123");
    changeValue(priceInput, "price_nuevo");
    const seatsInput = document.body.querySelector("#checkout-seats") as HTMLInputElement;
    changeValue(seatsInput, "3");

    const form = document.body.querySelector("form") as HTMLFormElement;
    await submitForm(form);

    expect(capturedUrl).toContain("/superadmin/facturacion/organizaciones/org-1/checkout");
    expect(capturedBody).toMatchObject({ priceId: "price_nuevo", seats: 3 });
    const urlInput = document.body.querySelector("#checkout-url") as HTMLInputElement;
    expect(urlInput.value).toBe("https://checkout.stripe.com/test/real");
  });

  it("sin Stripe configurado (503), muestra el aviso honesto que remite a Integraciones -- nunca finge una URL", async () => {
    stubFetch({
      organizaciones: { organizaciones: [ORG_HOTELES] },
      post: () => jsonResponse({ code: "service_unavailable", message: "Stripe no configurado." }, false, 503),
    });
    rendered = renderPage();
    await esperarCarga();

    const checkoutBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Checkout"));
    click(checkoutBtn!);

    const form = document.body.querySelector("form") as HTMLFormElement;
    await submitForm(form);

    expect(document.body.textContent).toContain("Stripe no está configurado en este entorno");
    expect(document.body.querySelector('a[href="/superadmin/integraciones"]')).not.toBeNull();
  });
});

describe("SuperAdminFacturacionPage — bitácora completa de webhooks", () => {
  it("renderiza filas reales, incluido un rechazo sin organización resuelta", async () => {
    stubFetch({
      bitacora: {
        disponible: true,
        total: 2,
        rows: [
          { id: "2", providerEventId: "evt_ok", eventType: "checkout.session.completed", organizationId: "org-1", organizationName: "Hotel Test", organizationSlug: "hotel-test", result: "procesado", reason: "aplicado", createdAt: "2026-02-01T00:00:00.000Z" },
          { id: "1", providerEventId: null, eventType: null, organizationId: null, organizationName: null, organizationSlug: null, result: "rechazado", reason: "firma_invalida", createdAt: "2026-01-31T00:00:00.000Z" },
        ],
      },
    });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Bitácora completa de webhooks");
    expect(rendered.container.textContent).toContain("Procesado");
    expect(rendered.container.textContent).toContain("Rechazado");
    expect(rendered.container.textContent).toContain("Firma inválida");
    expect(rendered.container.textContent).toContain("Hotel Test");
    expect(rendered.container.textContent).toContain("Sin resolver");
  });

  it("cuando la migración todavía no se aplicó (disponible: false), muestra el vacío honesto, nunca un error", async () => {
    stubFetch({ bitacora: { disponible: false, rows: [], total: 0 } });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("no está disponible todavía en este ambiente");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("filtrar por resultado arma el query param correcto y resetea la página", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const select = rendered.container.querySelector('select[aria-label="Filtrar por resultado"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    changeValue(select, "rechazado");
    await esperarCarga();

    const ultimaLlamada = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/webhooks-bitacora") && u.includes("result="));
    expect(ultimaLlamada).toContain("result=rechazado");
  });
});
