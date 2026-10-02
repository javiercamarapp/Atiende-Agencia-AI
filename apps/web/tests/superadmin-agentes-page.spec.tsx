// @vitest-environment jsdom
// Panel de agentes (SA-L-08) y bitacora de corridas (SA-L-07): las 11 columnas, la palanca real sobre
// platform_switch (motivo, confirmacion; Cancelar nunca ejecuta), estados honestos y la traza de una corrida.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminAgentesPage } from "../src/superadmin/pages/Agentes.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body, clone() { return this; } }) as unknown as Response;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const sinInterruptor = { bloqueado: false, motivo: null, actualizadoEnMs: null };
const PANEL = {
  disponible: true,
  interruptoresDisponible: true,
  agentes: [
    {
      id: "restaurantes:whatsapp_agent", nombre: "Agente de WhatsApp de restaurantes", vertical: "restaurantes", canal: "whatsapp", disparador: "Mensaje entrante de un comensal", estado: "vivo",
      modelo: "deepseek/deepseek-v4.1-flash", ultimaCorrida: { en: "2026-09-30T17:20:00.000Z", estado: "fallo" }, interruptor: sinInterruptor,
      exito30d: { corridas: 3, ok: 2, porcentaje: 66.7 }, costo30dUsd: 0.02, llamadas30d: 2, presupuestoDiaUsd: 5, insumos: "fuera de alcance",
    },
    {
      id: "hoteles:whatsapp_agent", nombre: "Agente de WhatsApp de hoteles", vertical: "hoteles", canal: "whatsapp", disparador: "Mensaje entrante de un huesped", estado: "vivo",
      modelo: null, ultimaCorrida: null, interruptor: { bloqueado: true, motivo: "Incidente verificado en produccion hoy", actualizadoEnMs: 1_760_000_000_000 },
      exito30d: { corridas: 0, ok: 0, porcentaje: null }, costo30dUsd: 0, llamadas30d: 0, presupuestoDiaUsd: null, insumos: "fuera de alcance",
    },
  ],
};
const CORRIDAS = {
  disponible: true,
  corridas: [
    { id: "r1", agente: "/internal/rentas/ical-sync", vertical: "rentas", organizationId: null, disparo: "cron", estado: "fallo", tareasHechas: 3, tareasTotal: 4, costoUsd: null, error: "timeout del proveedor [correo]", iniciadoEn: "2026-09-30T17:45:00.000Z", terminadoEn: "2026-09-30T17:45:01.000Z", duracionMs: 900 },
  ],
};

interface Opciones {
  readonly panel?: unknown;
  readonly corridas?: unknown;
  readonly put?: () => Response;
}
function stubFetch(o: Opciones = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") return o.put ? o.put() : json({ interruptor: {} });
    if (String(url).includes("/superadmin/agentes/corridas")) return json(o.corridas ?? CORRIDAS);
    return json(o.panel ?? PANEL);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const puts = (m: ReturnType<typeof stubFetch>) => m.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "PUT");
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (texto: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;
const botonPagina = (r: RenderedComponent, nombre: string) => r.container.querySelector(`button[aria-label="${nombre}"]`) as HTMLButtonElement;

async function montar(): Promise<RenderedComponent> {
  const r = renderComponent(<SuperAdminAgentesPage apiBaseUrl="https://api.test" token="tok" />);
  await esperar();
  return r;
}

describe("SuperAdminAgentesPage", () => {
  it("muestra las 11 columnas de Likida y los datos reales de cada fila (sin sembrar nada en el cliente)", async () => {
    stubFetch();
    rendered = await montar();
    const encabezados = [...rendered.container.querySelectorAll("table")[0]!.querySelectorAll("th")].map((th) => th.textContent?.trim());
    expect(encabezados).toEqual(["Agente", "Departamento", "Estado", "Disparador", "Última corrida", "Kill switch", "Modelo", "Éxito 30d", "Costo 30d", "Presupuesto/día", "Insumos"]);
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Agente de WhatsApp de restaurantes");
    expect(t).toContain("restaurantes:whatsapp_agent");
    expect(t).toContain("deepseek/deepseek-v4.1-flash");
    expect(t).toMatch(/66[.,]7 %/);
    expect(t).toMatch(/US\$ 0[.,]02/);
    expect(t).toMatch(/US\$ 5[.,]00/);
    expect(t).toContain("Sin corridas"); // el agente sin corridas NO muestra 0 %
    expect(t).toContain("Sin tope");
    expect(t).toContain("fuera de alcance");
  });

  it("la palanca refleja platform_switch: Activo con 'Detener' y Detenido con 'Reactivar'", async () => {
    stubFetch();
    rendered = await montar();
    expect(botonPagina(rendered, "Detener Agente de WhatsApp de restaurantes")).not.toBeNull();
    expect(botonPagina(rendered, "Reactivar Agente de WhatsApp de hoteles")).not.toBeNull();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Activo");
    expect(t).toContain("Detenido");
  });

  it("Detener abre un dialogo SIN llamar al servidor; el motivo corto deshabilita Confirmar; Cancelar nunca ejecuta", async () => {
    const m = stubFetch();
    rendered = await montar();
    click(botonPagina(rendered, "Detener Agente de WhatsApp de restaurantes"));
    await esperar();
    expect(dialogo()).not.toBeNull();
    expect(puts(m)).toHaveLength(0);
    expect(botonDialogo("Detener agente").disabled).toBe(true);
    changeValue(dialogo()!.querySelector("textarea")!, "corto");
    expect(botonDialogo("Detener agente").disabled).toBe(true);
    await act(async () => {
      click(botonDialogo("Cancelar"));
      await flushMicrotasks();
    });
    expect(puts(m)).toHaveLength(0);
    expect(dialogo()).toBeNull();
  });

  it("Escape cierra el dialogo y tampoco ejecuta", async () => {
    const m = stubFetch();
    rendered = await montar();
    click(botonPagina(rendered, "Detener Agente de WhatsApp de restaurantes"));
    await esperar();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushMicrotasks();
    });
    expect(puts(m)).toHaveLength(0);
  });

  it("confirmar con motivo de 20+ caracteres manda UN PUT /superadmin/interruptores (scope agente, id del agente) y recarga el panel", async () => {
    const m = stubFetch();
    rendered = await montar();
    const lecturasAntes = m.mock.calls.filter((c) => !(c[1] as RequestInit | undefined)?.method).length;
    click(botonPagina(rendered, "Detener Agente de WhatsApp de restaurantes"));
    await esperar();
    changeValue(dialogo()!.querySelector("textarea")!, "Incidente verificado: el proveedor reporta caida");
    await act(async () => {
      click(botonDialogo("Detener agente"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(puts(m)).toHaveLength(1);
    const [url, init] = puts(m)[0]!;
    expect(String(url)).toBe("https://api.test/superadmin/interruptores");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ scope: "agente", target: "restaurantes:whatsapp_agent", bloqueado: true, motivo: "Incidente verificado: el proveedor reporta caida" });
    expect(m.mock.calls.filter((c) => !(c[1] as RequestInit | undefined)?.method).length).toBeGreaterThan(lecturasAntes);
  });

  it("Reactivar un agente detenido manda bloqueado:false", async () => {
    const m = stubFetch();
    rendered = await montar();
    click(botonPagina(rendered, "Reactivar Agente de WhatsApp de hoteles"));
    await esperar();
    changeValue(dialogo()!.querySelector("textarea")!, "Incidente resuelto: el proveedor ya responde");
    await act(async () => {
      click(botonDialogo("Reactivar agente"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(JSON.parse(String((puts(m)[0]![1] as RequestInit).body))).toMatchObject({ target: "hoteles:whatsapp_agent", bloqueado: false });
  });

  it("si el servidor rechaza (p. ej. step-up cancelado), el dialogo SIGUE abierto y no se recarga como si hubiera funcionado", async () => {
    const m = stubFetch({ put: () => json({ message: "Se requiere verificación MFA reciente." }, false) });
    rendered = await montar();
    click(botonPagina(rendered, "Detener Agente de WhatsApp de restaurantes"));
    await esperar();
    changeValue(dialogo()!.querySelector("textarea")!, "Incidente verificado: el proveedor reporta caida");
    await act(async () => {
      click(botonDialogo("Detener agente"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(puts(m)).toHaveLength(1);
    expect(dialogo()).not.toBeNull();
  });

  it("sin lectura del interruptor (migracion 0025 pendiente) la columna dice 'No disponible aun' y no hay boton", async () => {
    stubFetch({ panel: { ...PANEL, interruptoresDisponible: false, agentes: PANEL.agentes.map((a) => ({ ...a, interruptor: null })) } });
    rendered = await montar();
    expect(rendered.container.textContent).toContain("No disponible aún");
    expect(rendered.container.textContent).toContain("Interruptores no disponibles aún");
    expect(rendered.container.querySelector('button[aria-label^="Detener"]')).toBeNull();
  });

  it("base sin migrar: aviso honesto, sin tablas ni controles", async () => {
    stubFetch({ panel: { disponible: false, razon: "No disponible aún: falta aplicar la migración 0044_superadmin_corridas_y_panel_agentes en este despliegue.", interruptoresDisponible: true, agentes: [] } });
    rendered = await montar();
    expect(rendered.container.textContent).toContain("Todavía no disponible en esta base");
    expect(rendered.container.textContent).toContain("0044_superadmin_corridas_y_panel_agentes");
    expect(rendered.container.querySelector("table")).toBeNull();
    expect(rendered.container.querySelector("button[aria-label]")).toBeNull();
  });

  it("error de red: estado de error con reintento, no se queda en 'Cargando'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    rendered = await montar();
    expect(rendered.container.textContent).toContain("No se pudo cargar el panel de agentes");
    expect(rendered.container.textContent).not.toContain("Cargando");
  });

  it("corridas recientes: lista y abre la traza con el error redactado; sin corridas, estado vacio", async () => {
    stubFetch();
    rendered = await montar();
    expect(rendered.container.textContent).toContain("/internal/rentas/ical-sync");
    const fila = [...rendered.container.querySelectorAll("tr")].find((tr) => tr.textContent?.includes("/internal/rentas/ical-sync"))!;
    click(fila);
    await esperar();
    const d = document.body.querySelector('[role="dialog"]')!;
    expect(d.textContent).toContain("Traza de la corrida");
    expect(d.textContent).toContain("timeout del proveedor [correo]");
    expect(d.textContent).toContain("3 de 4");
    expect(d.textContent).toContain("Plataforma (sin organización)");
  });

  it("filtrar por estado pide al servidor solo esas corridas", async () => {
    const m = stubFetch();
    rendered = await montar();
    const selects = rendered.container.querySelectorAll("select");
    changeValue(selects[1] as HTMLSelectElement, "fallo");
    await esperar();
    const urls = m.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/superadmin/agentes/corridas") && u.includes("estado=fallo"))).toBe(true);
  });

  it("bitacora sin migrar: aviso en la seccion de corridas, el panel sigue", async () => {
    stubFetch({ corridas: { disponible: false, razon: "No disponible aún: falta aplicar la migración 0044.", corridas: [] } });
    rendered = await montar();
    expect(rendered.container.textContent).toContain("Bitácora no disponible aún");
    expect(rendered.container.textContent).toContain("Agente de WhatsApp de restaurantes");
  });

  it("sin corridas con los filtros: estado vacio honesto", async () => {
    stubFetch({ corridas: { disponible: true, corridas: [] } });
    rendered = await montar();
    expect(rendered.container.textContent).toContain("Todavía no hay corridas registradas");
  });
});
