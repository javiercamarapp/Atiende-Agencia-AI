// @vitest-environment jsdom
// Pestana "Listo para produccion" de la ficha de una organizacion: efectos observables con la API simulada por ruta. Estados: cargando,
// datos (KPI de pendientes, semaforo por area, como resolver con su enlace), "Volver a verificar", fuente que no se pudo leer y error con reintento.
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminOrganizacionFichaPage } from "../src/superadmin/pages/OrganizacionFicha.tsx";
import type { RespuestaPreflight } from "../src/superadmin/lib/preflight.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const FICHA_NO_DISPONIBLE = {
  disponible: false,
  mensaje: "No disponible aún: falta aplicar la migración 0052.",
  organizacion: { id: "o1", nombre: "Los Taquitos de PM", slug: "los-taquitos-de-pm", vertical: "restaurantes", estado: "trial", creadaEn: "2026-09-01T00:00:00.000Z" },
};

const v = (id: string, area: RespuestaPreflight["areas"][number]["area"], estado: "ok" | "falta" | "aviso" | "no_aplica", titulo: string, detalle: string, enlace: string | null = null) => ({
  id, area, estado, titulo, detalle, como_resolver: { texto: `Resuelve ${titulo}.`, enlace },
});

const PREFLIGHT: RespuestaPreflight = {
  organizacion: { id: "o1", nombre: "Los Taquitos de PM", slug: "los-taquitos-de-pm", vertical: "restaurantes", estado: "trial" },
  generadoEn: "2026-10-04T18:00:00.000Z",
  resumen: { total: 6, ok: 2, falta: 2, aviso: 1, no_aplica: 1, pendientes: 2, listo: false },
  fuentes: { crons: "ok", equipo: "ok", datos: "ok", mfa: "ok" },
  areas: [
    { area: "entorno", verificaciones: [v("entorno.meta", "entorno", "ok", "WhatsApp / Meta", "Configurada.")] },
    {
      area: "equipo",
      verificaciones: [
        v("equipo.owner", "equipo", "falta", "Al menos un owner activo", "Nadie puede entrar al panel: la organización no tiene ningún owner.", "/superadmin/organizaciones/o1"),
        v("equipo.mfa_superadmin", "equipo", "falta", "El superadmin que verifica tiene MFA activa", "Tu cuenta no tiene MFA.", "/superadmin/seguridad"),
      ],
    },
    { area: "canal", verificaciones: [v("canal.plantillas", "canal", "aviso", "Plantillas de estado de pedido declaradas", "No hay plantillas declaradas.", "/superadmin/integraciones")] },
    { area: "voz", verificaciones: [v("voz.credenciales", "voz", "no_aplica", "Credenciales de voz", "Ninguna sucursal activa tiene la voz habilitada.")] },
    { area: "monitoreo", verificaciones: [v("monitoreo.alertas", "monitoreo", "ok", "Alertas salientes", "1 canal(es) de alerta configurado(s).")] },
    { area: "privacidad", verificaciones: [] },
  ],
};

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;
async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function stub(o: { preflight?: () => Response } = {}) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/preflight")) return (o.preflight ?? (() => json(PREFLIGHT)))();
    if (url.includes("/ficha")) return json(FICHA_NO_DISPONIBLE);
    if (url.endsWith("/superadmin/organizaciones/margen")) return json({ disponible: false, mes: "2026-10", mensaje: "n/d", margenes: {} });
    if (url.includes("/invitaciones")) return json({ disponible: false, mensaje: "n/d", miembros: [], invitaciones: [], sucursales: [] });
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const render = () =>
  renderComponent(
    <MemoryRouter initialEntries={["/superadmin/organizaciones/o1"]}>
      <Routes>
        <Route path="/superadmin/organizaciones/:id" element={<SuperAdminOrganizacionFichaPage apiBaseUrl="https://api.test" token="tok" />} />
      </Routes>
    </MemoryRouter>,
  );
const tab = (label: string) => Array.from(rendered!.container.querySelectorAll('[role="tab"]')).find((b) => b.textContent?.trim() === label) as HTMLElement | undefined;
const llamadasPreflight = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("/preflight")).length;
const texto = () => rendered!.container.textContent ?? "";
const boton = (label: string) => Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;

async function abrirPreflight(): Promise<void> {
  await act(async () => {
    const t = tab("Listo para producción")!;
    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    t.focus();
    await flushMicrotasks();
  });
  await esperar();
}

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("pestana 'Listo para produccion'", () => {
  it("no pide el preflight hasta abrir la pestana (aun con la ficha sin migrar)", async () => {
    stub();
    rendered = render();
    await esperar();
    expect(tab("Listo para producción")).toBeDefined();
    expect(llamadasPreflight()).toBe(0);
  });

  it("al abrirla muestra el conteo de pendientes, el semaforo por area y como resolver con su enlace", async () => {
    stub();
    rendered = render();
    await esperar();
    await abrirPreflight();
    expect(llamadasPreflight()).toBe(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "https://api.test/superadmin/organizaciones/o1/preflight")).toBe(true);
    const kpi = Array.from(rendered.container.querySelectorAll('[data-testid="stat-card-chip"]')).map((c) => c.closest(".flex.h-full")?.textContent ?? "");
    expect(kpi.some((t) => t.includes("Pendientes") && t.includes("2"))).toBe(true);
    expect(kpi.some((t) => t.includes("Avisos") && t.includes("1"))).toBe(true);
    expect(rendered.container.querySelector('[data-area="equipo"]')?.getAttribute("data-semaforo")).toBe("falta");
    expect(rendered.container.querySelector('[data-area="canal"]')?.getAttribute("data-semaforo")).toBe("aviso");
    expect(rendered.container.querySelector('[data-area="entorno"]')?.getAttribute("data-semaforo")).toBe("ok");
    expect(rendered.container.querySelector('[data-area="voz"]')?.getAttribute("data-semaforo")).toBe("no_aplica");
    // Un area sin verificaciones (no aplica a esta organizacion) no se pinta.
    expect(rendered.container.querySelector('[data-area="privacidad"]')).toBeNull();
    const fila = rendered.container.querySelector('[data-verificacion="equipo.owner"]')!;
    expect(fila.textContent).toContain("Nadie puede entrar al panel");
    expect(fila.textContent).toContain("Resuelve Al menos un owner activo.");
    expect(fila.querySelector("a")?.getAttribute("href")).toBe("/superadmin/organizaciones/o1");
    // Lo que esta en orden no repite el "como resolver".
    expect(rendered.container.querySelector('[data-verificacion="entorno.meta"]')?.textContent).not.toContain("Resuelve");
  });

  it("'Volver a verificar' vuelve a leer del servidor", async () => {
    stub();
    rendered = render();
    await esperar();
    await abrirPreflight();
    expect(llamadasPreflight()).toBe(1);
    click(boton("Volver a verificar")!);
    await esperar();
    expect(llamadasPreflight()).toBe(2);
  });

  it("una fuente que no se pudo leer se avisa; nunca se presenta como en orden", async () => {
    stub({ preflight: () => json({ ...PREFLIGHT, fuentes: { crons: "ok", equipo: "no_migrado", datos: "error", mfa: "ok" } }) });
    rendered = render();
    await esperar();
    await abrirPreflight();
    expect(texto()).toContain("No se pudo leer por completo");
    expect(texto()).toContain("el equipo");
    expect(texto()).toContain("los datos del restaurante");
  });

  it("organizacion lista: el KPI de pendientes dice que nada bloquea", async () => {
    stub({ preflight: () => json({ ...PREFLIGHT, resumen: { ...PREFLIGHT.resumen, falta: 0, pendientes: 0, listo: true } }) });
    rendered = render();
    await esperar();
    await abrirPreflight();
    expect(texto()).toContain("Nada bloquea el go-live.");
  });

  it("error del servidor: estado de error con reintento que vuelve a pedir", async () => {
    let falla = true;
    stub({ preflight: () => (falla ? json({ message: "x" }, false, 500) : json(PREFLIGHT)) });
    rendered = render();
    await esperar();
    await abrirPreflight();
    expect(texto()).toContain("No se pudo verificar la organización.");
    falla = false;
    click(boton("Reintentar")!);
    await esperar();
    expect(llamadasPreflight()).toBe(2);
    expect(texto()).toContain("Pendientes");
  });

  it("respuesta con forma inesperada: error, no una pantalla rota", async () => {
    stub({ preflight: () => json({ algo: "raro" }) });
    rendered = render();
    await esperar();
    await abrirPreflight();
    expect(texto()).toContain("No se pudo verificar la organización.");
  });
});
