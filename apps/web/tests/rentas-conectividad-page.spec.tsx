// @vitest-environment jsdom
//
// <ConectividadPage /> (Rn-P3-15/16/17): la matriz muestra el estado REAL de cada unidad y canal, el asistente marca los pasos con
// evidencia, el catálogo declara latencia con fuente y el motivo de lo bloqueado, y nunca aparece un botón "Conectar API".
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConectividadPage } from "../src/verticals/rentas/pages/Conectividad.tsx";
import type { RentasShellContext } from "../src/verticals/rentas/RentasShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function ctx(rol: string): RentasShellContext {
  return {
    apiBaseUrl: "https://api.test",
    token: "tok",
    propertyId: "prop-1",
    setPropertyId: () => {},
    properties: [{ propertyId: "prop-1", nombre: "Depa Marina" }],
    orgSlug: "demo",
    session: { token: "tok", refreshToken: "ref", email: "g@example.com", organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "rentas", rol }] },
  };
}

const res = (body: unknown, ok = true, status = ok ? 200 : 500): Response => ({ ok, status, json: async () => body }) as unknown as Response;
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

const CANAL = (codigo: string, nombre: string, extra: Record<string, unknown> = {}) => ({
  codigo,
  nombre,
  canal_atiende: codigo,
  via_hoy: "ical",
  via_ical: "disponible",
  descripcion_via: "iCal import/export (única vía sin aprobación de partner)",
  latencia: { texto: "~3 horas", confianza: "baja", fuente: "RV03 S1", nota: "" },
  bloqueo: { motivo: "API partner requiere NDA", cita: "PLAN §6" },
  requisitos: ["URL del calendario iCal de la unidad"],
  url_proceso_oficial: "https://example.com/ayuda",
  nota_anti_paridad: "",
  ...extra,
});
const AIRBNB = CANAL("airbnb", "Airbnb");
const BOOKING = CANAL("booking", "Booking.com", {
  via_hoy: "sin_evidencia",
  via_ical: "sin_evidencia",
  descripcion_via: "Ninguna vía directa documentada",
  latencia: { texto: "SIN EVIDENCIA", confianza: "sin_evidencia", fuente: null, nota: "" },
  bloqueo: { motivo: 'Pausado activamente por el canal: "pausing integrations with new connectivity providers until further notice"', cita: "b002-archivo F01" },
});
const EXPEDIA = CANAL("expedia", "Expedia Group", {
  canal_atiende: null,
  via_hoy: "partner",
  via_ical: "no_disponible",
  descripcion_via: "Lodging Connectivity API: requiere acuerdo de partner",
  latencia: { texto: "sin SLA publicado", confianza: "baja", fuente: "RV22 F04-F13", nota: "" },
  bloqueo: { motivo: "Requiere PCI/TLS/license agreement", cita: "RV22 F04-F13" },
});

const celda = (canal: string, estado: string, imp: Record<string, unknown> = {}, exp: Record<string, unknown> = {}) => ({
  canal,
  estado,
  import: { estado: "sin_conectar", ultima_sincronizacion_exitosa_en: null, en_cuarentena_desde: null, motivo_cuarentena: null, intentos_fallidos_consecutivos: 0, ...imp },
  export: { estado: "sin_token", token_creado_en: null, ultimo_acceso_en: null, ...exp },
});

const MATRIZ = {
  ahora: "2026-10-07T12:00:00.000Z",
  tokens_disponibles: true,
  canales: [AIRBNB, BOOKING],
  unidades: [
    {
      id: "u1",
      nombre: "Suite 1",
      celdas: [
        celda("airbnb", "conectado", { estado: "ok", ultima_sincronizacion_exitosa_en: "2026-10-07T11:50:00Z" }, { estado: "consultado", token_creado_en: "2026-10-01T00:00:00Z", ultimo_acceso_en: "2026-10-07T11:55:00Z" }),
        celda("booking", "en_cuarentena", { estado: "en_cuarentena", en_cuarentena_desde: "2026-10-07T08:00:00Z", motivo_cuarentena: "3 intentos fallidos", intentos_fallidos_consecutivos: 3 }),
      ],
    },
    { id: "u2", nombre: "Suite 2", celdas: [celda("airbnb", "sin_conectar"), celda("booking", "solo_import", { estado: "ok", ultima_sincronizacion_exitosa_en: "2026-10-07T11:00:00Z" })] },
  ],
};

function stub(matriz: unknown = MATRIZ, opciones: { fallaMatriz?: boolean } = {}) {
  const f = vi.fn(async (url: string) => {
    if (url.endsWith("/conectividad")) return opciones.fallaMatriz ? res({ message: "boom" }, false) : res(matriz);
    if (url.endsWith("/canales/catalogo")) return res({ canales: [AIRBNB, BOOKING, EXPEDIA] });
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", f);
  return f;
}

async function montar(rol = "admin_gestora", entrada = "/rentas/demo/conectividad"): Promise<RenderedComponent> {
  const r = renderComponent(
    <MemoryRouter initialEntries={[entrada]}>
      <ConectividadPage {...ctx(rol)} />
    </MemoryRouter>,
  );
  await esperar();
  return r;
}

describe("ConectividadPage", () => {
  it("muestra el estado real de cada celda, con la latencia declarada y su confianza en cada columna", async () => {
    stub();
    rendered = await montar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Matriz de conectividad");
    expect(texto).toContain("Suite 1");
    expect(texto).toContain("Conectado");
    expect(texto).toContain("En cuarentena");
    expect(texto).toContain("3 intentos fallidos");
    expect(texto).toContain("Solo importa");
    expect(texto).toContain("Sin conectar");
    expect(texto).toContain("Latencia: ~3 horas (baja)");
    // Booking: nunca una cifra inventada.
    expect(texto).toContain("Latencia: SIN EVIDENCIA (sin evidencia)");
    expect(texto).toContain("El canal consultó");
  });

  it("el catálogo muestra el motivo exacto con su cita y NUNCA un botón de conectar API", async () => {
    stub();
    rendered = await montar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Canales de distribución en México");
    expect(texto).toContain("Requiere acuerdo de partner");
    expect(texto).toContain("Requiere PCI/TLS/license agreement");
    expect(texto).toContain("(RV22 F04-F13)");
    expect(texto).toContain("pausing integrations with new connectivity providers");
    const botones = [...rendered.container.querySelectorAll("button, a")].map((b) => b.textContent?.toLowerCase() ?? "");
    expect(botones.some((t) => t.includes("conectar api") || t.includes("pronto"))).toBe(false);
  });

  it("abrir el asistente de una celda marca los pasos con evidencia real", async () => {
    stub();
    rendered = await montar();
    const boton = rendered.container.querySelector('button[aria-label="Abrir el asistente de Suite 1 en Airbnb"]')!;
    click(boton);
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Asistente: Airbnb · Suite 1");
    expect(texto).toContain("Última sincronización exitosa");
    expect(texto).toContain("Última consulta de Airbnb");
    expect(rendered.container.querySelectorAll('[aria-label="Hecho"]').length).toBe(4);
    expect(rendered.container.querySelectorAll('[aria-label="Sin verificar"]').length).toBe(1);
    expect(rendered.container.querySelector('a[href="/rentas/demo/ical-sync"]')).not.toBeNull();
  });

  it("abre directo el asistente desde el enlace de Sincronización iCal (?unidad=&canal=) y Booking advierte la falta de evidencia", async () => {
    stub();
    rendered = await montar("admin_gestora", "/rentas/demo/conectividad?unidad=u2&canal=booking");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Asistente: Booking.com · Suite 2");
    expect(texto).toContain("Sin evidencia de que Booking.com ofrezca iCal");
  });

  it("sin unidades muestra el estado vacío honesto", async () => {
    stub({ ...MATRIZ, unidades: [] });
    rendered = await montar();
    expect(rendered.container.textContent).toContain("Sin unidades");
  });

  it("un error del servidor se muestra y permite reintentar (no deja la pantalla en blanco)", async () => {
    stub(MATRIZ, { fallaMatriz: true });
    rendered = await montar();
    expect(rendered.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("un rol sin acceso (contador) ve el aviso y no llama a la API", async () => {
    const f = stub();
    rendered = await montar("contador");
    expect(rendered.container.textContent).toContain("no tiene acceso a la conectividad de canales");
    expect(f).not.toHaveBeenCalled();
  });

  it("sin la migración de tokens, la celda declara la exportación 'no disponible aún'", async () => {
    stub({ ...MATRIZ, tokens_disponibles: false, unidades: [{ id: "u1", nombre: "Suite 1", celdas: [celda("airbnb", "solo_import", { estado: "ok" }, { estado: "no_disponible_aun" }), celda("booking", "sin_conectar")] }] });
    rendered = await montar();
    expect(rendered.container.textContent).toContain("Exportación: no disponible aún en este entorno.");
  });
});
