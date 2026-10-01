// @vitest-environment jsdom
//
// Smoke tests reales de <MonitorSyncPage /> (Rn-01/Rn-02): conflictos entre canales,
// alertas del sync, estado de feeds, acciones de resolver/atender y degradación honesta
// contra la base sin migrar. Mismo patrón que rentas-auditoria-page.spec.tsx.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MonitorSyncPage } from "../src/verticals/rentas/pages/MonitorSync.tsx";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const json = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 409, json: async () => body }) as unknown as Response;

function sesion(rol: string): LoginSession {
  return { token: "tok", refreshToken: "ref", email: "staff@example.com", organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora", vertical: "rentas", rol }] };
}

const MONITOR = {
  ahora: "2026-10-01T12:00:00.000Z",
  feeds: [
    { id: "f1", unidad_id: "u1", unidad_nombre: "Casa del mar", canal: "airbnb", activo: true, salud: "en_cuarentena", ultima_sincronizacion_exitosa_en: null, en_cuarentena_desde: "2026-10-01T10:00:00.000Z", motivo_cuarentena: "3 intentos", intentos_fallidos_consecutivos: 3, ultimo_intento_en: null, proximo_intento_en: null },
  ],
  alertas: { disponible: true, abiertas: [{ id: "a1", unidad_id: "u1", unidad_nombre: "Casa del mar", canal: "booking", tipo: "conflicto_detectado", severidad: "critica", detalle: "1 conflicto(s) de calendario detectado(s)", eventos_aplicados: 1, conflictos: 1, creado_en: "2026-10-01T11:00:00.000Z" }] },
  conflictos_abiertos: 1,
};
const CONFLICTOS = {
  total_abiertos: 1,
  conflictos: [
    {
      id: "k1", unidad_id: "u1", unidad_nombre: "Casa del mar", tipo: "overbooking_confirmado", detectado_en: "2026-10-01T11:00:00.000Z", resuelto_en: null,
      ocupacion_a: { id: "o1", inicio: "2027-05-10", fin: "2027-05-14", estado: "confirmado", capa: "reserva", canal: "airbnb" },
      ocupacion_b: { id: "o2", inicio: "2027-05-12", fin: "2027-05-16", estado: "conflicto_pendiente", capa: "reserva", canal: "booking" },
    },
  ],
};

function montar(rol: string): RenderedComponent {
  return renderComponent(<MonitorSyncPage apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" setPropertyId={() => {}} properties={[]} orgSlug="gestora-demo" session={sesion(rol)} />);
}

function respuestasPorUrl(extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const custom = extra(url, init);
    if (custom) return custom;
    if (url.endsWith("/sync-monitor")) return json(MONITOR);
    if (url.includes("/conflictos?estado=abiertos")) return json(CONFLICTOS);
    throw new Error(`url inesperada: ${url}`);
  });
}

describe("MonitorSyncPage", () => {
  it("muestra los dos canales en pugna, la alerta crítica y el feed en cuarentena", async () => {
    vi.stubGlobal("fetch", respuestasPorUrl());
    rendered = montar("admin_gestora");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Overbooking entre reservas");
    expect(texto).toContain("airbnb: 2027-05-10 → 2027-05-14");
    expect(texto).toContain("booking: 2027-05-12 → 2027-05-16");
    expect(texto).toContain("Crítica");
    expect(texto).toContain("En cuarentena");
    expect(texto).toContain("3 fallo(s) seguidos");
  });

  it("Marcar resuelto hace POST al conflicto y recarga el monitor", async () => {
    const posts: string[] = [];
    let resuelto = false;
    const fetchMock = respuestasPorUrl((url, init) => {
      if (init?.method === "POST") {
        posts.push(url);
        resuelto = true;
        return json({ id: "k1", resuelto: true });
      }
      if (resuelto && url.includes("/conflictos?estado=abiertos")) return json({ total_abiertos: 0, conflictos: [] });
      if (resuelto && url.endsWith("/sync-monitor")) return json({ ...MONITOR, conflictos_abiertos: 0 });
      return undefined;
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = montar("admin_gestora");
    await esperar();

    const boton = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Marcar resuelto"));
    expect(boton).toBeDefined();
    click(boton!);
    await esperar();

    expect(posts).toEqual(["http://api.local/rentas/prop-1/conflictos/k1/resolver"]);
    expect(rendered.container.textContent).toContain("Sin conflictos abiertos");
  });

  it("operador:solo_calendario ve el monitor pero NO tiene botones de resolver/atender", async () => {
    vi.stubGlobal("fetch", respuestasPorUrl());
    rendered = montar("operador:solo_calendario");
    await esperar();
    expect(rendered.container.textContent).toContain("Overbooking entre reservas");
    expect(rendered.container.textContent).not.toContain("Marcar resuelto");
    expect(rendered.container.textContent).not.toContain("Marcar atendida");
  });

  it("un rol sin acceso (contador) no dispara ninguna llamada de red", async () => {
    const fetchMock = respuestasPorUrl();
    vi.stubGlobal("fetch", fetchMock);
    rendered = montar("contador");
    await esperar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("no tiene acceso al monitor");
  });

  it("contra la base sin migrar: alertas no disponibles (honesto), los conflictos siguen visibles", async () => {
    vi.stubGlobal("fetch", respuestasPorUrl((url) => (url.endsWith("/sync-monitor") ? json({ ...MONITOR, alertas: { disponible: false, abiertas: [] } }) : undefined)));
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("Alertas no disponibles aún");
    expect(rendered.container.textContent).toContain("Overbooking entre reservas");
  });

  it("un error de red muestra el estado de error con Reintentar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("network down");
    expect(Array.from(rendered.container.querySelectorAll("button")).some((b) => b.textContent?.includes("Reintentar"))).toBe(true);
  });
});
