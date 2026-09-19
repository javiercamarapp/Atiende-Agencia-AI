// @vitest-environment jsdom
//
// Smoke tests reales de <OwnerPortalDashboardPage /> (portal de propietario de
// rentas — el statement financiero real que ve el dueño: unidades, statements y
// su detalle con neto/líneas). Mismo patrón que citas-agenda-page.spec.tsx:
// `fetch` global mockeado por ruta real contra owner-portal-client.ts, sesión
// persistida en localStorage (mismo criterio que *-shell-mobile-nav.spec.tsx),
// estados de carga/vacío/error, datos reales (neto en pesos, no centavos crudos),
// y la interacción principal ("Ver detalle" de un statement) verificando la ruta
// real de la API.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerPortalDashboardPage } from "../src/verticals/rentas/pages/OwnerPortalDashboard.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

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

const SESSION = { token: "tok-123", refreshToken: "reftok", ownerId: "owner-1", email: "dueno@example.com" };

const ME = { id: "owner-1", name: "Ana Dueña", email: "dueno@example.com", organizaciones: [{ organizationId: "org-1", name: "Gestora Demo" }] };
const UNIDAD = { id: "u-1", name: "Depa 101", propertyId: "prop-1", organizationId: "org-1", organizationName: "Gestora Demo" };
const STATEMENT = { id: "st-1", propertyId: "prop-1", organizationId: "org-1", organizationName: "Gestora Demo", periodo: { inicio: "2026-08-01", fin: "2026-08-31" }, version: 1, moneda: "MXN", netoCentavos: 1234550, generadoEn: "2026-09-01T00:00:00.000Z" };
const DETALLE = { ...STATEMENT, motivoVersion: null, totales: { netoCentavos: 1234550 }, lineas: [{ ocupacionId: "occ-1", tipo: "ingreso", montoCentavos: 1500000 }] };

interface Handlers {
  me?: unknown;
  meOk?: boolean;
  unidades?: readonly (typeof UNIDAD)[];
  statements?: readonly (typeof STATEMENT)[];
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/rentas/owner-portal/me")) return jsonResponse(handlers.me ?? ME, handlers.meOk ?? true);
    if (url.endsWith("/rentas/owner-portal/unidades")) return jsonResponse({ unidades: handlers.unidades ?? [] });
    if (url.includes("/rentas/owner-portal/statements/st-1")) return jsonResponse(DETALLE);
    if (url.includes("/rentas/owner-portal/statements")) return jsonResponse({ statements: handlers.statements ?? [] });
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  installMemoryLocalStorage().setItem("atiende.rentas.ownerPortal.session", JSON.stringify(SESSION));
  return renderComponent(<OwnerPortalDashboardPage apiBaseUrl="https://api.test" onRequireLogin={() => {}} />);
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("OwnerPortalDashboardPage (rentas)", () => {
  it("muestra el estado de carga de unidades y statements primero", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando tus unidades");
    expect(rendered.container.textContent).toContain("Cargando tus statements");
  });

  it("estado vacío explícito cuando no hay unidades ni statements — nunca un error", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Todavía no tienes ninguna unidad registrada");
    expect(rendered.container.textContent).toContain("Todavía no tienes ningún statement generado");
  });

  it("estado de error real cuando /me falla — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ meOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No se pudo cargar");
  });

  it("renderiza datos reales: nombre del propietario, unidad y el neto del statement en pesos (no centavos crudos)", async () => {
    stubFetch({ unidades: [UNIDAD], statements: [STATEMENT] });
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Ana Dueña");
    expect(text).toContain("Depa 101");
    expect(text).toContain("Gestora Demo");
    // 1234550 centavos -> $12,345.50 (nunca el entero crudo de centavos).
    expect(text).toContain("12,345.50");
    expect(text).not.toContain("1234550");
  });

  it("'Ver detalle' llama GET .../owner-portal/statements/st-1 y muestra las líneas reales del statement", async () => {
    stubFetch({ unidades: [UNIDAD], statements: [STATEMENT] });
    rendered = renderPage();
    await esperarCarga();

    const verDetalleBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Ver detalle")!;
    await act(async () => {
      verDetalleBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url]) => url === "https://api.test/rentas/owner-portal/statements/st-1");
    expect(call).toBeDefined();
    expect(rendered.container.textContent).toContain("Neto");
    expect(rendered.container.textContent).toContain("15,000.00"); // línea real (1500000 centavos)
  });
});
