// @vitest-environment jsdom
//
// «Resumen general» de restaurantes: (1) la logica pura que arma comparativo, estado de los datos y «Requiere tu atencion» desde la vista
// `/admin/cfo/resumen`, con los datos SINTETICOS de la API simulada (7 sucursales de PM, Galerias incluida) y una variante con
// SoftRestaurant importado; (2) la pagina montada con `fetch` falso: cifras, 403 del CFO, base sin migrar, error con Reintentar y
// «Pregúntale a tus datos» que abre el Copiloto con la pregunta. Sin red ni reloj real.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ResumenVista } from "@atiende/domain-restaurantes/cfo";
import datos from "../e2e/mock-api/fixtures/restaurantes-cfo.datos.json";
import { armarAtencion, armarComparativo, armarEstadoDatos, sucursalLider, variacionDe } from "../src/verticals/restaurantes/lib/resumen-general.ts";
import { ResumenGeneralPage } from "../src/verticals/restaurantes/pages/ResumenGeneral.tsx";
import { changeValue, click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const RESUMEN = (datos as unknown as { resumen: Record<string, ResumenVista> }).resumen["todas|impacto"]!;
const GALERIAS = "00000000-0000-4000-8000-0000000000a4";

/** Variante con el reporte de SoftRestaurant importado: Galerias (solo venta local) vende en mostrador y el agente no le toma pedidos. */
function conSoftRestaurant(d: ResumenVista): ResumenVista {
  const sr = (valor: number) => ({ id: "ventas_negocio_sr", etiqueta: "Ventas del negocio (SoftRestaurant)", tipo: "centavos" as const, valor: { valor, confianza: "importado" as const, fuente: "sr" }, base: null, variacion: { tipo: "pct" as const, valor: null }, semaforo: "sin_dato" as const, mejorSi: "mayor" as const, baseVentas: "softrestaurant" as const });
  const porSucursal = d.kpis.porSucursal.map((s) => ({ ...s, kpis: [...s.kpis, sr(s.propertyId === GALERIAS ? 4_000_000 : 1_000_000)] }));
  return {
    ...d,
    titular: { etiqueta: "Ventas del negocio (SoftRestaurant)", origen: "softrestaurant", cifra: { valor: 10_000_000, confianza: "importado", fuente: "sr" } as ResumenVista["titular"]["cifra"] },
    kpis: { ...d.kpis, porSucursal, total: { ...d.kpis.total, kpis: [...d.kpis.total.kpis, sr(10_000_000)] } },
  };
}

describe("resumen general: logica pura", () => {
  it("el comparativo trae las 7 sucursales (Galerías incluida) y la participacion suma 100 %", () => {
    const c = armarComparativo(RESUMEN);
    expect(c.filas.map((f) => f.nombre)).toEqual(["Prolongación Montejo", "Francisco de Montejo", "Pensiones", "Victory Platz", "Altabrisa", "Galerías", "Chicxulub"]);
    expect(c.origen).toBe("agente");
    expect(c.conVentasNegocio).toBe(false);
    const suma = c.filas.reduce((s, f) => s + (f.participacion ?? 0), 0);
    expect(suma).toBeCloseTo(1, 6);
    expect(c.filas.find((f) => f.nombre === "Galerías")?.ventasAgente).toBe(959_440);
    expect(sucursalLider(c)?.nombre).toBe("Prolongación Montejo");
  });

  it("con SoftRestaurant la base es la venta del negocio: Galerías encabeza aunque el agente casi no le venda", () => {
    const c = armarComparativo(conSoftRestaurant(RESUMEN));
    expect(c.origen).toBe("softrestaurant");
    expect(c.conVentasNegocio).toBe(true);
    const galerias = c.filas.find((f) => f.nombre === "Galerías")!;
    expect(galerias.ventasNegocio).toBe(4_000_000);
    expect(galerias.participacion).toBeCloseTo(0.4, 6);
    expect(sucursalLider(c)?.nombre).toBe("Galerías");
  });

  it("una cifra sin dato queda null (nunca 0) y la variacion sin base es null", () => {
    const sinDato = { ...RESUMEN, kpis: { ...RESUMEN.kpis, total: { ...RESUMEN.kpis.total, kpis: RESUMEN.kpis.total.kpis.map((k) => (k.id === "ventas_netas" ? { ...k, valor: { ...k.valor, valor: null }, variacion: { tipo: "pct" as const, valor: null } } : k)) } } };
    const c = armarComparativo(sinDato);
    expect(c.total.ventasAgente).toBeNull();
    expect(c.filas.every((f) => f.participacion === null)).toBe(true);
    expect(c.total.variacion).toBeNull();
  });

  it("la variacion respeta la direccion buena de cada metrica (bajar la cancelacion es bueno)", () => {
    const k = RESUMEN.kpis.total.kpis.find((x) => x.id === "cancelacion_pct")!;
    expect(variacionDe({ ...k, mejorSi: "menor", variacion: { tipo: "pct", valor: -2.04 } })).toEqual({ pct: -2, bueno: true });
    expect(variacionDe({ ...k, mejorSi: "mayor", variacion: { tipo: "pct", valor: -2.04 } })).toEqual({ pct: -2, bueno: false });
    expect(variacionDe({ ...k, variacion: { tipo: "pp", valor: 1 } })).toBeUndefined();
  });

  it("estado de los datos: x de y fuentes con las que declara el CFO, cuales faltan y el ultimo dia con datos", () => {
    const e = armarEstadoDatos(RESUMEN);
    expect(e).toEqual({ conDatos: 3, total: 4, sinCargar: ["SoftRestaurant (reporte importado)"], hasta: "2026-09-27" });
    expect(armarEstadoDatos({ fuentes: [] })).toEqual({ conDatos: 0, total: 0, sinCargar: [], hasta: null });
  });

  it("requiere tu atencion: los 3 primeros hallazgos del servidor, con urgencia y el total", () => {
    const a = armarAtencion(RESUMEN.hallazgos);
    expect(a.total).toBe(RESUMEN.hallazgos.length);
    expect(a.avisos).toHaveLength(3);
    expect(a.avisos[0]).toMatchObject({ titulo: RESUMEN.hallazgos[0]!.titulo, cifra: RESUMEN.hallazgos[0]!.cifraTexto, urgente: RESUMEN.hallazgos[0]!.urgencia === "alta" });
  });
});

let r: RenderedComponent | null = null;
afterEach(() => {
  r?.unmount();
  r = null;
  vi.restoreAllMocks();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function Ubicacion() {
  const l = useLocation();
  return <p data-testid="ubicacion">{`${l.pathname}${l.search}`}</p>;
}

async function montar(fetchImpl: typeof fetch, role = "owner"): Promise<RenderedComponent> {
  const ctx = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "pm", role, staffFullName: "Dueña", staffEmail: "d@x.test", nombreSucursal: "Centro" };
  const rendered = renderComponent(
    <MemoryRouter initialEntries={["/restaurantes/pm/general?desde=2026-09-21&hasta=2026-09-27&comparar=periodo_anterior"]}>
      <Routes>
        <Route path="/restaurantes/pm/general" element={<ResumenGeneralPage {...ctx} fetchImpl={fetchImpl} hoy="2026-09-27" />} />
        <Route path="*" element={<Ubicacion />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
  return rendered;
}

describe("resumen general: pagina", () => {
  it("pinta frase, KPI, estado de datos, avisos y el comparativo de las 7 sucursales con la API del CFO", async () => {
    const llamadas: string[] = [];
    const f = vi.fn(async (url: string) => {
      llamadas.push(url);
      return json(200, RESUMEN);
    }) as unknown as typeof fetch;
    r = await montar(f);
    const c = r.container;
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]).toContain("/v1/restaurantes/prop-1/admin/cfo/resumen?");
    expect(llamadas[0]).toContain("desde=2026-09-21");
    // Toda la organizacion: nunca manda filtro de sucursales.
    expect(llamadas[0]).not.toContain("sucursales=");
    expect(c.querySelector("h1")?.textContent).toBe("Resumen general");
    expect(c.querySelector('[data-testid="resumen-general-frase"]')?.textContent).toContain("Tus 7 sucursales vendieron $238,186");
    expect(c.querySelector('[data-testid="resumen-general-frase"] strong')?.textContent).toBe("$238,186");
    expect(c.querySelector('[data-testid="resumen-general-datos"]')?.textContent).toContain("3 de 4");
    expect(c.querySelectorAll('[data-testid="resumen-general-aviso"]')).toHaveLength(3);
    const filas = [...c.querySelectorAll("[data-sucursal]")].map((e) => e.getAttribute("data-sucursal"));
    expect(filas).toContain("Galerías");
    expect(filas).toHaveLength(7);
  });

  it("«Pregúntale a tus datos» abre el Copiloto con la pregunta (el alcance lo pone el servidor)", async () => {
    r = await montar((async () => json(200, RESUMEN)) as unknown as typeof fetch);
    const input = r.container.querySelector('[data-testid="resumen-general-preguntar"] input') as HTMLInputElement;
    await act(async () => changeValue(input, "¿Qué sucursal vendió más?"));
    await act(async () => click(r!.container.querySelector('[data-testid="resumen-general-preguntar"] button[type="submit"]')!));
    expect(r.container.querySelector('[data-testid="ubicacion"]')?.textContent).toBe(`/restaurantes/pm/copiloto?q=${encodeURIComponent("¿Qué sucursal vendió más?")}`);
  });

  it("403 del CFO = estado honesto de sin acceso; 503 = aun no disponible; error = Reintentar vuelve a pedir", async () => {
    r = await montar((async () => json(403, { error: "forbidden" })) as unknown as typeof fetch);
    expect(r.container.textContent).toContain("Solo para dueño o administrador");
    r.unmount();
    r = await montar((async () => json(503, { error: "x" })) as unknown as typeof fetch);
    expect(r.container.textContent).toContain("Aún no disponible");
    r.unmount();
    let n = 0;
    r = await montar((async () => (++n === 1 ? json(500, { error: "x" }) : json(200, RESUMEN))) as unknown as typeof fetch);
    expect(r.container.textContent).toContain("No se pudo cargar el resumen general");
    const boton = [...r.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reintentar"))!;
    await act(async () => {
      click(boton);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(r.container.querySelector("h1")?.textContent).toBe("Resumen general");
  });

  it("el staff (sin `cfo.ver`) ve el estado de sin acceso y la pagina no consulta nada", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    r = await montar(f, "staff");
    expect(r.container.textContent).toContain("Solo para dueño o administrador");
    expect(f).not.toHaveBeenCalled();
  });
});
