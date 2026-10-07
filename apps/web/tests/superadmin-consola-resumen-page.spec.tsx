// @vitest-environment jsdom
//
// UNI-RES-superadmin: Resumen de la consola (pages/ConsolaResumen.tsx). Se afirma el EFECTO con la API simulada por ruta real:
//   - campos nulos: "—" con su motivo, nunca 0 (incluidas las 3 ramas de "Resueltas sin humano");
//   - error POR BLOQUE: un endpoint caido pinta su error solo en su bloque y el resto sigue con datos;
//   - enlaces solo a rutas reales de rutas.ts (cero botones muertos): sin "Ver analitica", sin flecha en las fichas de agente;
//   - saludo segun la hora de America/Mexico_City con reloj fijo (independiente de la zona del navegador);
//   - "Entrar": sin motivo de 20+ caracteres no ejecuta; Cancelar y Escape nunca ejecutan.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SuperAdminConsolaResumenPage } from "../src/superadmin/pages/ConsolaResumen.tsx";
import { actividadPorGrupo, costoPorAgente, rutaExiste, saludoMexico, ventanaSerie } from "../src/superadmin/lib/consola-client.ts";
import { PARTE_DIARIO, PIE_SUPERADMIN, RUTAS_SIN_MENU, TODAS_LAS_RUTAS } from "../src/superadmin/rutas.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T15:00:00.000Z")); // 09:00 en CDMX
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const DIAS = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 8, 19 + i)).toISOString().slice(0, 10));

function resumenBase(): Record<string, unknown> {
  return {
    disponible: true,
    generadoEn: "2026-10-02T15:00:00.000Z",
    hoy: "2026-10-02",
    organizaciones: { valor: { total: 6, demo: 1, porVertical: [{ vertical: "restaurantes", total: 3, demo: 1 }, { vertical: "hoteles", total: 3, demo: 0 }] } },
    gastoIa: {
      valor: {
        totalUsd: 41.82,
        llmUsd: 36.1,
        otrosUsd: 5.72,
        porCategoria: [],
        serie14d: { valor: DIAS.map((dia, i) => ({ dia, usd: 1 + i })) },
        delta7d: { valor: { actualUsd: 14.7, previoUsd: 12.6, deltaUsd: 2.1, pct: 16.67 } },
      },
    },
    tokens: { valor: { total: 5_400_000, entrada: 4_100_000, salida: 1_300_000 } },
    operaciones: {
      valor: {
        total: 140,
        porVertical: [],
        serie14d: DIAS.map((dia, i) => ({ dia, cantidad: 5 + i })),
        verticalesSinFuente: ["despachos"],
      },
    },
    vozMinutos: { valor: 318.5 },
    sucursales: { valor: 11 },
    usuarios: { valor: { total: 27, staff: 26, superadmins: 1 } },
    conversacionesWa: {
      valor: {
        total: 214,
        porVertical: [
          { vertical: "restaurantes", total: 120 },
          { vertical: "hoteles", total: 94 },
          { vertical: "rentas", total: null, codigo: "sin_whatsapp", razon: "Sin fuente: esta vertical no guarda conversaciones de WhatsApp." },
        ],
      },
    },
    resueltasSinHumano: { valor: { dia: "2026-10-02", resueltas: 18, total: 24, porcentaje: 75, nota: "medido solo en restaurantes" } },
    mrr: { valor: { totalMxn: 48_900, organizacionesConPrecio: 4, organizacionesSinPrecio: 2 } },
  };
}

function agentesBase(): Record<string, unknown> {
  return {
    disponible: true,
    hoy: "2026-10-02",
    agentes: {
      valor: [
        { vertical: "restaurantes", role: "restaurantes:whatsapp_agent", historico: { llamadas: 1840, costoUsd: 21.4, fallbacks: 12 }, ultimos30Dias: { llamadas: 610, costoUsd: 7.2, fallbacks: 3 } },
        { vertical: "hoteles", role: "hoteles:whatsapp_agent_escalated", historico: { llamadas: 160, costoUsd: 1.1, fallbacks: 0 }, ultimos30Dias: { llamadas: 60, costoUsd: 0.4, fallbacks: 0 } },
        { vertical: "despachos", role: "despachos:conciliacion_llm_agent", historico: { llamadas: 140, costoUsd: 2.2, fallbacks: 0 }, ultimos30Dias: { llamadas: 40, costoUsd: 0.6, fallbacks: 0 } },
        { vertical: "restaurantes", role: "restaurantes:data_chat", historico: { llamadas: 10, costoUsd: 0.5, fallbacks: 0 }, ultimos30Dias: { llamadas: 10, costoUsd: 0.5, fallbacks: 0 } },
      ],
    },
    ultimaCorrida: {
      valor: [
        { cron: "/internal/citas/confirmacion-cita", vertical: "citas", nombre: "Recordatorios de citas", estado: "ok", terminoEn: "2026-10-02T14:30:02.000Z", duracionMs: 2100, fallosConsecutivos: 0, tareas: "no medido" },
        { cron: "/internal/rentas/ical-sync", vertical: "rentas", nombre: "Sincronización iCal de rentas", estado: "error", terminoEn: "2026-10-02T14:45:01.000Z", duracionMs: 900, fallosConsecutivos: 2, tareas: "no medido" },
        { cron: "/internal/hoteles/auditoria", vertical: "hoteles", nombre: "Auditoría nocturna de hoteles", estado: "ok", terminoEn: null, duracionMs: null, fallosConsecutivos: 0, tareas: "no medido" },
      ],
    },
  };
}

const ORGS = [
  { id: "org-1", vertical: "restaurantes", name: "Taquería El Faro con un nombre larguísimo que debe truncarse en móvil", slug: "faro", status: "active", createdAt: "2026-03-01T00:00:00Z", staffCount: 5 },
  { id: "org-2", vertical: "hoteles", name: "Hotel Casa Azul", slug: "azul", status: "trial", createdAt: "2026-03-02T00:00:00Z", staffCount: 3 },
];

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

interface Opciones {
  resumen?: Record<string, unknown> | "fallo";
  agentes?: Record<string, unknown> | "fallo";
  organizaciones?: unknown[] | "fallo";
  post?: (cuerpo: unknown) => Response;
  /** Tablero de fijados del Copiloto de plataforma: lista de `GET /superadmin/copiloto/pins`, o el estado HTTP con que responde (403 = sin tablero). Por defecto, sin fijados. */
  fijados?: unknown[] | number;
}

function stubApi(o: Opciones = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const ruta = new URL(url).pathname;
    if (init?.method === "POST") {
      if (ruta !== "/superadmin/impersonacion/sesiones") throw new Error(`POST inesperado: ${ruta}`);
      return o.post ? o.post(JSON.parse(String(init.body))) : json({ session: { id: "s1" } }, 201);
    }
    if (ruta === "/superadmin/copiloto/pins") return typeof o.fijados === "number" ? json({ message: "x" }, o.fijados) : json({ disponible: true, pins: o.fijados ?? [] });
    if (/^\/superadmin\/copiloto\/pins\/[^/]+\/resultado$/.test(ruta)) return json({ id: "p1", titulo: "Actividad por negocio", status: "ok", text: "3 organizaciones, 2 con actividad", blocks: [], sources: [] });
    if (ruta === "/superadmin/consola/resumen") return o.resumen === "fallo" ? json({ message: "boom" }, 500) : json(o.resumen ?? resumenBase());
    if (ruta === "/superadmin/consola/agentes-actividad") return o.agentes === "fallo" ? json({ message: "boom" }, 500) : json(o.agentes ?? agentesBase());
    if (ruta === "/superadmin/organizations") return o.organizaciones === "fallo" ? json({ message: "boom" }, 500) : json({ organizations: o.organizaciones ?? ORGS });
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

async function montar(props: { staffFullName?: string; staffEmail?: string } = { staffFullName: "Ana María Torres", staffEmail: "ana@example.com" }): Promise<RenderedComponent> {
  const r = renderComponent(
    <MemoryRouter initialEntries={["/superadmin"]}>
      <SuperAdminConsolaResumenPage apiBaseUrl="https://api.test" token="tok-123" {...props} />
    </MemoryRouter>,
  );
  await esperar();
  return r;
}

const texto = () => rendered!.container.textContent ?? "";
const posts = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST");
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (nombre: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === nombre) as HTMLButtonElement;
const tarjeta = (etiqueta: string): HTMLElement => {
  const el = [...rendered!.container.querySelectorAll('[data-testid="stat-card-chip"]')].map((c) => c.parentElement!.parentElement!.parentElement as HTMLElement).find((t) => t.textContent?.includes(etiqueta));
  if (!el) throw new Error(`sin tarjeta ${etiqueta}`);
  return el;
};

describe("saludo en hora de Mexico (reloj fijo)", () => {
  it("09:00 CDMX = Buenos días; 14:00 = Buenas tardes; 20:00 = Buenas noches; 03:00 = Buenas noches", () => {
    expect(saludoMexico(new Date("2026-10-02T15:00:00.000Z"))).toBe("Buenos días");
    expect(saludoMexico(new Date("2026-10-02T20:00:00.000Z"))).toBe("Buenas tardes");
    expect(saludoMexico(new Date("2026-10-03T02:00:00.000Z"))).toBe("Buenas noches");
    expect(saludoMexico(new Date("2026-10-02T09:00:00.000Z"))).toBe("Buenas noches");
  });

  it("la pagina saluda con el primer nombre y UN solo h1", async () => {
    stubApi();
    rendered = await montar();
    const h1 = rendered.container.querySelectorAll("h1");
    expect(h1).toHaveLength(1);
    expect(h1[0]!.textContent).toBe("Buenos días, Ana");
  });

  it("sin nombre en la sesion cae al correo (nunca 'Usuario')", async () => {
    stubApi();
    rendered = await montar({ staffEmail: "ana.torres@example.com" });
    expect(rendered.container.querySelector("h1")!.textContent).toBe("Buenos días, ana.torres");
  });
});

describe("tablero de fijados del Copiloto de plataforma", () => {
  it("pide GET /superadmin/copiloto/pins con el token, re-ejecuta cada fijado y NO ofrece Compartir (el tablero es personal)", async () => {
    const m = stubApi({ fijados: [{ id: "p1", titulo: "Actividad por negocio", herramienta: "ranking_actividad", args: {}, compartido: false, propio: true }] });
    rendered = await montar();
    const urls = m.mock.calls.map((c) => new URL(c[0] as string).pathname);
    expect(urls).toContain("/superadmin/copiloto/pins");
    expect(urls).toContain("/superadmin/copiloto/pins/p1/resultado");
    const headers = (m.mock.calls.find((c) => String(c[0]).endsWith("/superadmin/copiloto/pins"))![1] as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok-123");
    expect(texto()).toContain("Fijados del Copiloto");
    expect(texto()).toContain("3 organizaciones, 2 con actividad");
    expect(rendered.container.querySelector("[aria-label='Quitar Actividad por negocio del tablero']")).not.toBeNull();
    expect(rendered.container.querySelector("[aria-label^='Compartir']")).toBeNull();
  });

  it("sin fijados lo dice y enlaza al Copiloto; con 403 (rol finanzas) o 409 (impersonando) la seccion no se pinta", async () => {
    stubApi({ fijados: [] });
    rendered = await montar();
    expect(texto()).toContain("Aún no fijas nada");
    expect([...rendered.container.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/superadmin/copiloto")).toBe(true);
    rendered.unmount();
    stubApi({ fijados: 403 });
    rendered = await montar();
    expect(texto()).not.toContain("Fijados del Copiloto");
    rendered.unmount();
    stubApi({ fijados: 409 });
    rendered = await montar();
    expect(texto()).not.toContain("Fijados del Copiloto");
  });
});

describe("cifras reales, nulos honestos", () => {
  it("pinta las 9 tarjetas con su cifra y el odometro de MRR con la nota de organizaciones sin precio", async () => {
    stubApi();
    rendered = await montar();
    expect(rendered.container.querySelectorAll('[data-testid="stat-card-chip"]')).toHaveLength(9);
    expect(texto()).toContain("US$41.82");
    expect(texto()).toContain("5,400,000");
    expect(texto()).toContain("18 de 24");
    expect(texto()).toContain("318.5 min");
    expect(texto()).toContain("2 organizaciones sin precio");
    expect(rendered.container.querySelector('[data-testid="odometro"]')!.getAttribute("aria-label")).toContain("$48,900");
    expect(rendered.container.querySelectorAll('[data-testid="odometro-digito"]')).toHaveLength(7);
  });

  it("un campo null pinta '—' con su razon, no 0; el MRR null apaga el odometro con su motivo", async () => {
    const r = resumenBase();
    r.gastoIa = { valor: null, codigo: "no_migrado", razon: "No disponible aún: falta aplicar la migración 0042." };
    r.mrr = { valor: null, codigo: "mrr_sin_repositorio", razon: "No disponible aún: falta la migración 0030." };
    r.sucursales = { valor: null, codigo: "error", razon: "No se pudo leer esta fuente." };
    stubApi({ resumen: r });
    rendered = await montar();
    expect(texto()).toContain("No disponible aún: falta aplicar la migración 0042.");
    expect(texto()).toContain("No disponible aún: falta la migración 0030.");
    expect(rendered.container.querySelector('[data-testid="odometro"]')!.getAttribute("aria-label")).toContain("No disponible aún: falta la migración 0030.");
    expect(texto()).not.toContain("US$0");
    const sucursales = tarjeta("Sucursales");
    expect(sucursales.textContent).toContain("—");
    expect(sucursales.textContent).toContain("No se pudo leer esta fuente.");
  });

  it("Resueltas sin humano: 'X de N', sin conversaciones hoy, y no se pudo leer", async () => {
    stubApi();
    rendered = await montar();
    expect(tarjeta("Resueltas sin humano").textContent).toContain("18 de 24");
    expect(tarjeta("Resueltas sin humano").textContent).toContain("medido solo en restaurantes");
    rendered.unmount();

    const cero = resumenBase();
    cero.resueltasSinHumano = { valor: { dia: "2026-10-02", resueltas: 0, total: 0, porcentaje: null, nota: "medido solo en restaurantes" } };
    stubApi({ resumen: cero });
    rendered = await montar();
    expect(tarjeta("Resueltas sin humano").textContent).toContain("Sin conversaciones hoy");
    rendered.unmount();

    const roto = resumenBase();
    roto.resueltasSinHumano = { valor: null, codigo: "error", razon: "No se pudo leer esta fuente; el resto del resumen sigue disponible." };
    stubApi({ resumen: roto });
    rendered = await montar();
    expect(tarjeta("Resueltas sin humano").textContent).toContain("No se pudo leer esta fuente");
    expect(tarjeta("Resueltas sin humano").textContent).not.toContain("0 de 0");
  });

  it("delta 7d vs 7d: sube el costo = rojo; sin base de comparacion dice 'sin periodo comparable', nunca 0 %", async () => {
    stubApi();
    rendered = await montar();
    expect(tarjeta("Gastado en IA").textContent).toContain("↑ 16.7%");
    expect(tarjeta("Gastado en IA").textContent).toContain("7d vs 7d");
    rendered.unmount();

    const r = resumenBase();
    (r.gastoIa as { valor: { delta7d: unknown } }).valor.delta7d = { valor: { actualUsd: 3, previoUsd: 0, deltaUsd: 3, pct: null } };
    stubApi({ resumen: r });
    rendered = await montar();
    expect(tarjeta("Gastado en IA").textContent).toContain("sin periodo comparable");
  });

  it("Conversaciones por vertical: solo conteo; la vertical sin fuente lista su razon y no una barra en 0", async () => {
    stubApi();
    rendered = await montar();
    const bars = rendered.container.querySelectorAll('[data-testid="hbars-barra"]');
    expect(bars).toHaveLength(2);
    expect(texto()).toContain("Sin fuente: esta vertical no guarda conversaciones de WhatsApp.");
  });
});

describe("error por bloque", () => {
  it("si cae agentes-actividad, solo sus bloques muestran error; las tarjetas y las organizaciones siguen con datos", async () => {
    stubApi({ agentes: "fallo" });
    rendered = await montar();
    expect(rendered.container.querySelectorAll('[role="alert"]').length).toBeGreaterThanOrEqual(3); // orquestacion, corridas y dona
    expect(texto()).toContain("US$41.82");
    expect(texto()).toContain("Hotel Casa Azul");
    expect(texto()).toContain("2 organizaciones sin precio");
  });

  it("si cae el resumen, las 9 tarjetas dicen que no se pudo cargar y los agentes y organizaciones siguen", async () => {
    stubApi({ resumen: "fallo" });
    rendered = await montar();
    expect(rendered.container.querySelectorAll('[data-testid="stat-card-chip"]')).toHaveLength(9);
    expect(texto()).toContain("No se pudo cargar: No se pudo cargar el resumen de la consola.");
    expect(texto()).toContain("Recordatorios de citas");
    expect(texto()).toContain("Hotel Casa Azul");
    expect(texto()).not.toContain("US$0");
  });

  it("si cae la lista de organizaciones, solo su tarjeta falla y trae Reintentar", async () => {
    stubApi({ organizaciones: "fallo" });
    rendered = await montar();
    const region = rendered.container.querySelector('[aria-labelledby="resumen-organizaciones"]')!;
    expect(region.textContent).toContain("No se pudo cargar");
    expect(region.textContent).toContain("Reintentar");
    expect(texto()).toContain("US$41.82");
  });
});

describe("orquestacion y ultima corrida", () => {
  it("las 4 tarjetas dan su linea real; las 3 fichas (SA-L-09) enlazan a su ruta y el Copiloto (CHAT-17, ya con pagina) tambien", async () => {
    stubApi();
    rendered = await montar();
    const enlaces = [...rendered.container.querySelectorAll<HTMLAnchorElement>('a[href^="/superadmin/agente-"]')];
    expect(enlaces.map((a) => a.getAttribute("href")).sort()).toEqual(["/superadmin/agente-conciliacion", "/superadmin/agente-extractor", "/superadmin/agente-whatsapp"]);
    const por = (n: string) => enlaces.find((t) => t.textContent?.includes(n))!;
    expect(por("Agente de WhatsApp y voz").textContent).toContain("2,000 llamadas al modelo · US$22.50 — histórico");
    expect(por("Agente de conciliación").textContent).toContain("140 llamadas al modelo · US$2.20 — histórico");
    expect(por("Agente extractor").textContent).toContain("Sin corridas registradas.");
    // CHAT-17: el Copiloto ya tiene pagina real, asi que su tarjeta es un enlace (ninguna tarjeta queda sin ruta).
    expect(rendered.container.querySelectorAll('[data-testid="tarjeta-agente"]')).toHaveLength(0);
    const copiloto = rendered.container.querySelector<HTMLAnchorElement>('a[href="/superadmin/copiloto"]')!;
    expect(copiloto.textContent).toContain("Copiloto");
    expect(copiloto.textContent).toContain("Sin corridas registradas.");
  });

  it("cada cron es una AgentRunCard con badge OK/Fallo, fecha, vertical, 'tareas: no medido' y 'ver detalle' hacia /superadmin/salud", async () => {
    stubApi();
    rendered = await montar();
    const region = rendered.container.querySelector('[aria-labelledby="resumen-ultima-corrida"]')!;
    expect(region.textContent).toContain("OK");
    expect(region.textContent).toContain("Fallo");
    expect(region.textContent).toContain("Rentas vacacionales");
    expect(region.textContent).toContain("tareas: no medido");
    const enlaces = [...region.querySelectorAll("a")];
    expect(enlaces.length).toBe(2); // el cron sin fecha no tiene corrida: sin enlace
    for (const a of enlaces) {
      expect(a.textContent).toBe("ver detalle");
      expect(a.getAttribute("href")).toBe("/superadmin/salud");
    }
    expect(region.textContent).toContain("Sin corridas registradas.");
  });

  it("la dona agrupa por agente/rol y suma 'Otros roles'", () => {
    const filas = (agentesBase().agentes as { valor: Parameters<typeof costoPorAgente>[0] }).valor;
    expect(costoPorAgente(filas)).toEqual([
      { etiqueta: "Agente de conciliación", valor: 2.2 },
      { etiqueta: "Agente de WhatsApp y voz", valor: 22.5 },
      { etiqueta: "Otros roles", valor: 0.5 },
    ]);
    expect(actividadPorGrupo(filas).find((a) => a.grupo.clave === "copiloto")!.llamadas).toBe(0);
  });
});

describe("enlaces solo a rutas reales", () => {
  it("todo enlace de la pagina apunta a una ruta de rutas.ts; sin 'Ver analitica' (no existe); con 'Ver costos de IA' y 'Ver parte diario'", async () => {
    stubApi();
    rendered = await montar();
    const conocidas = new Set([...TODAS_LAS_RUTAS.map((r) => r.to), ...PIE_SUPERADMIN.map((p) => p.to), ...RUTAS_SIN_MENU]);
    const hrefs = [...rendered.container.querySelectorAll("a")].map((a) => a.getAttribute("href")!.split("?")[0]!);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(conocidas.has(h), h).toBe(true);
    expect(texto()).not.toContain("Ver analítica");
    expect(hrefs).toContain("/superadmin/consumo-ia");
    expect(hrefs).toContain(PARTE_DIARIO);
  });

  it("rutaExiste solo acepta lo que esta en rutas.ts", () => {
    expect(rutaExiste("/superadmin/consumo-ia")).toBe(true);
    expect(rutaExiste(PARTE_DIARIO)).toBe(true);
    expect(rutaExiste("/superadmin/analitica")).toBe(false);
    expect(rutaExiste("/superadmin/copiloto")).toBe(true);
  });

  it("el filtro 7/30/todo recorta la serie a 7 dias o muestra los 14 que entrega el endpoint", () => {
    const serie = DIAS.map((dia) => ({ dia }));
    expect(ventanaSerie(serie, "7")).toHaveLength(7);
    expect(ventanaSerie(serie, "30")).toHaveLength(14);
    expect(ventanaSerie(serie, "todo")).toHaveLength(14);
  });
});

describe("Entrar (impersonacion con motivo)", () => {
  async function abrirEntrar(): Promise<void> {
    click(rendered!.container.querySelector('button[aria-label="Entrar a Hotel Casa Azul"]')!);
    await esperar();
  }

  it("abrir el dialogo NO llama al servidor; motivo corto deshabilita Entrar; Cancelar nunca ejecuta", async () => {
    const m = stubApi();
    rendered = await montar();
    await abrirEntrar();
    expect(dialogo()).not.toBeNull();
    expect(posts(m)).toHaveLength(0);
    expect(botonDialogo("Entrar").disabled).toBe(true);
    changeValue(dialogo()!.querySelector("textarea")!, "muy corto");
    expect(botonDialogo("Entrar").disabled).toBe(true);
    await act(async () => {
      click(botonDialogo("Cancelar"));
      await flushMicrotasks();
    });
    expect(posts(m)).toHaveLength(0);
    expect(dialogo()).toBeNull();
  });

  it("Escape cierra el dialogo y tampoco ejecuta", async () => {
    const m = stubApi();
    rendered = await montar();
    await abrirEntrar();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushMicrotasks();
    });
    expect(posts(m)).toHaveLength(0);
  });

  it("con motivo de 20+ caracteres manda UN POST con la organizacion y el motivo", async () => {
    const m = stubApi();
    rendered = await montar();
    await abrirEntrar();
    changeValue(dialogo()!.querySelector("textarea")!, "Ticket SOP-9001: revisar el checkout del cliente");
    await act(async () => {
      click(botonDialogo("Entrar"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(posts(m)).toHaveLength(1);
    const [url, init] = posts(m)[0]!;
    expect(String(url)).toBe("https://api.test/superadmin/impersonacion/sesiones");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ organizationId: "org-2", reason: "Ticket SOP-9001: revisar el checkout del cliente" });
  });

  it("si el servidor rechaza, el dialogo sigue abierto (no se da por hecho)", async () => {
    const m = stubApi({ post: () => json({ message: "Se requiere verificación MFA reciente." }, 403) });
    rendered = await montar();
    await abrirEntrar();
    changeValue(dialogo()!.querySelector("textarea")!, "Ticket SOP-9001: revisar el checkout del cliente");
    await act(async () => {
      click(botonDialogo("Entrar"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(posts(m)).toHaveLength(1);
    expect(dialogo()).not.toBeNull();
  });
});
