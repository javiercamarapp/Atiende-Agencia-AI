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
import type {
  OwnerPortalMe,
  OwnerPortalStatementDetalle,
  OwnerPortalStatementSummary,
  OwnerPortalUnidad,
} from "../src/verticals/rentas/lib/owner-portal-client.ts";
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

// Revisión de PR #154 (no bloqueante 4): fixtures tipadas contra las interfaces
// REALES de owner-portal-client.ts (antes eran objetos sueltos sin anotar, así
// que campos faltantes -- `slug` de la organización, el desglose completo de
// `totales`, `descripcion` de cada línea -- no los detectaba el compilador).
const ME: OwnerPortalMe = {
  id: "owner-1",
  name: "Ana Dueña",
  email: "dueno@example.com",
  organizaciones: [{ organizationId: "org-1", name: "Gestora Demo", slug: "gestora-demo" }],
};
const UNIDAD: OwnerPortalUnidad = { id: "u-1", name: "Depa 101", propertyId: "prop-1", organizationId: "org-1", organizationName: "Gestora Demo" };
const STATEMENT: OwnerPortalStatementSummary = {
  id: "st-1",
  propertyId: "prop-1",
  organizationId: "org-1",
  organizationName: "Gestora Demo",
  periodo: { inicio: "2026-08-01", fin: "2026-08-31" },
  version: 1,
  moneda: "MXN",
  netoCentavos: 1234550,
  generadoEn: "2026-09-01T00:00:00.000Z",
};
const DETALLE: OwnerPortalStatementDetalle = {
  ...STATEMENT,
  motivoVersion: null,
  totales: {
    ingresosBrutosCentavos: 1500000,
    comisionCanalCentavos: 150000,
    comisionGestorCentavos: 100000,
    gastosCentavos: 10000,
    impuestosCentavos: 5450,
    netoCentavos: 1234550,
  },
  lineas: [{ ocupacionId: "occ-1", tipo: "ingreso", descripcion: "Reserva confirmada ago-2026", montoCentavos: 1500000 }],
};

interface Handlers {
  me?: unknown;
  meOk?: boolean;
  unidades?: readonly OwnerPortalUnidad[];
  statements?: readonly OwnerPortalStatementSummary[];
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
    // "Neto" ya está en el header de la tabla ANTES del click (aserción vacía si
    // solo se busca el label) -- lo que prueba que el detalle sí llegó y se
    // pintó es contenido que NO existe hasta la respuesta real: la línea
    // (occ-1/ingreso/monto) y el bloque de total con su NUEVO valor real.
    const text = rendered.container.textContent!;
    expect(text).toContain("occ-1");
    expect(text).toContain("ingreso");
    expect(text).toContain("15,000.00"); // línea real (1500000 centavos)
    expect(text).toContain("Statement v1");
  });

  it("sin sesión persistida: nunca llama a la API, dispara onRequireLogin y no renderiza nada", async () => {
    stubFetch({});
    // Storage vacío (fresco, sin la sesión que `renderPage()` sí persiste) --
    // ver comentario de `installMemoryLocalStorage` sobre por qué hace falta
    // instalarlo explícito en este entorno de test.
    installMemoryLocalStorage();
    const onRequireLogin = vi.fn();
    rendered = renderComponent(<OwnerPortalDashboardPage apiBaseUrl="https://api.test" onRequireLogin={onRequireLogin} />);
    await esperarCarga();

    expect(onRequireLogin).toHaveBeenCalled();
    expect(rendered.container.textContent).toBe("");
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});
