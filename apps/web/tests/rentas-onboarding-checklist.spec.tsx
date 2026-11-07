// @vitest-environment jsdom
//
// Rn-36 -- <OnboardingChecklist /> (tarjeta del Resumen de rentas) y su cliente: cada punto sale tal cual lo calculo el servidor con
// datos reales, enlazado a la pantalla que lo resuelve; sin datos medibles o con todo listo no pinta nada; 403 por membership acotada
// no es un error; un fallo de red se ve con reintento.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingChecklist } from "../src/verticals/rentas/components/OnboardingChecklist.tsx";
import { fetchChecklistOnboarding } from "../src/verticals/rentas/lib/onboarding-checklist-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const punto = (clave: string, estado: string, pantalla: string, extra: object = {}) => ({ clave, titulo: `Titulo ${clave}`, descripcion: `Desc ${clave}`, estado, detalle: estado === "no_disponible" ? null : `Detalle ${clave}`, pantalla, obligatorio: false, ...extra });
const CHECKLIST = (extra: object = {}) => ({
  puntos: [
    punto("ical", "hecho", "ical-sync", { obligatorio: true }),
    punto("tarifa_base", "pendiente", "precios", { obligatorio: true }),
    punto("reglas_comision", "pendiente", "finanzas", { obligatorio: true }),
    punto("acceso_huesped", "no_disponible", "acceso-huesped"),
  ],
  medibles: 3,
  hechos: 1,
  porcentaje: 33,
  listoParaOperar: false,
  ...extra,
});

const montar = () =>
  renderComponent(
    <MemoryRouter>
      <OnboardingChecklist apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" orgSlug="gestora-demo" />
    </MemoryRouter>,
  );

describe("OnboardingChecklist", () => {
  it("pinta el progreso real y un renglon por punto con su estado, su detalle y el enlace a la pantalla que lo resuelve", async () => {
    const fetchMock = vi.fn(async () => json(CHECKLIST()));
    vi.stubGlobal("fetch", fetchMock);
    rendered = montar();
    await esperar();
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("http://api.local/v1/rentas/prop-1/admin/onboarding");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Configura tu gestora");
    expect(texto).toContain("1 de 3 listos");
    expect(texto).toContain("Faltan puntos obligatorios");
    expect(texto).toContain("Detalle ical");
    expect(texto).toContain("Listo");
    expect(texto).toContain("Pendiente");
    expect(texto).toContain("No disponible aún");
    expect(texto).toContain("(obligatorio)");
    const progreso = rendered.container.querySelector("progress")!;
    expect(progreso.getAttribute("value")).toBe("33");
    const enlaces = Array.from(rendered.container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(enlaces).toEqual(["/rentas/gestora-demo/ical-sync", "/rentas/gestora-demo/precios", "/rentas/gestora-demo/finanzas", "/rentas/gestora-demo/acceso-huesped"]);
  });

  it("con lo obligatorio listo avisa que solo faltan recomendados", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(CHECKLIST({ listoParaOperar: true }))));
    rendered = montar();
    await esperar();
    expect(rendered.container.textContent).toContain("Lo obligatorio está listo");
  });

  it("no pinta nada cuando todo esta listo, cuando no hay nada medible (base sin migrar) o cuando el servidor responde 403 por membership acotada", async () => {
    for (const respuesta of [
      json(CHECKLIST({ hechos: 3, porcentaje: 100, listoParaOperar: true })),
      json({ puntos: [punto("ical", "no_disponible", "ical-sync")], medibles: 0, hechos: 0, porcentaje: 0, listoParaOperar: false }),
      json({ message: "El checklist de onboarding es de toda la organización: requiere acceso a todas las propiedades." }, 403),
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => respuesta));
      rendered = montar();
      await esperar();
      expect(rendered.container.querySelector('[data-testid="onboarding-checklist"]')).toBeNull();
      expect(rendered.container.textContent).toBe("");
      rendered.unmount();
      rendered = undefined;
    }
  });

  it("un fallo del servidor se ve con su mensaje y 'Reintentar' vuelve a pedir el checklist", async () => {
    let llamadas = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        llamadas += 1;
        return llamadas === 1 ? json({ message: "Servicio no disponible" }, 503) : json(CHECKLIST());
      }),
    );
    rendered = montar();
    await esperar();
    const reintentar = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Reintentar"));
    expect(reintentar).toBeDefined();
    click(reintentar!);
    await esperar();
    expect(llamadas).toBe(2);
    expect(rendered.container.textContent).toContain("Configura tu gestora");
  });
});

describe("fetchChecklistOnboarding", () => {
  it("un estado desconocido del servidor se trata como no disponible (nunca se inventa 'hecho')", async () => {
    const fetchImpl = vi.fn(async () => json({ puntos: [punto("ical", "raro", "ical-sync")], medibles: 1, hechos: 0, porcentaje: 0, listoParaOperar: false })) as unknown as typeof fetch;
    const r = await fetchChecklistOnboarding(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(r.estado === "ok" && r.checklist.puntos[0]?.estado).toBe("no_disponible");
  });

  it("un 403 que no es de membership acotada se propaga como error", async () => {
    const fetchImpl = vi.fn(async () => json({ message: "Rol no autorizado" }, 403)) as unknown as typeof fetch;
    await expect(fetchChecklistOnboarding(fetchImpl, "http://api.local", "tok", "prop-1")).rejects.toThrow();
  });
});
