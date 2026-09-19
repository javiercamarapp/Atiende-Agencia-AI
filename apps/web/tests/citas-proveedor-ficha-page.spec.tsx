// @vitest-environment jsdom
//
// Smoke tests reales de <ProveedorFichaPage /> — hallazgo de auditoría (baja,
// `auditoria-a1b`, entrada 4): la sección "Servicios que ofrece" se quedaba en
// "Cargando servicios…" para siempre si `fetchServices` fallaba (catch vacío,
// `services` nunca dejaba de ser `null`). El fix agrega un estado
// `servicesError` propio (independiente del `error` de la ficha completa),
// extrae el fetch a `cargarServicios()` (reutilizada por el `useEffect` y por
// el botón "Reintentar" de `<EstadoError>`), y antepone el estado de error al
// de carga en el render de esa tarjeta.
//
// Mismo patrón que `rentas-registro-page.spec.tsx`: se mockean
// `fetchProviderDetail`/`fetchServices` (los contratos HTTP ya los cubren
// `citas-providers-client.spec.ts`/`citas-services-client.spec.ts`) — lo que
// se prueba aquí es la reacción del COMPONENTE a carga/error/datos.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ProveedorFichaPage } from "../src/verticals/citas/pages/Proveedores.tsx";
import type { ProviderDetail } from "../src/verticals/citas/lib/providers-client.ts";
import type { ServiceSummary } from "../src/verticals/citas/lib/services-client.ts";
import { flushMicrotasks, renderComponent, click, type RenderedComponent } from "./test-utils/render.tsx";

const fetchProviderDetailMock = vi.fn<(...args: unknown[]) => Promise<ProviderDetail>>();
const fetchServicesMock = vi.fn<(...args: unknown[]) => Promise<readonly ServiceSummary[]>>();

vi.mock("../src/verticals/citas/lib/providers-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/citas/lib/providers-client.ts")>();
  return { ...actual, fetchProviderDetail: (...args: Parameters<typeof fetchProviderDetailMock>) => fetchProviderDetailMock(...args) };
});

vi.mock("../src/verticals/citas/lib/services-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/citas/lib/services-client.ts")>();
  return { ...actual, fetchServices: (...args: Parameters<typeof fetchServicesMock>) => fetchServicesMock(...args) };
});

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  fetchProviderDetailMock.mockReset();
  fetchServicesMock.mockReset();
});

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const DETALLE_BASE: ProviderDetail = {
  provider: { id: "prov-1", propertyId: "prop-1", displayName: "Dra. Ana Ruiz", roleLabel: "Dentista", isActive: true },
  availabilityRules: [],
  googleCalendar: { connected: false, syncStatus: "disconnected", syncError: null },
  calcom: { connected: false, syncStatus: "disconnected", syncError: null, eventTypeId: null, baseUrl: null, syncIssues: { count: 0, lastReason: null } },
  caldav: { connected: false, syncStatus: "disconnected", syncError: null, calendarCollectionUrl: null, username: null, syncIssues: { count: 0, lastReason: null } },
  calendarSyncIssues: { count: 0, lastReason: null },
  offeredServiceIds: ["svc-1"],
};

const SERVICIOS: readonly ServiceSummary[] = [
  { id: "svc-1", name: "Limpieza dental", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 5, priceCents: 50000, isActive: true },
  { id: "svc-2", name: "Consulta general", durationMinutes: 20, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: null, isActive: true },
];

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <ProveedorFichaPage apiBaseUrl="https://api.test" token="tok-123" propertyId="prop-1" orgSlug="org-slug" providerId="prov-1" />
    </MemoryRouter>,
  );
}

describe("ProveedorFichaPage — sección Servicios que ofrece", () => {
  it("carga: muestra 'Cargando servicios…' mientras la promesa de fetchServices sigue pendiente", async () => {
    fetchProviderDetailMock.mockResolvedValue(DETALLE_BASE);
    fetchServicesMock.mockReturnValue(new Promise(() => {})); // nunca resuelve en este test
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Cargando servicios…");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("error: si fetchServices falla, muestra el estado de error real (con botón Reintentar) — NUNCA se queda en carga infinita", async () => {
    fetchProviderDetailMock.mockResolvedValue(DETALLE_BASE);
    fetchServicesMock.mockRejectedValue(new Error("No se pudieron cargar los servicios."));
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).not.toContain("Cargando servicios…");
    const alert = rendered.container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("No se pudieron cargar los servicios.");
    const reintentar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Reintentar");
    expect(reintentar).toBeDefined();
  });

  it("error con reintento que funciona: tocar 'Reintentar' vuelve a llamar fetchServices, limpia el error y muestra los datos reales al resolver", async () => {
    fetchProviderDetailMock.mockResolvedValue(DETALLE_BASE);
    fetchServicesMock.mockRejectedValueOnce(new Error("network down"));
    rendered = renderPage();
    await esperarCarga();

    const alertAntes = rendered.container.querySelector('[role="alert"]');
    expect(alertAntes?.textContent).toContain("network down");

    fetchServicesMock.mockResolvedValueOnce(SERVICIOS);
    const reintentar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Reintentar")!;
    click(reintentar);
    await esperarCarga();

    expect(fetchServicesMock).toHaveBeenCalledTimes(2);
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    expect(rendered.container.textContent).toContain("Limpieza dental");
    expect(rendered.container.textContent).toContain("Consulta general");
  });

  it("datos: al resolver, lista los servicios reales y marca como ofrecido exactamente el que está en offeredServiceIds", async () => {
    fetchProviderDetailMock.mockResolvedValue(DETALLE_BASE);
    fetchServicesMock.mockResolvedValue(SERVICIOS);
    rendered = renderPage();
    await esperarCarga();

    const root = rendered.container;
    expect(root.textContent).not.toContain("Cargando servicios…");
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.textContent).toContain("Limpieza dental");
    expect(root.textContent).toContain("Consulta general");

    const checkboxes = [...root.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    const limpieza = checkboxes.find((c) => c.closest("label")?.textContent?.includes("Limpieza dental"));
    const consulta = checkboxes.find((c) => c.closest("label")?.textContent?.includes("Consulta general"));
    expect(limpieza?.checked).toBe(true); // svc-1 está en offeredServiceIds
    expect(consulta?.checked).toBe(false); // svc-2 no lo está
  });
});
