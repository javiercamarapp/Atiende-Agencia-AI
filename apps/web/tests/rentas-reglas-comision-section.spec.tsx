// @vitest-environment jsdom
//
// Rn-18 -- <ReglasComisionSection /> (dentro de Finanzas): canales sin regla, valores sugeridos, alta y edicion con su
// payload real, validacion local (porcentaje, fuente) y solo lectura para el contador.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReglasComisionSection } from "../src/verticals/rentas/components/ReglasComision.tsx";
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

const json = (body: unknown, ok = true, status = 200): Response => ({ ok, status, json: async () => body }) as unknown as Response;
const CANALES = [
  { codigo: "airbnb", nombre: "Airbnb" },
  { codigo: "booking", nombre: "Booking.com" },
  { codigo: "manual", nombre: "Reserva directa" },
  { codigo: "vrbo", nombre: "Vrbo" },
];
const REGLA = { id: "r1", alcance: "organizacion", propertyId: null, canalCodigo: "booking", canalNombre: "Booking.com", yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "default_sugerido_no_verificado: 15% estimada", vigenteDesde: "2026-10-01", sugerida: true };

function red(estado: { reglas: unknown[]; canalesSinRegla: string[] }, extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const llamadas: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const c = extra(url, init);
    if (c) return c;
    if (url.endsWith("/finanzas/reglas-comision") && (init?.method ?? "GET") === "GET") return json({ ...estado, canales: CANALES });
    throw new Error(`url inesperada: ${init?.method ?? "GET"} ${url}`);
  });
  return { fn, mutaciones: () => llamadas.filter((l) => l.method !== "GET") };
}

const montar = (puedeEscribir: boolean) => renderComponent(<ReglasComisionSection apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" puedeEscribir={puedeEscribir} />);
const dialogo = () => document.body.querySelector('[role="dialog"]');
const botonPagina = (r: RenderedComponent, texto: string) => [...r.container.querySelectorAll("button")].find((b) => b.textContent?.trim().includes(texto)) as HTMLButtonElement | undefined;
const campo = (etiqueta: string) => [...dialogo()!.querySelectorAll("label")].find((l) => l.textContent?.trim().startsWith(etiqueta))!.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
const guardar = () => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Guardar regla") as HTMLButtonElement;

describe("ReglasComisionSection", () => {
  it("un tenant sin reglas ve cuales canales faltan y la accion de cargar los valores sugeridos", async () => {
    vi.stubGlobal("fetch", red({ reglas: [], canalesSinRegla: ["airbnb", "booking", "vrbo"] }).fn);
    rendered = montar(true);
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Faltan comisiones por configurar");
    expect(texto).toContain("Airbnb, Booking.com, Vrbo");
    expect(botonPagina(rendered, "Cargar valores sugeridos")).toBeDefined();
  });

  it("Cargar valores sugeridos hace POST .../sugeridas y avisa cuantas creo", async () => {
    const { fn, mutaciones } = red({ reglas: [], canalesSinRegla: ["airbnb"] }, (url, init) => (init?.method === "POST" && url.endsWith("/sugeridas") ? json({ creadas: 4 }, true, 201) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar(true);
    await esperar();
    await act(async () => {
      click(botonPagina(rendered!, "Cargar valores sugeridos")!);
      await esperar();
    });
    expect(mutaciones()).toEqual([{ url: "http://api.local/rentas/prop-1/finanzas/reglas-comision/sugeridas", method: "POST", body: {} }]);
    expect(rendered.container.textContent).toContain("Se cargaron 4 comisión(es) sugerida(s)");
  });

  it("marca como 'Sugerida' lo no confirmado y muestra el porcentaje legible", async () => {
    vi.stubGlobal("fetch", red({ reglas: [REGLA], canalesSinRegla: [] }).fn);
    rendered = montar(true);
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("15.00 %");
    expect(texto).toContain("Sugerida");
    expect(texto).toContain("Hay comisiones sugeridas sin confirmar");
    expect(texto).not.toContain("Faltan comisiones");
  });

  it("editar manda PATCH con los puntos base calculados del porcentaje y la fuente", async () => {
    const { fn, mutaciones } = red({ reglas: [REGLA], canalesSinRegla: [] }, (url, init) => (init?.method === "PATCH" && url.endsWith("/reglas-comision/r1") ? json({ id: "r1" }) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar(true);
    await esperar();
    click(botonPagina(rendered, "Editar")!);
    await esperar();
    changeValue(campo("Comisión del canal") as HTMLInputElement, "17.5");
    changeValue(campo("Fuente") as HTMLInputElement, "Contrato firmado 2027");
    await act(async () => {
      click(guardar());
      await esperar();
    });
    expect(mutaciones()).toEqual([
      { url: "http://api.local/rentas/prop-1/finanzas/reglas-comision/r1", method: "PATCH", body: { yaNetoDeComision: false, comisionBasisPoints: 1750, fuente: "Contrato firmado 2027" } },
    ]);
  });

  it("agregar con porcentaje invalido o fuente corta se rechaza en el formulario SIN llamar al servidor", async () => {
    const { fn, mutaciones } = red({ reglas: [], canalesSinRegla: ["booking"] });
    vi.stubGlobal("fetch", fn);
    rendered = montar(true);
    await esperar();
    click(botonPagina(rendered, "Agregar regla")!);
    await esperar();
    changeValue(campo("Comisión del canal") as HTMLInputElement, "150");
    changeValue(campo("Fuente") as HTMLInputElement, "Contrato");
    await act(async () => {
      click(guardar());
      await esperar();
    });
    expect(dialogo()!.textContent).toContain("entre 0 y 100");
    changeValue(campo("Comisión del canal") as HTMLInputElement, "15");
    changeValue(campo("Fuente") as HTMLInputElement, "ab");
    await act(async () => {
      click(guardar());
      await esperar();
    });
    expect(dialogo()!.textContent).toContain("mínimo 3 caracteres");
    expect(mutaciones()).toHaveLength(0);
  });

  it("agregar una regla valida manda POST con canal, alcance y puntos base; un 409 deja el formulario abierto con su mensaje", async () => {
    const { fn, mutaciones } = red({ reglas: [], canalesSinRegla: ["booking"] }, (_url, init) => (init?.method === "POST" ? json({ message: "ya existe una regla para ese canal y alcance" }, false, 409) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar(true);
    await esperar();
    click(botonPagina(rendered, "Agregar regla")!);
    await esperar();
    changeValue(campo("Comisión del canal") as HTMLInputElement, "15");
    changeValue(campo("Fuente") as HTMLInputElement, "Contrato Booking 2027");
    await act(async () => {
      click(guardar());
      await esperar();
    });
    expect(mutaciones()).toEqual([{ url: "http://api.local/rentas/prop-1/finanzas/reglas-comision", method: "POST", body: { canalCodigo: "booking", alcance: "organizacion", yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "Contrato Booking 2027" } }]);
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("ya existe una regla para ese canal y alcance");
  });

  it("el contador (solo lectura) ve las reglas pero no puede agregar, editar ni cargar sugeridas", async () => {
    vi.stubGlobal("fetch", red({ reglas: [REGLA], canalesSinRegla: ["airbnb"] }).fn);
    rendered = montar(false);
    await esperar();
    expect(rendered.container.textContent).toContain("Booking.com");
    expect(botonPagina(rendered, "Agregar regla")).toBeUndefined();
    expect(botonPagina(rendered, "Editar")).toBeUndefined();
    expect(botonPagina(rendered, "Cargar valores sugeridos")).toBeUndefined();
    expect(rendered.container.textContent).toContain("Pídele a la administradora");
  });
});
