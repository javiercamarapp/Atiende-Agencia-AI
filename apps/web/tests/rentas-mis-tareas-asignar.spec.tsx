// @vitest-environment jsdom
//
// paridad3 rentas -- reparto del trabajo en Mis tareas y tablero de turnos "Próximos 7 días":
//   * selector "Asignar a…" con el equipo de la propiedad (solo gestión; el rol `limpieza` no lo ve);
//   * reasignar una tarea que YA tiene responsable pide confirmación: Cancelar y Escape NUNCA llaman al servidor;
//   * el 403/422 del servidor se muestra tal cual;
//   * tablero de 7 días agrupado por día y por persona, con "Proveedor externo" y "SLA vencido", navegación entre semanas y
//     los estados cargando / vacío / error.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MisTareasPage } from "../src/verticals/rentas/pages/MisTareas.tsx";
import { TareasSemana } from "../src/verticals/rentas/components/TareasSemana.tsx";
import { fetchAsignables } from "../src/verticals/rentas/lib/limpieza-client.ts";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

beforeEach(() => {
  // "Hoy" fijo: 2026-10-05 12:00 en CDMX (el tablero arranca en el día de negocio de hoy).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T18:00:00.000Z"));
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

const sesion = (rol: string): LoginSession => ({ token: "tok", refreshToken: "ref", email: "s@example.com", organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora", vertical: "rentas", rol }] });
const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const ANA = { id: "ana", nombre: "Ana Limpieza", rol: "limpieza" };
const BETO = { id: "beto", nombre: "Beto Operador", rol: "operador:acceso_total" };

function tarea(extra: Record<string, unknown>) {
  return { id: "t1", propertyId: "prop-1", unidadId: "u1", unidadNombre: "Casa del mar", tipo: "limpieza", estado: "pendiente", prioridad: "media", asignadoA: null, esProveedorExterno: false, programadaPara: "2026-10-06", slaVenceEn: null, completadaEn: null, creadoEn: "2026-10-01T10:00:00Z", ...extra };
}
const detalle = (extra: Record<string, unknown>) => ({ ...tarea(extra), checklist: [] });

interface Llamada {
  url: string;
  method: string;
  body: unknown;
}

function red(opciones: { tareas?: unknown[]; mias?: unknown[]; libres?: unknown[]; detalle?: Record<string, unknown>; asignar?: () => Response; asignables?: unknown; tareasError?: boolean } = {}) {
  const llamadas: Llamada[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    llamadas.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST" && url.endsWith("/asignar")) return opciones.asignar ? opciones.asignar() : json({ tarea: detalle({ ...opciones.detalle, asignadoA: "ana", estado: "asignada" }) });
    if (url.endsWith("/tareas/asignables")) return json(opciones.asignables ?? { asignables: [ANA, BETO], disponible: true });
    if (url.includes("/tareas/t1/") || url.endsWith("/tareas/t1")) return json({ tarea: detalle(opciones.detalle ?? {}) });
    if (url.includes("/inventario")) return json({ items: [] });
    if (url.includes("/incidencias")) return json({ incidencias: [] });
    if (url.endsWith("/unidades")) return json({ unidades: [{ id: "u1", name: "Casa del mar", nombre: "Casa del mar" }] });
    if (url.includes("/tareas?")) {
      if (opciones.tareasError && url.includes("desde=")) return json({ message: "boom" }, 500);
      if (url.includes("asignadoA=me")) return json({ tareas: opciones.mias ?? [] });
      if (url.includes("asignadoA=sin_asignar")) return json({ tareas: opciones.libres ?? [] });
      return json({ tareas: opciones.tareas ?? [] });
    }
    throw new Error(`url inesperada: ${method} ${url}`);
  });
  return { fn, llamadas, mutaciones: () => llamadas.filter((l) => l.method === "POST") };
}

const montar = (rol: string) => renderComponent(<MisTareasPage apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" setPropertyId={() => {}} properties={[]} orgSlug="gestora-demo" session={sesion(rol)} />);
const botonPagina = (r: RenderedComponent, texto: string) => [...r.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (texto: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;
const selectAsignar = (r: RenderedComponent) => [...r.container.querySelectorAll("label")].find((l) => l.textContent?.trim().startsWith("Persona"))!.querySelector("select") as HTMLSelectElement;

async function abrirTarea(r: RenderedComponent): Promise<void> {
  const tarjeta = [...r.container.querySelectorAll('[role="button"]')].find((e) => (e.getAttribute("aria-label") ?? "").includes("Casa del mar")) as HTMLElement;
  await act(async () => {
    click(tarjeta);
    await esperar();
  });
}

describe("MisTareasPage -- Asignar a… (gestión)", () => {
  it("el admin elige a una persona y manda POST .../asignar con asignadoA y proveedor externo; la tarea sin responsable no pide confirmación", async () => {
    const { fn, mutaciones } = red({ libres: [tarea({})], detalle: {} });
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    await abrirTarea(rendered);

    expect(rendered.container.textContent).toContain("Asignar a…");
    await act(async () => {
      changeValue(selectAsignar(rendered!), "ana");
      await flushMicrotasks();
    });
    await act(async () => {
      click(botonPagina(rendered!, "Asignar")!);
      await esperar();
    });

    expect(dialogo()).toBeNull();
    expect(mutaciones()).toHaveLength(1);
    expect(mutaciones()[0]!.url).toBe("http://api.local/rentas/prop-1/tareas/t1/asignar");
    expect(mutaciones()[0]!.body).toEqual({ asignadoA: "ana", esProveedorExterno: false });
    expect(rendered.container.textContent).toContain("Tarea asignada a Ana Limpieza.");
  });

  it("el botón Asignar queda deshabilitado mientras no se elija a nadie", async () => {
    vi.stubGlobal("fetch", red({ libres: [tarea({})] }).fn);
    rendered = montar("operador:acceso_total");
    await esperar();
    await abrirTarea(rendered);
    expect(botonPagina(rendered, "Asignar")!.disabled).toBe(true);
  });

  describe("reasignar una tarea que ya tiene responsable", () => {
    async function abrirReasignacion(): Promise<ReturnType<typeof red>> {
      const r = red({ mias: [tarea({ asignadoA: "beto", estado: "asignada" })], detalle: { asignadoA: "beto", estado: "asignada" } });
      vi.stubGlobal("fetch", r.fn);
      rendered = montar("admin_gestora");
      await esperar();
      await abrirTarea(rendered);
      await act(async () => {
        changeValue(selectAsignar(rendered!), "ana");
        await flushMicrotasks();
      });
      await act(async () => {
        click(botonPagina(rendered!, "Asignar")!);
        await esperar();
      });
      return r;
    }

    it("pide confirmación con el responsable actual y el nuevo, y el primer clic NO llama al servidor", async () => {
      const r = await abrirReasignacion();
      expect(dialogo()).not.toBeNull();
      expect(dialogo()!.textContent).toContain("Beto Operador");
      expect(dialogo()!.textContent).toContain("Ana Limpieza");
      expect(r.mutaciones()).toHaveLength(0);
    });

    it("Cancelar no reasigna", async () => {
      const r = await abrirReasignacion();
      await act(async () => {
        click(botonDialogo("Cancelar"));
        await esperar();
      });
      expect(r.mutaciones()).toHaveLength(0);
      expect(dialogo()).toBeNull();
    });

    it("Escape no reasigna", async () => {
      const r = await abrirReasignacion();
      await act(async () => {
        dialogo()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await esperar();
      });
      expect(r.mutaciones()).toHaveLength(0);
      expect(dialogo()).toBeNull();
    });

    it("Reasignar confirma y manda el POST", async () => {
      const r = await abrirReasignacion();
      await act(async () => {
        click(botonDialogo("Reasignar"));
        await esperar();
      });
      expect(r.mutaciones()).toHaveLength(1);
      expect(r.mutaciones()[0]!.body).toEqual({ asignadoA: "ana", esProveedorExterno: false });
    });
  });

  it("si el servidor rechaza (422: la persona no es miembro) muestra su mensaje y no finge éxito", async () => {
    const { fn } = red({ libres: [tarea({})], asignar: () => json({ code: "asignado_no_valido", message: "La persona elegida no es miembro con acceso a esta propiedad, o su rol no opera limpieza." }, 422) });
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    await abrirTarea(rendered);
    await act(async () => {
      changeValue(selectAsignar(rendered!), "ana");
      await flushMicrotasks();
    });
    await act(async () => {
      click(botonPagina(rendered!, "Asignar")!);
      await esperar();
    });
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("no es miembro con acceso");
    expect(rendered.container.textContent).not.toContain("Tarea asignada a");
  });

  it("el rol limpieza NO ve el selector ni el tablero ni pide la lista del equipo; solo conserva Asignarme", async () => {
    const { fn, llamadas } = red({ libres: [tarea({})] });
    vi.stubGlobal("fetch", fn);
    rendered = montar("limpieza");
    await esperar();
    await abrirTarea(rendered);
    expect(rendered.container.textContent).not.toContain("Asignar a…");
    expect(rendered.container.textContent).not.toContain("Próximos 7 días");
    expect(llamadas.some((l) => l.url.endsWith("/tareas/asignables"))).toBe(false);
    expect(botonPagina(rendered, "Asignarme")).toBeDefined();
  });

  it("base sin la migración 033 (disponible: false): el selector se reemplaza por un estado honesto, no por un control que no funciona", async () => {
    vi.stubGlobal("fetch", red({ libres: [tarea({})], asignables: { asignables: [], disponible: false } }).fn);
    rendered = montar("admin_gestora");
    await esperar();
    await abrirTarea(rendered);
    expect(rendered.container.textContent).toContain("No disponible aún");
    expect(botonPagina(rendered, "Asignar")).toBeUndefined();
  });

  it("muestra «Proveedor externo» en la tarjeta cuando la tarea es de un proveedor", async () => {
    vi.stubGlobal("fetch", red({ mias: [tarea({ esProveedorExterno: true, asignadoA: "ana", estado: "asignada" })] }).fn);
    rendered = montar("limpieza");
    await esperar();
    expect(rendered.container.textContent).toContain("Proveedor externo");
  });
});

describe("MisTareasPage -- completar la tarea", () => {
  it("tras completar, la confirmacion «Tarea completada.» SE QUEDA visible (antes la recarga del detalle la borraba al instante)", async () => {
    let completada = false;
    const base = red({ mias: [tarea({ asignadoA: "ana", estado: "asignada" })], detalle: { asignadoA: "ana", estado: "asignada" } });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/tareas/t1/completar")) {
        completada = true;
        return json({ id: "t1", estado: "completada", alertasStockBajo: [] });
      }
      if (completada && url.endsWith("/tareas/t1")) return json({ tarea: { ...detalle({ asignadoA: "ana" }), estado: "completada" } });
      return base.fn(url, init);
    });
    rendered = montar("limpieza");
    await esperar();
    await abrirTarea(rendered);
    await act(async () => {
      click(botonPagina(rendered!, "Completar tarea")!);
      await esperar();
    });
    expect(rendered.container.textContent).toContain("Tarea completada.");
    expect(rendered.container.textContent).toContain("Estado: Completada");
  });
});

describe("TareasSemana -- tablero «Próximos 7 días»", () => {
  const montarSemana = () => renderComponent(<TareasSemana apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" />);

  it("agrupa por día y por persona, con la cola «Sin asignar» primero, «Proveedor externo» y «SLA vencido»", async () => {
    const { fn, llamadas } = red({
      tareas: [
        tarea({ id: "a", programadaPara: "2026-10-06", asignadoA: "ana", estado: "asignada", unidadNombre: "Casa del mar" }),
        tarea({ id: "b", programadaPara: "2026-10-06", asignadoA: null, unidadNombre: "Loft centro" }),
        tarea({ id: "c", programadaPara: "2026-10-06", asignadoA: "beto", estado: "asignada", esProveedorExterno: true, unidadNombre: "Suite 2" }),
        tarea({ id: "d", programadaPara: "2026-10-08", asignadoA: "ana", estado: "asignada", unidadNombre: "Depa 5", slaVenceEn: "2026-10-05T10:00:00.000Z" }),
      ],
    });
    vi.stubGlobal("fetch", fn);
    rendered = montarSemana();
    await esperar();

    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("4 tareas · 1 sin responsable");
    expect(texto).toContain("Ana Limpieza");
    expect(texto).toContain("Beto Operador");
    expect(texto).toContain("Proveedor externo");
    expect(texto).toContain("SLA vencido");
    // El día 06 muestra "Sin asignar" antes que las personas.
    const dia06 = [...rendered.container.querySelectorAll("section")].find((s) => (s.getAttribute("aria-label") ?? "").includes("6"))!;
    const nombres = [...dia06.querySelectorAll("p")].map((p) => p.textContent);
    expect(nombres[0]).toBe("Sin asignar");
    // Pide la ventana de 7 días desde hoy SIN filtro de asignación (todo el equipo).
    const pedido = llamadas.find((l) => l.url.includes("/tareas?") && l.url.includes("desde="))!.url;
    expect(pedido).toContain("desde=2026-10-05");
    expect(pedido).toContain("hasta=2026-10-11");
    expect(pedido).not.toContain("asignadoA");
  });

  it("navega entre semanas: siguiente y anterior piden la ventana de 7 días correspondiente; «Hoy» regresa", async () => {
    const { fn, llamadas } = red({ tareas: [tarea({ programadaPara: "2026-10-06" })] });
    vi.stubGlobal("fetch", fn);
    rendered = montarSemana();
    await esperar();
    const desde = () => llamadas.filter((l) => l.url.includes("desde=")).map((l) => /desde=([\d-]+)&hasta=([\d-]+)/.exec(l.url)!.slice(1, 3).join("..")).at(-1);
    expect(desde()).toBe("2026-10-05..2026-10-11");

    await act(async () => {
      click(rendered!.container.querySelector('[aria-label="Semana siguiente"]')!);
      await esperar();
    });
    expect(desde()).toBe("2026-10-12..2026-10-18");

    await act(async () => {
      click(rendered!.container.querySelector('[aria-label="Semana anterior"]')!);
      click(rendered!.container.querySelector('[aria-label="Semana anterior"]')!);
      await esperar();
    });
    expect(desde()).toBe("2026-09-28..2026-10-04");

    await act(async () => {
      click(botonPagina(rendered!, "Hoy")!);
      await esperar();
    });
    expect(desde()).toBe("2026-10-05..2026-10-11");
  });

  it("estado vacío: sin tareas en los 7 días", async () => {
    vi.stubGlobal("fetch", red({ tareas: [] }).fn);
    rendered = montarSemana();
    await esperar();
    expect(rendered.container.textContent).toContain("Sin turnos en estos 7 días.");
    expect(rendered.container.textContent).toContain("Semana libre");
  });

  it("estado cargando: mientras la petición sigue en vuelo muestra el cargando y ninguna tarea", async () => {
    let liberar: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/tareas/asignables")) return json({ asignables: [], disponible: true });
        return new Promise<Response>((resolver) => {
          liberar = resolver;
        });
      }),
    );
    rendered = montarSemana();
    await esperar();
    expect(rendered.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(rendered.container.textContent).not.toContain("Semana libre");
    await act(async () => {
      liberar(json({ tareas: [] }));
      await esperar();
    });
    expect(rendered.container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("estado de error: muestra el mensaje real y Reintentar vuelve a pedir", async () => {
    let falla = true;
    const llamadas: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        llamadas.push(url);
        if (url.endsWith("/tareas/asignables")) return json({ asignables: [ANA], disponible: true });
        return falla ? json({ message: "Sin conexión con el servidor" }, 500) : json({ tareas: [tarea({ programadaPara: "2026-10-06" })] });
      }),
    );
    rendered = montarSemana();
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo cargar la información");
    falla = false;
    await act(async () => {
      click(botonPagina(rendered!, "Reintentar")!);
      await esperar();
    });
    expect(rendered.container.textContent).toContain("1 tarea");
    expect(rendered.container.textContent).not.toContain("No se pudo cargar la información");
  });

  it("sin la lista de personas (migración 033 pendiente) las tareas siguen visibles, sin nombres, con un aviso honesto", async () => {
    vi.stubGlobal("fetch", red({ tareas: [tarea({ asignadoA: "ana", estado: "asignada", programadaPara: "2026-10-06" })], asignables: { asignables: [], disponible: false } }).fn);
    rendered = montarSemana();
    await esperar();
    expect(rendered.container.textContent).toContain("No disponible aún");
    expect(rendered.container.textContent).toContain("Persona asignada");
  });
});

describe("fetchAsignables (cliente)", () => {
  it("pide GET .../tareas/asignables y tolera una respuesta sin lista", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchAsignables(fetchImpl, "http://api.local", "tok", "p1")).toEqual({ asignables: [], disponible: true });
    expect(urls).toEqual(["http://api.local/rentas/p1/tareas/asignables"]);
  });
});
