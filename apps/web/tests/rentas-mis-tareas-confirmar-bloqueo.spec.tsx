// @vitest-environment jsdom
//
// Rn-05 -- el botón "Confirmar bloqueo de mantenimiento" de Mis tareas: solo roles de gestión,
// precarga el rango propuesto, avisa los conflictos con reservas y nunca aparece para `limpieza`.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MisTareasPage } from "../src/verticals/rentas/pages/MisTareas.tsx";
import { confirmarBloqueoIncidencia } from "../src/verticals/rentas/lib/limpieza-client.ts";
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
    for (let i = 0; i < 5; i++) await flushMicrotasks();
  });
}

const sesion = (rol: string): LoginSession => ({ token: "tok", refreshToken: "ref", email: "s@example.com", organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora", vertical: "rentas", rol }] });
const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const INCIDENCIA = { id: "inc-1", propertyId: "prop-1", unidadId: "u1", tareaOrigenId: null, severidad: "grave", titulo: "Fuga de agua", descripcion: null, estado: "bloqueo_propuesto", propuestaBloqueoRango: { inicio: "2027-05-10", fin: "2027-05-14" }, reportadoPor: null, creadoEn: "2026-10-01T10:00:00Z" };

function montar(rol: string): RenderedComponent {
  return renderComponent(<MisTareasPage apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" setPropertyId={() => {}} properties={[]} orgSlug="gestora-demo" session={sesion(rol)} />);
}

function red(extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const llamadas: { url: string; method: string }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, method: init?.method ?? "GET" });
    const custom = extra(url, init);
    if (custom) return custom;
    if (url.includes("/incidencias")) return json({ incidencias: [INCIDENCIA] });
    if (url.endsWith("/unidades")) return json({ unidades: [{ id: "u1", name: "Casa del mar", nombre: "Casa del mar" }] });
    if (url.includes("/tareas")) return json({ tareas: [] });
    throw new Error(`url inesperada: ${url}`);
  });
  return { fn, llamadas };
}

async function elegirUnidad(r: RenderedComponent): Promise<void> {
  const select = r.container.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    select.value = "u1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
  });
  await esperar();
}

describe("confirmarBloqueoIncidencia (cliente)", () => {
  it("hace POST a confirmar-bloqueo con el rango (o {} sin rango)", async () => {
    const cuerpos: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/p1/unidades/u1/incidencias/i1/confirmar-bloqueo");
      cuerpos.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ incidenciaId: "i1", bloqueoId: "b1", conflictosCapaCruzada: 0 }), { status: 201 });
    }) as unknown as typeof fetch;
    await confirmarBloqueoIncidencia(fetchImpl, "http://api.local", "tok", "p1", "u1", "i1", { inicio: "2027-05-10", fin: "2027-05-14" });
    await confirmarBloqueoIncidencia(fetchImpl, "http://api.local", "tok", "p1", "u1", "i1");
    expect(cuerpos).toEqual([{ rango: { inicio: "2027-05-10", fin: "2027-05-14" } }, {}]);
  });
});

describe("MisTareasPage -- confirmar bloqueo (Rn-05)", () => {
  it("el admin ve la incidencia grave con el rango propuesto y confirma: avisa el conflicto con reservas", async () => {
    const { fn, llamadas } = red((url, init) => (init?.method === "POST" && url.endsWith("/confirmar-bloqueo") ? json({ incidenciaId: "inc-1", bloqueoId: "b1", conflictosCapaCruzada: 2 }, 201) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    await elegirUnidad(rendered);
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Fuga de agua");
    const fechas = [...rendered.container.querySelectorAll('input[type="date"]')].map((i) => (i as HTMLInputElement).value);
    expect(fechas).toEqual(["2027-05-10", "2027-05-14"]);
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Confirmar bloqueo de mantenimiento"))!;
    await act(async () => {
      click(boton);
      await flushMicrotasks();
    });
    await esperar();
    const post = llamadas.find((l) => l.method === "POST" && l.url.endsWith("/confirmar-bloqueo"));
    expect(post?.url).toBe("http://api.local/rentas/prop-1/unidades/u1/incidencias/inc-1/confirmar-bloqueo");
    expect(rendered.container.textContent).toContain("se cruza con 2 reserva(s)");
    expect(rendered.container.textContent).toContain("ninguna reserva se canceló");
  });

  it("el rol limpieza reporta pero NO ve el botón ni pide las incidencias de la unidad", async () => {
    const { fn, llamadas } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar("limpieza");
    await esperar();
    await elegirUnidad(rendered);
    expect(rendered.container.textContent).not.toContain("Confirmar bloqueo de mantenimiento");
    expect(llamadas.some((l) => l.url.includes("/incidencias") && l.method === "GET")).toBe(false);
  });
});
