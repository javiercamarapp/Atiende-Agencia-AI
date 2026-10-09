// @vitest-environment jsdom
//
// R-12: pestana de callbacks con estado, SLA, asignacion y acciones. Base sin la migracion 033 (`gestionable: false`) se ve el
// listado de siempre, sin botones de estado.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { CallbacksPanel } from "../src/verticals/restaurantes/pages/CallbacksPanel.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, etiquetasDe, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const OWNER: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Jefa", staffEmail: "j@example.com" };
const STAFF: RestaurantesShellContext = { ...OWNER, role: "staff" };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const NUEVO = {
  id: "cb-1", sucursalId: "prop-1", nombre: "Marcela", telefono: "+5219990000001", motivo: "escalada:queja", mensaje: "Llego frio", origen: "voice", resuelto: false, creadoEn: "2026-10-01T12:00:00.000Z",
  estado: "nuevo", gestionable: true, asignadoA: null, asignadoNombre: null, asignadoEn: null, tomadoEn: null, resueltoEn: null, resueltoPor: null, notaResolucion: null,
  sla: { objetivoMin: 15, venceAt: "2026-10-01T12:15:00.000Z", estado: "vencido", minutosRestantes: -5 }, intentos: [],
};
const LEGACY = { ...NUEVO, id: "cb-2", nombre: "Pedro", motivo: null, sucursalId: null, gestionable: false, sla: { objetivoMin: 60, venceAt: "2026-10-01T13:00:00.000Z", estado: "en_plazo", minutosRestantes: 30 } };

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const botones = () => Array.from(rendered!.container.querySelectorAll("button"));
const boton = (texto: string) => botones().find((b) => b.textContent === texto);

function enrutar(items: unknown[], extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const r = extra(u, init);
    if (r) return r;
    if (u.includes("/staff/miembros")) return json({ miembros: [{ id: "u-2", email: "l@x.com", fullName: "Luis", verticalRole: "staff", propertyIds: null }, { id: "u-3", email: "r@x.com", fullName: "Reparto", verticalRole: "repartidor", propertyIds: null }] });
    return json({ disponible: true, items });
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("CallbacksPanel (restaurantes)", () => {
  it("muestra estado, SLA vencido, motivo legible, canal, sucursal y mensaje", async () => {
    enrutar([NUEVO]);
    rendered = renderComponent(<CallbacksPanel ctx={OWNER} />);
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Marcela");
    expect(t).toContain("Nuevo");
    expect(t).toContain("Vencido: hace 5 min (objetivo 15 min)");
    expect(t).toContain("Escalada: queja");
    expect(t).toContain("Llamada");
    expect(t).toContain("Esta sucursal");
    expect(t).toContain("Llego frio");
  });

  it("Tomar manda POST .../callbacks/:id/estado con la accion y recarga la lista", async () => {
    enrutar([NUEVO], (u, init) => (u.endsWith("/callbacks/cb-1/estado") ? (init?.method === "POST" ? json({ estado: "en_curso" }) : undefined) : undefined));
    rendered = renderComponent(<CallbacksPanel ctx={STAFF} />);
    await esperar();
    click(boton("Tomar")!);
    await esperar();
    const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/callbacks/cb-1/estado"));
    expect(post?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(post?.[1].body))).toEqual({ accion: "tomar" });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/callbacks?")).length).toBeGreaterThanOrEqual(2);
  });

  it("un 409 al tomar se muestra como aviso (otra persona ya lo tiene) y recarga", async () => {
    enrutar([NUEVO], (u) => (u.endsWith("/estado") ? json({ message: "Ya lo tiene otra persona." }, 409) : undefined));
    rendered = renderComponent(<CallbacksPanel ctx={STAFF} />);
    await esperar();
    click(boton("Tomar")!);
    await esperar();
    expect(rendered.container.textContent).toContain("Ya lo tiene otra persona.");
  });

  it("owner/admin ve 'Asignar a…' con las personas de la sucursal (sin repartidores); staff no", async () => {
    enrutar([{ ...NUEVO, estado: "en_curso", asignadoA: "u-2", asignadoNombre: "Luis" }]);
    rendered = renderComponent(<CallbacksPanel ctx={OWNER} />);
    await esperar();
    const select = rendered.container.querySelector("[role='combobox'][aria-label^='Asignar']") as HTMLElement;
    expect(select).not.toBeNull();
    expect(etiquetasDe(select)).toEqual(["Asignar a…", "Luis"]);
    expect(rendered.container.textContent).toContain("Asignado a Luis");
    expect(boton("Asignar")!.hasAttribute("disabled")).toBe(true);
    elegirValor(select, "u-2");
    await esperar();
    expect(boton("Asignar")!.hasAttribute("disabled")).toBe(false);
    click(boton("Asignar")!);
    await esperar();
    const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/estado"));
    expect(JSON.parse(String(post?.[1].body))).toEqual({ accion: "asignar", asignadoA: "u-2" });
    rendered.unmount();
    fetchMock.mockClear();
    enrutar([{ ...NUEVO, estado: "en_curso", asignadoNombre: "Luis" }]);
    rendered = renderComponent(<CallbacksPanel ctx={STAFF} />);
    await esperar();
    expect(rendered.container.querySelector("[role='combobox'][aria-label^='Asignar']")).toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/staff/miembros"))).toBe(false);
  });

  it("base sin la 033 (gestionable:false): el listado de siempre, sin Tomar/Asignar, con 'Pendiente' y 'Sin sucursal asignada'", async () => {
    enrutar([LEGACY]);
    rendered = renderComponent(<CallbacksPanel ctx={OWNER} />);
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Pendiente");
    expect(t).toContain("Sin sucursal asignada");
    expect(boton("Tomar")).toBeUndefined();
    expect(boton("Resolver")).toBeUndefined();
    expect(rendered.container.querySelector("[role='combobox'][aria-label^='Asignar']")).toBeNull();
    expect(boton("Contactado (resuelto)")).toBeDefined();
  });

  it("disponible:false sigue siendo un estado honesto, no una bandeja vacia", async () => {
    fetchMock.mockResolvedValue(json({ disponible: false, items: [] }));
    rendered = renderComponent(<CallbacksPanel ctx={STAFF} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Callbacks no disponibles aún");
    expect(rendered.container.textContent).not.toContain("Sin callbacks");
  });

  it("el filtro Resueltos pide ?estado=resuelto; Pendientes pide soloAbiertos", async () => {
    enrutar([]);
    rendered = renderComponent(<CallbacksPanel ctx={STAFF} />);
    await esperar();
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/callbacks?soloAbiertos=1");
    elegirValor(rendered.container.querySelector("#callbacks-filtro") as HTMLElement, "resuelto");
    await esperar();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/callbacks?estado=resuelto"))).toBe(true);
  });
});
