// @vitest-environment jsdom
//
// Smoke tests reales de <MonitorSyncPage /> (Rn-01/Rn-02): conflictos entre canales,
// alertas del sync, estado de feeds, acciones de resolver/atender y degradación honesta
// contra la base sin migrar. Mismo patrón que rentas-auditoria-page.spec.tsx.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MonitorSyncPage } from "../src/verticals/rentas/pages/MonitorSync.tsx";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

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
  zona_horaria: "America/Cancun",
  resumen_por_canal: [
    { canal: "airbnb", total_feeds: 1, peor: "en_cuarentena", unidades_con_problema: 1, por_salud: { ok: 0, desactualizado: 0, en_backoff: 0, en_cuarentena: 1, sin_sincronizar: 0, inactivo: 0 }, sincronizacion_mas_antigua_en: null },
  ],
  feeds: [
    { id: "f1", unidad_id: "u1", unidad_nombre: "Casa del mar", canal: "airbnb", activo: true, salud: "en_cuarentena", ultima_sincronizacion_exitosa_en: null, en_cuarentena_desde: "2026-10-01T10:00:00.000Z", motivo_cuarentena: "3 intentos", intentos_fallidos_consecutivos: 3, ultimo_intento_en: null, proximo_intento_en: null },
  ],
  alertas: { disponible: true, abiertas: [{ id: "a1", unidad_id: "u1", unidad_nombre: "Casa del mar", canal: "booking", tipo: "conflicto_detectado", severidad: "critica", detalle: "1 conflicto(s) de calendario detectado(s)", eventos_aplicados: 1, conflictos: 1, creado_en: "2026-10-01T11:00:00.000Z" }] },
  conflictos_abiertos: 1,
};
const CONFLICTOS = {
  zona_horaria: "America/Cancun",
  total_abiertos: 1,
  conflictos: [
    {
      id: "k1", estado: "abierto", motivo_resolucion: null, unidad_id: "u1", unidad_nombre: "Casa del mar", tipo: "overbooking_confirmado", detectado_en: "2026-10-01T11:00:00.000Z", detectado_en_local: "2026-10-01 06:00",
      resuelto_en: null, resuelto_en_local: null, resuelto_por_mi: false, solape: { inicio: "2027-05-12", fin: "2027-05-14", vigencia: "futuro" },
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
    // Estado del conflicto, solape real con su vigencia, hora local de la property y salud por canal.
    expect(texto).toContain("Abierto");
    expect(texto).toContain("Noches en conflicto: 2027-05-12 → 2027-05-14 (por venir)");
    expect(texto).toContain("2026-10-01 06:00");
    expect(texto).toContain("Salud por canal");
  });

  it("Marcar resuelto hace POST al conflicto y recarga el monitor", async () => {
    const posts: string[] = [];
    const cuerpos: unknown[] = [];
    let resuelto = false;
    const fetchMock = respuestasPorUrl((url, init) => {
      if (init?.method === "POST") {
        posts.push(url);
        cuerpos.push(JSON.parse(String(init.body)));
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
    expect(cuerpos).toEqual([{ accion: "resuelto" }]);
    expect(rendered.container.textContent).toContain("Sin conflictos abiertos");
  });

  it("si el solape sigue vigente el servidor responde 409 y la pantalla muestra el motivo sin romperse", async () => {
    const fetchMock = respuestasPorUrl((_url, init) =>
      init?.method === "POST" ? ({ ok: false, status: 409, json: async () => ({ message: "Las dos reservas siguen cruzadas: cancela una en su canal y vuelve a sincronizar, o ignora el conflicto indicando el motivo." }) } as unknown as Response) : undefined,
    );
    vi.stubGlobal("fetch", fetchMock);
    rendered = montar("admin_gestora");
    await esperar();
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Marcar resuelto"))!);
    await esperar();
    expect(rendered.container.textContent).toContain("siguen cruzadas");
    expect(rendered.container.textContent).toContain("Overbooking entre reservas"); // el conflicto sigue abierto en pantalla
  });

  it("Ignorar exige un motivo: sin él no hay POST; con él se envía { accion: 'ignorado', motivo }", async () => {
    const cuerpos: unknown[] = [];
    const fetchMock = respuestasPorUrl((_url, init) => {
      if (init?.method === "POST") {
        cuerpos.push(JSON.parse(String(init.body)));
        return json({ id: "k1", resuelto: true, estado: "ignorado" });
      }
      return undefined;
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = montar("admin_gestora");
    await esperar();
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Ignorar…"))!);
    await esperar();

    const form = rendered.container.querySelector("form")!;
    await act(async () => {
      await submitForm(form);
    });
    await esperar();
    expect(cuerpos).toEqual([]);
    expect(rendered.container.textContent).toContain("escribe el motivo");

    changeValue(rendered.container.querySelector("textarea")!, "  mismo huésped en dos plataformas ");
    await act(async () => {
      await submitForm(rendered!.container.querySelector("form")!);
    });
    await esperar();
    expect(cuerpos).toEqual([{ accion: "ignorado", motivo: "mismo huésped en dos plataformas" }]);
  });

  it("el filtro Ignorados pide ?estado=ignorados y muestra estado, motivo e historial de la decisión", async () => {
    const cerrado = {
      ...CONFLICTOS.conflictos[0],
      estado: "ignorado",
      motivo_resolucion: "mismo huésped",
      resuelto_en: "2026-10-02T05:30:00.000Z",
      resuelto_en_local: "2026-10-02 00:30",
      resuelto_por_mi: true,
    };
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      respuestasPorUrl((url) => {
        urls.push(url);
        if (url.includes("/conflictos?estado=ignorados")) return json({ zona_horaria: "America/Cancun", total_abiertos: 0, conflictos: [cerrado] });
        if (url.endsWith("/historial")) return json({ disponible: true, zona_horaria: "America/Cancun", entradas: [{ id: "h1", accion: "ignorado", motivo: "mismo huésped", creado_en: "2026-10-02T05:30:00.000Z", creado_en_local: "2026-10-02 00:30", por_mi: true }] });
        return undefined;
      }),
    );
    rendered = montar("admin_gestora");
    await esperar();
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Ignorados")!);
    await esperar();
    expect(urls.some((u) => u.includes("/conflictos?estado=ignorados"))).toBe(true);
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Ignorado");
    expect(texto).toContain("Motivo: mismo huésped");
    expect(texto).toContain("Cerrado: 2026-10-02 00:30");
    // Un conflicto cerrado ya no ofrece resolver/ignorar, solo ver su historial.
    expect(texto).not.toContain("Marcar resuelto");
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Ver historial"))!);
    await esperar();
    expect(rendered.container.textContent).toContain("Ignorado por ti — mismo huésped");
  });

  it("contra la base sin la migración 026 el historial dice que aún no está habilitado (honesto, sin romper)", async () => {
    const cerrado = { ...CONFLICTOS.conflictos[0], estado: "resuelto", resuelto_en: "2026-10-02T05:30:00.000Z", resuelto_en_local: "2026-10-02 00:30" };
    vi.stubGlobal(
      "fetch",
      respuestasPorUrl((url) => {
        if (url.includes("/conflictos?estado=todos")) return json({ zona_horaria: "America/Cancun", total_abiertos: 0, conflictos: [cerrado] });
        if (url.endsWith("/historial")) return json({ disponible: false, zona_horaria: "America/Cancun", entradas: [] });
        return undefined;
      }),
    );
    rendered = montar("admin_gestora");
    await esperar();
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Todos")!);
    await esperar();
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Ver historial"))!);
    await esperar();
    expect(rendered.container.textContent).toContain("todavía no está habilitado");
  });

  it("operador:solo_calendario ve el monitor pero NO tiene botones de resolver/atender", async () => {
    vi.stubGlobal("fetch", respuestasPorUrl());
    rendered = montar("operador:solo_calendario");
    await esperar();
    expect(rendered.container.textContent).toContain("Overbooking entre reservas");
    expect(rendered.container.textContent).not.toContain("Marcar resuelto");
    expect(rendered.container.textContent).not.toContain("Marcar atendida");
    expect(rendered.container.textContent).not.toContain("Ignorar…");
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
