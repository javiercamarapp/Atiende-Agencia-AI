// @vitest-environment jsdom
//
// Rn-26/Rn-40 -- <RentasDashboardPage /> (Resumen operativo): render con datos, vacío honesto, error total con reintento,
// error PARCIAL por bloque ("no disponible" sin tumbar el resto), bloques sin permiso ocultos y redirección del rol limpieza.
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RentasDashboardPage } from "../src/verticals/rentas/pages/Dashboard.tsx";
import { fetchResumen } from "../src/verticals/rentas/lib/resumen-client.ts";
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
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const sesion = (rol: string): LoginSession => ({ token: "tok", refreshToken: "ref", email: "ana.torres@example.com", fullName: "Ana Torres", organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora Demo", vertical: "rentas", rol }] });
const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const RESUMEN = (extra: object = {}) => ({
  hoy: "2026-10-02",
  zona_horaria: "America/Mexico_City",
  llegadas_salidas: { estado: "ok", llegadas: 3, salidas: 2 },
  ocupacion_mes: { estado: "ok", periodo: { desde: "2026-10-01", hasta: "2026-11-01" }, ocupacion_basis_points: 4516, noches_ocupadas: 14, noches_disponibles: 31 },
  conflictos: { estado: "ok", abiertos: 1 },
  limpieza: { estado: "ok", pendientes: 4, vencidas: 1 },
  aprobaciones: { estado: "ok", pendientes: 5 },
  feeds: { estado: "ok", activos: 3, con_problema: 2 },
  agentes: [
    { clave: "sync_ical", nombre: "Sincronización iCal", ultima_corrida_en: "2026-10-02T18:05:00.000Z", estado: "atencion", detalle: "3 feeds activos" },
    { clave: "borradores_ia", nombre: "Borradores de mensajería con IA", ultima_corrida_en: "2026-10-02T17:00:00.000Z", estado: "ok", detalle: "Último borrador generado" },
  ],
  ...extra,
});

function montar(rol = "admin_gestora"): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={["/rentas/gestora-demo"]}>
      <Routes>
        <Route
          path="/rentas/gestora-demo"
          element={<RentasDashboardPage apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" setPropertyId={() => {}} properties={[{ propertyId: "prop-1", nombre: "Casa del mar" }]} orgSlug="gestora-demo" session={sesion(rol)} />}
        />
        <Route path="/rentas/gestora-demo/mis-tareas" element={<p>PANEL MIS TAREAS</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RentasDashboardPage (Resumen operativo)", () => {
  it("pinta saludo con nombre, los 7 KPI con las cifras del servidor, pildoras y agentes con su última corrida", async () => {
    const fetchMock = vi.fn(async () => json(RESUMEN()));
    vi.stubGlobal("fetch", fetchMock);
    rendered = montar();
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Ana");
    expect(texto).toContain("Gestora Demo · Casa del mar · ");
    for (const etiqueta of ["Llegadas hoy", "Salidas hoy", "Ocupación del mes", "Conflictos abiertos", "Tareas pendientes", "Por aprobar", "Feeds iCal con problema"]) expect(texto).toContain(etiqueta);
    expect(texto).toContain("45.2%");
    expect(texto).toContain("14 de 31 noches");
    expect(texto).toContain("1 vencida");
    expect(texto).toContain("de 3 feeds activos");
    expect(texto).toContain("Orquestación de agentes");
    expect(texto).toContain("Sincronización iCal");
    expect(texto).toContain("Requiere atención");
    expect(texto).toContain("Borradores de mensajería con IA");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("http://api.local/rentas/prop-1/resumen");
    const enlaces = Array.from(rendered.container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(enlaces).toEqual(expect.arrayContaining(["/rentas/gestora-demo/calendario", "/rentas/gestora-demo/monitor-sync", "/rentas/gestora-demo/mis-tareas", "/rentas/gestora-demo/aprobaciones", "/rentas/gestora-demo/reportes", "/rentas/gestora-demo/ical-sync"]));
  });

  it("vacío: ceros reales (no '—') y los agentes sin corridas lo dicen en vez de inventarlas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          RESUMEN({
            llegadas_salidas: { estado: "ok", llegadas: 0, salidas: 0 },
            conflictos: { estado: "ok", abiertos: 0 },
            limpieza: { estado: "ok", pendientes: 0, vencidas: 0 },
            aprobaciones: { estado: "ok", pendientes: 0 },
            feeds: { estado: "ok", activos: 0, con_problema: 0 },
            agentes: [],
          }),
        ),
      ),
    );
    rendered = montar();
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Sin llegadas hoy");
    expect(texto).toContain("Bandeja al día");
    expect(texto).toContain("Todavía no hay corridas registradas de los agentes");
    expect(texto).not.toContain("Sincronización iCal");
  });

  it("error parcial: un bloque 'no_disponible' dice por qué y el resto de los KPI carga; uno 'sin_permiso' no se pinta", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(RESUMEN({ limpieza: { estado: "no_disponible" }, aprobaciones: { estado: "sin_permiso" }, agentes: [] }))));
    rendered = montar("operador:calendario_mensajeria");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Tareas pendientes");
    expect(texto).toContain("No disponible aún en este ambiente");
    expect(texto).toContain("Llegadas hoy");
    expect(texto).toContain("Conflictos abiertos");
    expect(texto).not.toContain("Por aprobar");
    expect(texto).not.toContain("Ver aprobaciones");
    expect(texto).not.toContain("Ver reportes"); // este rol no abre Reportes
  });

  it("error total: muestra el mensaje con 'Reintentar' y vuelve a pedir el resumen", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ error: { message: "Servicio no disponible" } }, 503)).mockResolvedValue(json(RESUMEN()));
    vi.stubGlobal("fetch", fetchMock);
    rendered = montar();
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo cargar");
    const reintentar = Array.from(rendered.container.querySelectorAll("button")).find((b) => /reintentar/i.test(b.textContent ?? ""));
    expect(reintentar).toBeDefined();
    click(reintentar!);
    await esperar();
    // El tablero de fijados del Copiloto (/chat-datos/pins) y el checklist de onboarding (/admin/onboarding) hacen su propia lectura: el reintento es del RESUMEN.
    expect(fetchMock.mock.calls.filter(([u]) => !String(u).includes("/chat-datos/pins") && !String(u).includes("/admin/onboarding"))).toHaveLength(2);
    expect(rendered.container.textContent).toContain("Llegadas hoy");
  });

  it("el rol limpieza se redirige a Mis tareas sin pedir el resumen", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    rendered = montar("limpieza");
    await esperar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("PANEL MIS TAREAS");
  });
});

describe("fetchResumen", () => {
  it("un bloque de estado desconocido o ausente se trata como no disponible (nunca una cifra inventada)", async () => {
    const r = await fetchResumen(async () => json(RESUMEN({ conflictos: { estado: "raro", abiertos: 9 }, feeds: undefined })), "http://api.local", "tok", "prop-1");
    expect(r.conflictos).toEqual({ estado: "no_disponible" });
    expect(r.feeds).toEqual({ estado: "no_disponible" });
    expect(r.llegadasSalidas).toEqual({ estado: "ok", llegadas: 3, salidas: 2 });
  });
});
