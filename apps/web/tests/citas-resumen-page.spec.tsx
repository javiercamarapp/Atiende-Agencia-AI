// @vitest-environment jsdom
//
// <ResumenPage /> (citas, UNI-RES-citas): TODA cifra viene de los endpoints (API simulada con datos sembrados), el rol staff
// no ve los tiles de agentes, y los estados honestos (sin migrar, error) nunca pintan un número inventado.
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

const CTX = { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", orgId: "org-1", role: "owner", staffFullName: "Sam Torres", staffEmail: "sam@example.com" } as CitasShellContext;

const RESUMEN = {
  timezone: "America/Merida",
  generated_at: "2026-09-30T05:00:00.000Z",
  today: { date: "2026-09-29", total: 3, by_status: { pending: 1, confirmed: 2, completed: 0, cancelled: 1, no_show: 0 } },
  week: { from_date: "2026-09-28", to_date: "2026-10-04", total: 19, by_status: { pending: 2, confirmed: 5, completed: 2, cancelled: 1, no_show: 0 } },
  pending_to_confirm: 4,
  no_shows_last_30_days: 2,
  new_customers_last_30_days: 7,
  created_by_source_last_30_days: { voice: 6, whatsapp: 23, web: 4, manual: 1 },
};

const AVISOS = {
  generadoEn: "2026-09-30T05:00:00.000Z",
  porConfirmar: { horas: 72, total: 0, items: [] },
  recordatorios: { visible: true, disponible: true, ventanaDias: 7, filas: [{ canal: "whatsapp", estado: "sent", total: 11 }, { canal: "email", estado: "sent", total: 2 }, { canal: "whatsapp", estado: "failed", total: 1 }, { canal: "whatsapp", estado: "dead", total: 2 }] },
  escalaciones: { visible: true, disponible: true, seguimientoDisponible: true, items: [] },
};

const AGENTE = { disponible: true, agente: { version: 1, config: {}, actualizadoEn: null, promptDeMuestra: "" }, conexion: { numero: { phoneNumberId: "123", activo: true }, estado: "registrado", credencialDeEnvioDisponible: true, nota: "" }, opciones: {} };

type Respuestas = Partial<Record<"resumen" | "avisos" | "agente", { status: number; body: unknown }>>;

function stubFetch(respuestas: Respuestas = {}) {
  const todas = { resumen: { status: 200, body: RESUMEN }, avisos: { status: 200, body: AVISOS }, agente: { status: 200, body: AGENTE }, ...respuestas };
  const fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    const r = u.endsWith("/resumen") ? todas.resumen : u.endsWith("/admin/avisos") ? todas.avisos : u.endsWith("/admin/whatsapp-agente") ? todas.agente : { status: 404, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}

function render(ctx: CitasShellContext = CTX) {
  return renderComponent(
    <MemoryRouter>
      <ResumenPage {...ctx} />
    </MemoryRouter>,
  );
}

const texto = () => rendered?.container.textContent ?? "";
const llamadas = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => String((c as unknown[])[0]));

describe("ResumenPage (citas)", () => {
  it("pinta saludo, destacado y KPIs con las cifras sembradas del API, y un solo h1", async () => {
    stubFetch();
    rendered = render();
    await esperar();

    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.container.querySelector("h1")?.textContent).toMatch(/^(Buenos días|Buenas tardes|Buenas noches), Sam$/);
    expect(texto()).toContain("29 de septiembre");
    expect(texto()).toContain("America/Merida");
    // Destacado "Citas hoy" = 3 (odómetro de 3 dígitos).
    const odometro = rendered.container.querySelector('[data-testid="odometro"]');
    expect(odometro?.getAttribute("aria-label")).toContain("Citas hoy");
    expect(odometro?.textContent).toContain("Citas hoy");
    const kpi = (etiqueta: string) => [...rendered!.container.querySelectorAll("a")].find((a) => a.textContent?.includes(etiqueta))?.textContent ?? "";
    expect(kpi("Citas esta semana")).toContain("19");
    expect(kpi("Por confirmar")).toContain("4");
    expect(kpi("No asistieron")).toContain("2");
    expect(kpi("Clientes nuevos")).toContain("7");
    expect([...rendered.container.querySelectorAll('a[href="/citas/demo/agenda"]')].some((a) => a.textContent?.includes("Ver agenda"))).toBe(true);
  });

  it("owner: cada métrica de los tiles de agentes sale de su endpoint (canales, entrega de recordatorios, conexión)", async () => {
    const fetchMock = stubFetch();
    rendered = render();
    await esperar();

    const urls = llamadas(fetchMock);
    expect(urls).toContain("https://api.test/v1/citas/properties/prop-1/resumen");
    expect(urls).toContain("https://api.test/v1/citas/properties/prop-1/admin/avisos");
    expect(urls).toContain("https://api.test/v1/citas/properties/prop-1/admin/whatsapp-agente");
    const tile = (titulo: string) => [...rendered!.container.querySelectorAll("a")].find((a) => a.textContent?.includes(titulo))?.textContent ?? "";
    expect(tile("Agente de WhatsApp")).toContain("23 citas creadas por WhatsApp (30 días)");
    expect(tile("Agente de WhatsApp")).toContain("Conectado");
    expect(tile("Recordatorios 24 h")).toContain("13 enviados · 3 fallidos (7 días)");
    expect(tile("Voz")).toContain("6 citas creadas por voz (30 días)");
    expect(tile("Copiloto")).toContain("Pregunta a tus datos");
    expect(rendered.container.querySelector('a[href="/citas/demo/copiloto"]')).not.toBeNull();
    // Última corrida: estado honesto, sin fechas ni estados inventados.
    expect(rendered.container.querySelector('[data-testid="sin-datos-corrida"]')?.textContent).toContain("Sin datos de corrida");
  });

  it("staff: ve los conteos de citas pero NO los tiles de agentes ni dispara sus lecturas", async () => {
    const fetchMock = stubFetch();
    rendered = render({ ...CTX, role: "staff" });
    await esperar();

    expect(texto()).toContain("Citas esta semana");
    expect(texto()).not.toContain("Orquestación de agentes");
    expect(texto()).not.toContain("Recordatorios 24 h");
    const urls = llamadas(fetchMock);
    expect(urls.some((u) => u.endsWith("/admin/avisos") || u.endsWith("/admin/whatsapp-agente"))).toBe(false);
  });

  it("base sin migrar: recordatorios no disponibles y servidor sin conteo por canal dicen 'no disponible', sin ceros inventados", async () => {
    const { created_by_source_last_30_days: _omitido, ...sinCanales } = RESUMEN;
    stubFetch({
      resumen: { status: 200, body: sinCanales },
      avisos: { status: 200, body: { ...AVISOS, recordatorios: { visible: true, disponible: false, ventanaDias: 7, filas: [] } } },
    });
    rendered = render();
    await esperar();

    const tile = (titulo: string) => [...rendered!.container.querySelectorAll("a")].find((a) => a.textContent?.includes(titulo))?.textContent ?? "";
    expect(tile("Recordatorios 24 h")).toContain("No disponible aún");
    expect(tile("Recordatorios 24 h")).not.toContain("0 enviados");
    expect(tile("Voz")).toContain("No disponible aún");
    expect(tile("Agente de WhatsApp")).toContain("No disponible aún");
  });

  it("si fallan las lecturas secundarias, los tiles lo dicen y el resto de la página sigue viva", async () => {
    stubFetch({ avisos: { status: 500, body: { message: "boom" } }, agente: { status: 500, body: { message: "boom" } } });
    rendered = render();
    await esperar();

    expect(texto()).toContain("Citas esta semana");
    expect(texto()).toContain("No se pudo cargar el estado de entrega.");
    expect(texto()).toContain("conexión no disponible");
    expect(texto()).not.toContain("Conectado");
  });

  it("si el resumen falla muestra el error con 'Reintentar' y NINGUNA cifra inventada", async () => {
    stubFetch({ resumen: { status: 500, body: { message: "Error interno" } } });
    rendered = render();
    await esperar();

    expect(texto()).toContain("No se pudo cargar");
    expect(texto()).not.toContain("Citas esta semana");
    expect(texto()).toContain("Reintentar");
  });
});
