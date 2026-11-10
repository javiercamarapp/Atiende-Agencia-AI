// @vitest-environment jsdom
// Organizaciones / Clientes (SA-L-20): tabla con metricas, odometro, top por costo de IA, "Entrar" con motivo y la pestana Gestion.
// Cada afirmacion es un EFECTO observable (DOM y llamadas reales a fetch), con la API simulada por ruta.
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SuperAdminOrganizacionesPage } from "../src/superadmin/pages/Organizaciones.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { instalarLocalStorageEnMemoria, respuestaEntrar } from "./test-utils/token-soporte.ts";

beforeEach(() => {
  instalarLocalStorageEnMemoria();
});

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const campo = <T,>(valor: T) => ({ valor, razon: null });
const sinDato = (razon: string) => ({ valor: null, razon });

const FILAS = [
  {
    id: "o1", nombre: "Los Taquitos de PM", slug: "taquitos", vertical: "restaurantes", estado: "active", creadaEn: "2026-09-01T00:00:00.000Z", staff: 3,
    plan: campo({ id: "p1", nombre: "Restaurantes" }), operaciones30d: campo(120), costoIa30dUsd: campo(41.5), onboarding: campo({ hechos: 6, total: 6, noMedibles: 0 }),
  },
  {
    id: "o2", nombre: "Despacho Peña", slug: "despacho-pena", vertical: "despachos", estado: "trial", creadaEn: "2026-09-02T00:00:00.000Z", staff: 1,
    plan: sinDato("Sin plan asignado: no hay ingreso esperado contra el cual calcular el margen."), operaciones30d: sinDato("Sin fuente: despachos no guarda un registro de operaciones."),
    costoIa30dUsd: campo(0), onboarding: campo({ hechos: 1, total: 4, noMedibles: 1 }),
  },
  {
    id: "o3", nombre: "Hotel Mar", slug: "hotel-mar", vertical: "hoteles", estado: "suspended", creadaEn: "2026-09-03T00:00:00.000Z", staff: 2,
    plan: campo({ id: "p2", nombre: "Hoteles" }), operaciones30d: campo(0), costoIa30dUsd: campo(8), onboarding: campo({ hechos: 0, total: 6, noMedibles: 0 }),
  },
];

const RESUMEN = { disponible: true, mensaje: null, ventanaDias: 30, organizaciones: FILAS };
const MARGEN = { disponible: true, mes: "2026-09", mensaje: null, margenes: { o1: campo({ mxn: 1498, pct: 93.7, ingresoMxn: 1598 }), o2: sinDato("Sin plan asignado"), o3: sinDato("El plan no tiene precio configurado") } };

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

interface Opciones {
  resumen?: unknown;
  margen?: () => Response;
  post?: (url: string, body: unknown) => Response;
}
function stub(o: Opciones = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return (o.post ?? (() => json(respuestaEntrar({ slug: "taquitos", nombre: "Los Taquitos de PM", expMs: Date.now() + 3_600_000 }), true, 201)))(url, init.body ? JSON.parse(String(init.body)) : null);
    if (url.endsWith("/auth/me")) return json({ email: "javier@atiende.ai", fullName: "Javier", organizations: [{ id: "o1", slug: "taquitos", nombre: "Los Taquitos de PM", vertical: "restaurantes", rol: "owner" }] });
    if (url.endsWith("/superadmin/organizaciones/resumen")) return json(o.resumen ?? RESUMEN);
    if (url.endsWith("/superadmin/organizaciones/margen")) return (o.margen ?? (() => json(MARGEN)))();
    if (url.endsWith("/superadmin/organizations")) return json({ organizations: [] });
    if (url.endsWith("/superadmin/organizaciones/acciones")) return json({ disponible: true, acciones: [] });
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function Ubicacion() {
  const l = useLocation();
  return <p data-testid="ubicacion">{l.pathname}</p>;
}
const render = (ruta = "/superadmin/organizaciones") =>
  renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <Routes>
        <Route path="/superadmin/organizaciones" element={<SuperAdminOrganizacionesPage apiBaseUrl="https://api.test" token="tok" />} />
        <Route path="*" element={<Ubicacion />} />
      </Routes>
    </MemoryRouter>,
  );

const botones = () => [...(rendered?.container.querySelectorAll("button") ?? [])];
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (texto: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;
const filaDe = (id: string) => rendered!.container.querySelector(`tr[data-org-id="${id}"]`) as HTMLElement;
const posts = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST");

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("SuperAdminOrganizacionesPage", () => {
  it("pinta el odometro con el total, las columnas reales de cada organizacion y el top por costo de IA", async () => {
    stub();
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.container.querySelector('[data-testid="odometro"]')?.getAttribute("aria-label")).toContain("3");
    for (const col of ["Organización", "Vertical", "Estado", "Plan", "Operaciones 30 d", "Costo IA 30 d", "Margen", "Onboarding", "Acciones"]) expect(t).toContain(col);
    const taquitos = filaDe("o1").textContent ?? "";
    expect(taquitos).toContain("Los Taquitos de PM");
    expect(taquitos).toContain("Restaurantes");
    expect(taquitos).toContain("120");
    expect(taquitos).toContain("US$41.50");
    expect(taquitos).toContain("$1,498 · 94%");
    expect(taquitos).toContain("6/6");
    expect(filaDe("o3").textContent).toContain("Suspendida");
    // Top por costo de IA: ordenado de mayor a menor, y el de costo 0 no aparece.
    const barras = rendered.container.querySelector('[data-testid="hbars"]')?.textContent ?? "";
    expect(barras.indexOf("Los Taquitos de PM")).toBeGreaterThanOrEqual(0);
    expect(barras.indexOf("Los Taquitos de PM")).toBeLessThan(barras.indexOf("Hotel Mar"));
    expect(barras).not.toContain("Despacho Peña");
  });

  it("un dato no medible es '—' con su razon accesible, nunca 0 (despachos sin operaciones, plan y margen sin dato)", async () => {
    stub();
    rendered = render();
    await esperar();
    const fila = filaDe("o2");
    expect(fila.textContent).toContain("—");
    expect(fila.textContent).toContain("Sin fuente: despachos no guarda un registro de operaciones.");
    expect(fila.textContent).toContain("Sin plan asignado");
    expect(fila.textContent).toContain("1/4 (1 sin medir)");
    expect(fila.querySelector('[title="Sin fuente: despachos no guarda un registro de operaciones."]')).not.toBeNull();
    // La operacion de despachos no se pinta como "0".
    const celdas = [...fila.querySelectorAll("td")].map((c) => c.textContent?.trim());
    expect(celdas.some((c) => c?.startsWith("—") && c.includes("Sin fuente"))).toBe(true);
  });

  it("si el margen se rechaza (step-up) la tabla sigue completa y solo la columna Margen queda en blanco con su aviso", async () => {
    stub({ margen: () => json({ message: "Esta acción exige verificar tu código MFA (step-up)." }, false, 403) });
    rendered = render();
    await esperar();
    expect(filaDe("o1").textContent).toContain("Los Taquitos de PM");
    expect(filaDe("o1").textContent).toContain("120");
    expect(filaDe("o1").textContent).not.toContain("$1,498");
    expect(rendered.container.textContent).toContain("Margen no disponible");
  });

  it("base sin la 0052: aviso honesto, lista completa y columnas nuevas en '—' (nunca ceros)", async () => {
    const sin = (r: string) => sinDato(r);
    const resumen = {
      disponible: false, mensaje: "No disponible aún: falta aplicar la migración 0052_superadmin_organizaciones_ficha_onboarding en este despliegue.", ventanaDias: 30,
      organizaciones: FILAS.map((f) => ({ ...f, plan: sin("No disponible aún: 0052"), operaciones30d: sin("No disponible aún: 0052"), costoIa30dUsd: sin("No disponible aún: 0052"), onboarding: sin("No disponible aún: 0052") })),
    };
    stub({ resumen });
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("0052_superadmin_organizaciones_ficha_onboarding");
    expect(rendered.container.querySelectorAll("tr[data-org-id]")).toHaveLength(3);
    expect(filaDe("o1").textContent).not.toContain("120");
    expect(rendered.container.textContent).toContain("las métricas por organización no están disponibles aún");
  });

  it("error de carga: estado de error con reintento", async () => {
    fetchMock = vi.fn(async (url: string) => (url.endsWith("/margen") ? json(MARGEN) : json({ message: "boom" }, false, 500)));
    vi.stubGlobal("fetch", fetchMock);
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudieron cargar las organizaciones.");
    expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Reintentar"))).toBe(true);
  });

  it("'Ficha' enlaza a /superadmin/organizaciones/:id", async () => {
    stub();
    rendered = render();
    await esperar();
    const a = [...filaDe("o1").querySelectorAll("a")].find((x) => x.textContent?.includes("Ficha"));
    expect(a?.getAttribute("href")).toBe("/superadmin/organizaciones/o1");
  });
});

describe("Entrar (sesion de soporte en el panel del cliente)", () => {
  const entrar = (id: string) => click([...filaDe(id).querySelectorAll("button")].find((b) => b.textContent?.includes("Entrar"))!);

  it("sin motivo (o con menos de 10 caracteres) el boton queda bloqueado y NO abre la sesion: nada sale al servidor", async () => {
    stub();
    rendered = render();
    await esperar();
    entrar("o1");
    await esperar();
    expect(dialogo()?.textContent).toContain("Entrar a Los Taquitos de PM");
    expect(botonDialogo("Entrar al panel").disabled).toBe(true);
    click(botonDialogo("Entrar al panel"));
    await esperar();
    changeValue(dialogo()!.querySelector("textarea")!, "muy corto");
    expect(botonDialogo("Entrar al panel").disabled).toBe(true);
    click(botonDialogo("Entrar al panel"));
    await esperar();
    expect(posts()).toHaveLength(0);
    changeValue(dialogo()!.querySelector("textarea")!, "Revisar por que el cliente no recibe mensajes.");
    expect(botonDialogo("Entrar al panel").disabled).toBe(false);
    expect(posts()).toHaveLength(0);
  });

  it("Cancelar cierra el dialogo y NO ejecuta nada", async () => {
    stub();
    rendered = render();
    await esperar();
    entrar("o1");
    await esperar();
    changeValue(dialogo()!.querySelector("textarea")!, "Revisar por que el cliente no recibe mensajes.");
    click(botonDialogo("Cancelar"));
    await esperar();
    expect(dialogo()).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("con un motivo valido abre la sesion de soporte con la organizacion y el motivo, persiste la sesion del cliente y lleva a su panel", async () => {
    stub();
    rendered = render();
    await esperar();
    entrar("o1");
    await esperar();
    changeValue(dialogo()!.querySelector("textarea")!, "Revisar por que el cliente no recibe mensajes.");
    click(botonDialogo("Entrar al panel"));
    await esperar();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![0]).toBe("https://api.test/superadmin/soporte/entrar");
    expect(JSON.parse(String((posts()[0]![1] as RequestInit).body))).toEqual({ organizationId: "o1", reason: "Revisar por que el cliente no recibe mensajes." });
    expect(rendered.container.querySelector('[data-testid="ubicacion"]')?.textContent).toBe("/restaurantes/taquitos");
    expect(JSON.parse(window.localStorage.getItem("atiende.restaurantes.session")!).organizations[0].slug).toBe("taquitos");
  });

  it("si el servidor rechaza la sesion el dialogo queda abierto (no navega)", async () => {
    stub({ post: () => json({ message: "La organización está suspendida." }, false, 409) });
    rendered = render();
    await esperar();
    entrar("o3");
    await esperar();
    changeValue(dialogo()!.querySelector("textarea")!, "Revisar por que el cliente no recibe mensajes.");
    click(botonDialogo("Entrar al panel"));
    await esperar();
    expect(posts()).toHaveLength(1);
    expect(dialogo()).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="ubicacion"]')).toBeNull();
  });
});

describe("pestana Gestion", () => {
  it("?tab=gestion monta la gestion de organizaciones de siempre (alta, suspender, plan) sin un segundo h1", async () => {
    stub();
    rendered = render("/superadmin/organizaciones?tab=gestion");
    await esperar();
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/superadmin/organizaciones/acciones"))).toBe(true);
    expect(rendered.container.textContent).toContain("Alta de organización");
    expect(botones().map((b) => b.textContent?.trim())).toContain("Gestión");
  });
});
