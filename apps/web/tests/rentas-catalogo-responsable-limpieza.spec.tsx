// @vitest-environment jsdom
//
// paridad3 rentas -- Catálogo: "Responsable de limpieza por omisión" por unidad. Solo se ofrece si hay lista del equipo (migración 033);
// guardar manda PUT .../responsable-limpieza solo cuando cambió; null lo quita; el mensaje real del servidor queda dentro del formulario.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogoPage } from "../src/verticals/rentas/pages/Catalogo.tsx";
import { fijarResponsableLimpieza } from "../src/verticals/rentas/lib/catalogo-client.ts";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

const sesion = (rol: string): LoginSession => ({ token: "tok", refreshToken: "ref", email: "yo@gestora.mx", organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora", vertical: "rentas", rol }] });
const montar = (rol: string) => renderComponent(<CatalogoPage apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" setPropertyId={() => {}} properties={[]} orgSlug="gestora-demo" session={sesion(rol)} />);
const json = (body: unknown, ok = true, status = 200): Response => ({ ok, status, json: async () => body }) as unknown as Response;

const CATALOGO = (responsableLimpiezaId: string | null) => ({
  propiedad: { propertyId: "prop-1", nombre: "Casa Playa", zonaHoraria: "America/Cancun", moneda: "MXN" },
  propiedades: [{ propertyId: "prop-1", nombre: "Casa Playa", zonaHoraria: "America/Cancun", moneda: "MXN" }],
  unidades: [{ id: "u1", propertyId: "prop-1", nombre: "Suite 1", duracionMinimaNoches: 2, propietarioId: null, propietarioNombre: null, responsableLimpiezaId }],
  propietarios: [],
  monedas: ["MXN", "USD"],
  puedeEditar: true,
});

function red(opciones: { responsable?: string | null; asignables?: unknown; put?: () => Response } = {}) {
  const llamadas: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    llamadas.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET" && url.endsWith("/admin/catalogo")) return json(CATALOGO(opciones.responsable ?? null));
    if (method === "GET" && url.endsWith("/tareas/asignables")) return json(opciones.asignables ?? { asignables: [{ id: "ana", nombre: "Ana Limpieza", rol: "limpieza" }, { id: "beto", nombre: "Beto Operador", rol: "operador:acceso_total" }], disponible: true });
    if (method === "PUT" && url.endsWith("/unidades/u1/responsable-limpieza")) return opciones.put ? opciones.put() : json({ id: "u1", responsableLimpiezaId: "ana" });
    if (method === "PATCH" && url.endsWith("/unidades/u1")) return json({ id: "u1" });
    throw new Error(`url inesperada: ${method} ${url}`);
  });
  return { fn, mutaciones: () => llamadas.filter((l) => l.method !== "GET") };
}

const dialogo = () => document.body.querySelector('[role="dialog"]');
const campo = (etiqueta: string) => [...dialogo()!.querySelectorAll("label")].find((l) => l.textContent?.trim().startsWith(etiqueta))?.querySelector("input, select") as HTMLInputElement | HTMLSelectElement | undefined;
const guardar = () => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Guardar") as HTMLButtonElement;

describe("Catálogo -- responsable de limpieza por omisión", () => {
  it("la tabla muestra el responsable (o «Sin asignar») y el formulario lo ofrece con el equipo de la propiedad", async () => {
    vi.stubGlobal("fetch", red({ responsable: "ana" }).fn);
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("Responsable de limpieza");
    expect(rendered.container.textContent).toContain("Ana Limpieza");
    click(rendered.container.querySelector('[aria-label="Editar la unidad Suite 1"]')!);
    await esperar();
    const select = campo("Responsable de limpieza por omisión") as HTMLSelectElement;
    expect(select.value).toBe("ana");
    expect([...select.options].map((o) => o.textContent)).toEqual(["Sin responsable (cola «Sin asignar»)", "Ana Limpieza", "Beto Operador"]);
  });

  it("elegir a otra persona y guardar manda PATCH de la unidad y PUT del responsable", async () => {
    const { fn, mutaciones } = red({ responsable: null });
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(rendered.container.querySelector('[aria-label="Editar la unidad Suite 1"]')!);
    await esperar();
    changeValue(campo("Responsable de limpieza por omisión")!, "beto");
    await act(async () => {
      click(guardar());
      await esperar();
    });
    expect(mutaciones().map((m) => `${m.method} ${m.url.replace("http://api.local/v1/rentas/prop-1/admin/catalogo", "")}`)).toEqual(["PATCH /unidades/u1", "PUT /unidades/u1/responsable-limpieza"]);
    expect(mutaciones()[1]!.body).toEqual({ responsableId: "beto" });
    expect(rendered.container.textContent).toContain("Cambios guardados");
  });

  it("dejarlo en «Sin responsable» manda null; si no cambió, NO llama al PUT", async () => {
    const quitar = red({ responsable: "ana" });
    vi.stubGlobal("fetch", quitar.fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(rendered.container.querySelector('[aria-label="Editar la unidad Suite 1"]')!);
    await esperar();
    changeValue(campo("Responsable de limpieza por omisión")!, "");
    await act(async () => {
      click(guardar());
      await esperar();
    });
    expect(quitar.mutaciones().at(-1)!.body).toEqual({ responsableId: null });
    rendered.unmount();

    const sinCambio = red({ responsable: "ana" });
    vi.stubGlobal("fetch", sinCambio.fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(rendered.container.querySelector('[aria-label="Editar la unidad Suite 1"]')!);
    await esperar();
    await act(async () => {
      click(guardar());
      await esperar();
    });
    expect(sinCambio.mutaciones().map((m) => m.method)).toEqual(["PATCH"]);
  });

  it("si el servidor rechaza al responsable (422), el formulario sigue abierto con el mensaje real", async () => {
    const { fn } = red({ responsable: null, put: () => json({ code: "asignado_no_valido", message: "La persona elegida no es miembro con acceso a esta propiedad, o su rol no opera limpieza." }, false, 422) });
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(rendered.container.querySelector('[aria-label="Editar la unidad Suite 1"]')!);
    await esperar();
    changeValue(campo("Responsable de limpieza por omisión")!, "ana");
    await act(async () => {
      click(guardar());
      await esperar();
    });
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("no es miembro con acceso");
  });

  it("base sin la migración 033 (sin lista del equipo): el campo y la columna no se muestran (nada que parezca funcional sin serlo)", async () => {
    vi.stubGlobal("fetch", red({ asignables: { asignables: [], disponible: false } }).fn);
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).not.toContain("Responsable de limpieza");
    click(rendered.container.querySelector('[aria-label="Editar la unidad Suite 1"]')!);
    await esperar();
    expect(campo("Responsable de limpieza por omisión")).toBeUndefined();
  });

  it("el contador (solo lectura) no pide la lista del equipo ni ve el campo", async () => {
    const { fn } = red();
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/admin/catalogo")) return json({ ...CATALOGO("ana"), puedeEditar: false });
      return fn(url, init);
    });
    rendered = montar("contador");
    await esperar();
    expect(rendered.container.textContent).not.toContain("Responsable de limpieza");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("fijarResponsableLimpieza (cliente)", () => {
  it("hace PUT con { responsableId } (o null)", async () => {
    const cuerpos: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/rentas/p1/admin/catalogo/unidades/u1/responsable-limpieza");
      expect(init?.method).toBe("PUT");
      cuerpos.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "u1", responsableLimpiezaId: null }), { status: 200 });
    }) as unknown as typeof fetch;
    await fijarResponsableLimpieza(fetchImpl, "http://api.local", "tok", "p1", "u1", "ana");
    await fijarResponsableLimpieza(fetchImpl, "http://api.local", "tok", "p1", "u1", null);
    expect(cuerpos).toEqual([{ responsableId: "ana" }, { responsableId: null }]);
  });
});
