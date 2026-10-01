// @vitest-environment jsdom
//
// Rn-19 -- <CatalogoPage />: gate de rol, solo lectura para operador/contador, alta de unidad y de propietario con su
// payload real, validacion local de la estancia minima, y el mensaje real del servidor dentro del formulario abierto.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogoPage } from "../src/verticals/rentas/pages/Catalogo.tsx";
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

const CATALOGO = (puedeEditar: boolean) => ({
  propiedad: { propertyId: "prop-1", nombre: "Casa Playa", zonaHoraria: "America/Cancun", moneda: "MXN" },
  propiedades: [{ propertyId: "prop-1", nombre: "Casa Playa", zonaHoraria: "America/Cancun", moneda: "MXN" }],
  unidades: [{ id: "u1", propertyId: "prop-1", nombre: "Suite 1", duracionMinimaNoches: 2, propietarioId: "o1", propietarioNombre: "Ana Dueña" }],
  propietarios: [{ id: "o1", nombre: "Ana Dueña", email: "ana@example.com" }],
  monedas: ["MXN", "USD"],
  puedeEditar,
});

function red(puedeEditar: boolean, extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const llamadas: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const c = extra(url, init);
    if (c) return c;
    if (url.endsWith("/admin/catalogo") && (init?.method ?? "GET") === "GET") return json(CATALOGO(puedeEditar));
    throw new Error(`url inesperada: ${init?.method ?? "GET"} ${url}`);
  });
  return { fn, mutaciones: () => llamadas.filter((l) => l.method !== "GET") };
}

const dialogo = () => document.body.querySelector('[role="dialog"]');
const botonPagina = (r: RenderedComponent, texto: string) => [...r.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;
const campo = (etiqueta: string) => [...dialogo()!.querySelectorAll("label")].find((l) => l.textContent?.trim().startsWith(etiqueta))!.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
const guardar = () => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Guardar") as HTMLButtonElement;

describe("CatalogoPage", () => {
  it("un rol sin acceso (limpieza, operador de calendario) no pide nada y lo explica", async () => {
    const { fn } = red(false);
    vi.stubGlobal("fetch", fn);
    for (const rol of ["limpieza", "operador:solo_calendario", "operador:calendario_mensajeria"]) {
      rendered = montar(rol);
      await esperar();
      expect(rendered.container.textContent).toContain("no tiene acceso al catálogo");
      rendered.unmount();
      rendered = undefined;
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("el contador ve el catalogo en solo lectura: sin botones de crear ni editar", async () => {
    vi.stubGlobal("fetch", red(false).fn);
    rendered = montar("contador");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Casa Playa");
    expect(texto).toContain("America/Cancun");
    expect(texto).toContain("Ana Dueña");
    expect(texto).toContain("solo lectura");
    expect(botonPagina(rendered, "Nueva unidad")).toBeUndefined();
    expect(botonPagina(rendered, "Nuevo propietario")).toBeUndefined();
    expect(rendered.container.textContent).not.toContain("Editar");
  });

  it("la administradora crea una unidad: POST con nombre, propietario y estancia minima", async () => {
    const { fn, mutaciones } = red(true, (url, init) => (init?.method === "POST" && url.endsWith("/unidades") ? json({ id: "u2" }, true, 201) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(botonPagina(rendered, "Nueva unidad")!);
    await esperar();
    changeValue(campo("Nombre de la unidad") as HTMLInputElement, "  Suite 2 ");
    changeValue(campo("Propietario") as HTMLSelectElement, "o1");
    changeValue(campo("Estancia mínima") as HTMLInputElement, "3");
    await act(async () => {
      click(guardar());
      await esperar();
    });
    expect(mutaciones()).toEqual([{ url: "http://api.local/v1/rentas/prop-1/admin/catalogo/unidades", method: "POST", body: { nombre: "Suite 2", propietarioId: "o1", duracionMinimaNoches: 3 } }]);
    expect(rendered.container.textContent).toContain("Cambios guardados");
  });

  it("estancia minima fuera de 1..365 se rechaza en el formulario SIN llamar al servidor", async () => {
    const { fn, mutaciones } = red(true);
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(botonPagina(rendered, "Nueva unidad")!);
    await esperar();
    changeValue(campo("Nombre de la unidad") as HTMLInputElement, "Suite 2");
    changeValue(campo("Estancia mínima") as HTMLInputElement, "0");
    await act(async () => {
      click(guardar());
      await esperar();
    });
    expect(mutaciones()).toHaveLength(0);
    expect(dialogo()!.textContent).toContain("entre 1 y 365");
  });

  it("editar la propiedad manda PATCH con zona y moneda; si el servidor rechaza, el formulario sigue abierto con su mensaje", async () => {
    const { fn, mutaciones } = red(true, (url, init) => (init?.method === "PATCH" && url.endsWith("/propiedad") ? json({ message: "la propiedad ya tiene movimientos financieros; no se puede cambiar su moneda." }, false, 409) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(botonPagina(rendered, "Editar")!);
    await esperar();
    changeValue(campo("Moneda") as HTMLSelectElement, "USD");
    await act(async () => {
      click(guardar());
      await esperar();
    });
    expect(mutaciones()).toEqual([{ url: "http://api.local/v1/rentas/prop-1/admin/catalogo/propiedad", method: "PATCH", body: { nombre: "Casa Playa", zonaHoraria: "America/Cancun", moneda: "USD" } }]);
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("no se puede cambiar su moneda");
  });

  it("nuevo propietario sin correo manda email null", async () => {
    const { fn, mutaciones } = red(true, (url, init) => (init?.method === "POST" && url.endsWith("/propietarios") ? json({ id: "o2" }, true, 201) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(botonPagina(rendered, "Nuevo propietario")!);
    await esperar();
    changeValue(campo("Nombre") as HTMLInputElement, "Luis Pérez");
    await act(async () => {
      click(guardar());
      await esperar();
    });
    expect(mutaciones()).toEqual([{ url: "http://api.local/v1/rentas/prop-1/admin/catalogo/propietarios", method: "POST", body: { nombre: "Luis Pérez", email: null } }]);
  });

  it("cerrar el formulario sin guardar no llama al servidor", async () => {
    const { fn, mutaciones } = red(true);
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(botonPagina(rendered, "Nueva propiedad")!);
    await esperar();
    expect(dialogo()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await esperar();
    expect(mutaciones()).toHaveLength(0);
  });
});
