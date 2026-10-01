// @vitest-environment jsdom
//
// Rn-06 -- calendario visual de rentas (CalendarioPage -> CalendarioVisual): carga por ventana, navegación por mes y "Hoy",
// teclado (rejilla ARIA), filtros, capas opcionales que degradan con honestidad, conflictos, aviso de truncado, agenda móvil,
// carrera de respuestas entre meses y salto a la lista de gestión. El reloj solo falsea `Date` (sin timers: un setInterval vivo
// con relojes falsos es lo que dejó fugas de memoria en otras suites).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarioPage } from "../src/verticals/rentas/pages/Calendario.tsx";
import type { RentasShellContext } from "../src/verticals/rentas/RentasShell.tsx";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 05:30 UTC del 15-oct-2026 = 00:30 del 15 en Cancún.
  vi.setSystemTime(new Date("2026-10-15T05:30:00Z"));
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const CTX: RentasShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  setPropertyId: () => {},
  properties: [{ propertyId: "prop-1", nombre: "Depa Marina" }],
  orgSlug: "demo",
  session: { token: "tok-123", refreshToken: "ref", email: "g@example.com", organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "rentas", rol: "admin_gestora" }] },
};

const res = (body: unknown, ok = true, status = ok ? 200 : 400): Response => ({ ok, status, json: async () => body }) as unknown as Response;
const UNIDADES = [
  { id: "u1", nombre: "Depa 101", duracionMinimaNoches: 1 },
  { id: "u2", nombre: "Depa 202", duracionMinimaNoches: 1 },
];
const oc = (id: string, unidadId: string, inicio: string, fin: string, extra: Record<string, unknown> = {}) => ({
  id, unidadId, capa: "reserva", rango: { inicio, fin }, razon: "RESERVA_CANAL", estado: "confirmado", canalCodigo: "manual", huespedNombre: null, ...extra,
});
const OCUPACIONES = [
  oc("a", "u1", "2026-10-10", "2026-10-12", { huespedNombre: "Ana Pérez" }),
  oc("b", "u2", "2026-10-11", "2026-10-14", { canalCodigo: "airbnb", huespedNombre: "Bruno" }),
  oc("blq", "u1", "2026-10-20", "2026-10-22", { capa: "bloqueo", razon: "MANTENIMIENTO", canalCodigo: null }),
];
const TAREA = { id: "t1", propertyId: "prop-1", unidadId: "u1", unidadNombre: "Depa 101", tipo: "limpieza", estado: "pendiente", prioridad: "media", asignadoA: null, esProveedorExterno: false, programadaPara: "2026-10-12", slaVenceEn: null, completadaEn: null, creadoEn: "x" };
const CONFLICTO = {
  id: "k1", estado: "abierto", motivo_resolucion: null, detectado_en_local: null, resuelto_en_local: null, resuelto_por_mi: false, solape: null, unidad_id: "u2", unidad_nombre: "Depa 202", tipo: "overbooking_confirmado", detectado_en: "x", resuelto_en: null,
  ocupacion_a: { id: "b", inicio: "2026-10-11", fin: "2026-10-14", estado: "confirmado", capa: "reserva", canal: "airbnb" }, ocupacion_b: null,
};

interface Opciones {
  ocupaciones?: unknown[];
  truncado?: boolean;
  total?: number;
  tareas?: Response | (() => Response);
  conflictos?: unknown[] | "403";
  calendario?: (url: string) => Response | Promise<Response>;
}

function stub(o: Opciones = {}) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/unidades")) return res({ unidades: UNIDADES });
    if (url.includes("/calendario?")) {
      if (o.calendario) return o.calendario(url);
      const ocupaciones = o.ocupaciones ?? OCUPACIONES;
      return res({ zona_horaria: "America/Cancun", hoy: "2026-10-15", total: o.total ?? ocupaciones.length, truncado: o.truncado ?? false, ocupaciones });
    }
    if (url.includes("/tareas?")) return typeof o.tareas === "function" ? o.tareas() : (o.tareas ?? res({ tareas: [TAREA] }));
    if (url.includes("/conflictos?")) {
      if (o.conflictos === "403") return res({ error: { message: "Rol sin acceso al monitor de sincronización." } }, false, 403);
      return res({ zona_horaria: "America/Cancun", conflictos: o.conflictos ?? [], total_abiertos: (o.conflictos as unknown[] | undefined)?.length ?? 0 });
    }
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
}

async function abrir(o: Opciones = {}): Promise<RenderedComponent> {
  stub(o);
  const r = renderComponent(<CalendarioPage {...CTX} />);
  await esperar();
  return r;
}

const celda = (r: RenderedComponent, dia: string) => r.container.querySelector<HTMLButtonElement>(`button[data-fecha="${dia}"]`)!;
const botonPorTexto = (r: RenderedComponent, texto: string) => [...r.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;
const urlsDe = (parte: string) => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes(parte));

describe("Calendario visual -- carga y mes", () => {
  it("pide UNA ventana que cubre la rejilla del mes (lunes a domingo) y pinta reservas, bloqueos y limpiezas", async () => {
    rendered = await abrir();
    const [url] = urlsDe("/calendario?");
    expect(url).toBe("https://api.test/rentas/prop-1/calendario?desde=2026-09-28&hasta=2026-11-02");
    expect(urlsDe("/tareas?")[0]).toContain("desde=2026-09-28&hasta=2026-11-01");
    expect(rendered.container.querySelector('[role="grid"]')!.getAttribute("aria-label")).toBe("Calendario de octubre de 2026");
    expect(celda(rendered, "2026-10-10").textContent).toContain("Ana Pérez");
    expect(celda(rendered, "2026-10-11").textContent).toContain("Ana Pérez");
    expect(celda(rendered, "2026-10-11").textContent).toContain("Bruno");
    expect(celda(rendered, "2026-10-12").textContent).not.toContain("Ana Pérez"); // día de salida: la noche ya no es suya
    expect(celda(rendered, "2026-10-12").textContent).toContain("1 salida");
    expect(celda(rendered, "2026-10-12").textContent).toContain("Limpieza");
    expect(celda(rendered, "2026-10-20").textContent).toContain("Mantenimiento");
  });

  it("'hoy' sale de la zona de la propiedad: a las 00:30 del 15 en Cancún el día 15 es hoy aunque en CDMX aún sea el 14", async () => {
    rendered = await abrir();
    expect(celda(rendered, "2026-10-15").getAttribute("aria-current")).toBe("date");
    expect(celda(rendered, "2026-10-14").getAttribute("aria-current")).toBeNull();
    expect(celda(rendered, "2026-10-15").getAttribute("aria-label")).toContain("hoy");
  });

  it("navegar al mes siguiente pide la ventana de noviembre y 'Hoy' vuelve a octubre", async () => {
    rendered = await abrir();
    click(rendered.container.querySelector('button[aria-label="Mes siguiente"]')!);
    await esperar();
    expect(urlsDe("/calendario?").at(-1)).toBe("https://api.test/rentas/prop-1/calendario?desde=2026-10-26&hasta=2026-12-07");
    expect(rendered.container.querySelector("h2")!.textContent).toBe("noviembre de 2026");
    click(botonPorTexto(rendered, "Hoy"));
    await esperar();
    expect(rendered.container.querySelector("h2")!.textContent).toBe("octubre de 2026");
    expect(urlsDe("/calendario?").at(-1)).toContain("desde=2026-09-28");
  });

  it("una respuesta lenta del mes anterior nunca pisa el mes que el usuario ya está viendo", async () => {
    let soltarOctubre: (r: Response) => void = () => {};
    const octubre = new Promise<Response>((resolve) => {
      soltarOctubre = resolve;
    });
    stub({
      calendario: (url) =>
        url.includes("desde=2026-09-28") ? octubre : res({ zona_horaria: "America/Cancun", hoy: "2026-10-15", total: 1, truncado: false, ocupaciones: [oc("nov", "u1", "2026-11-10", "2026-11-12", { huespedNombre: "Noviembre" })] }),
    });
    rendered = renderComponent(<CalendarioPage {...CTX} />);
    await esperar();
    click(rendered.container.querySelector('button[aria-label="Mes siguiente"]')!);
    await esperar();
    await act(async () => {
      soltarOctubre(res({ zona_horaria: "America/Cancun", hoy: "2026-10-15", total: 1, truncado: false, ocupaciones: [oc("old", "u1", "2026-11-10", "2026-11-12", { huespedNombre: "Octubre tardío" })] }));
      await flushMicrotasks();
    });
    expect(rendered.container.textContent).toContain("Noviembre");
    expect(rendered.container.textContent).not.toContain("Octubre tardío");
  });

  it("un error de la ventana se muestra y 'Reintentar' vuelve a pedirla", async () => {
    let falla = true;
    stub({ calendario: () => (falla ? res({}, false, 500) : res({ zona_horaria: "America/Cancun", hoy: "2026-10-15", total: 0, truncado: false, ocupaciones: [] })) });
    rendered = renderComponent(<CalendarioPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("(500)");
    falla = false;
    click(botonPorTexto(rendered, "Reintentar"));
    await esperar();
    expect(rendered.container.querySelector('[role="grid"]')).not.toBeNull();
  });

  it("más de 3 elementos en un día se resumen en '+N más' y el detalle del día los lista todos", async () => {
    const muchas = [1, 2, 3, 4, 5].map((n) => oc(`m${n}`, "u1", "2026-10-05", "2026-10-06", { huespedNombre: `Huésped ${n}` }));
    rendered = await abrir({ ocupaciones: muchas });
    expect(celda(rendered, "2026-10-05").textContent).toContain("+2 más");
    click(celda(rendered, "2026-10-05"));
    await esperar();
    const detalle = rendered.container.querySelector('section[aria-label="Detalle"]')!;
    expect(detalle.textContent).toContain("Huésped 5");
  });

  it("avisa cuando el servidor trunca la ventana", async () => {
    rendered = await abrir({ truncado: true, total: 1200 });
    expect(rendered.container.textContent).toContain("Este periodo tiene 1200 ocupaciones");
  });

  it("una propiedad sin unidades lo dice en vez de mostrar una rejilla vacía", async () => {
    stub();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/unidades")) return res({ unidades: [] });
      if (url.includes("/calendario?")) return res({ zona_horaria: "America/Cancun", hoy: "2026-10-15", total: 0, truncado: false, ocupaciones: [] });
      if (url.includes("/tareas?")) return res({ tareas: [] });
      return res({ zona_horaria: "America/Cancun", conflictos: [], total_abiertos: 0 });
    });
    rendered = renderComponent(<CalendarioPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Esta propiedad todavía no tiene ninguna unidad configurada.");
  });
});

describe("Calendario visual -- capas y filtros", () => {
  it("un conflicto abierto de Rn-02 marca la reserva, muestra el aviso y enlaza al monitor", async () => {
    rendered = await abrir({ conflictos: [CONFLICTO] });
    expect(rendered.container.textContent).toContain("1 conflicto abierto de calendario");
    expect(rendered.container.querySelector('a[href="/rentas/demo/monitor-sync"]')).not.toBeNull();
    expect(celda(rendered, "2026-10-12").getAttribute("aria-label")).toContain("1 con conflicto");
    click(celda(rendered, "2026-10-12"));
    await esperar();
    const detalle = rendered.container.querySelector('section[aria-label="Detalle"]')!;
    expect(detalle.textContent).toContain("Conflicto abierto");
    expect(detalle.textContent).toContain("Revisar en el Monitor de conflictos");
  });

  it("un rol sin acceso a limpiezas o conflictos sigue viendo el calendario, con un aviso honesto y la capa desactivada", async () => {
    rendered = await abrir({ tareas: () => res({ error: { message: "Tu rol no puede ver tareas." } }, false, 403), conflictos: "403" });
    expect(rendered.container.querySelector('[role="grid"]')).not.toBeNull();
    expect(celda(rendered, "2026-10-10").textContent).toContain("Ana Pérez");
    expect(rendered.container.textContent).toContain("La capa de limpiezas no está disponible");
    expect(rendered.container.textContent).toContain("La capa de conflictos no está disponible");
    const casilla = (texto: string) => [...rendered!.container.querySelectorAll("label")].find((l) => l.textContent?.includes(texto))!.querySelector("input")!;
    expect(casilla("Limpiezas").disabled).toBe(true);
    expect(casilla("Conflictos").disabled).toBe(true);
    expect(casilla("Reservas").disabled).toBe(false);
  });

  it("filtrar por canal deja solo esas reservas (y los bloqueos); filtrar por unidad deja solo esa unidad", async () => {
    rendered = await abrir();
    const selects = rendered.container.querySelectorAll("select");
    const [unidad, canal] = [selects[0]!, selects[1]!];
    expect([...canal.options].map((o) => o.textContent)).toEqual(["Todos los canales", "Directa", "Airbnb"]);
    changeValue(canal, "airbnb");
    expect(celda(rendered, "2026-10-11").textContent).toContain("Bruno");
    expect(celda(rendered, "2026-10-10").textContent).not.toContain("Ana Pérez");
    expect(celda(rendered, "2026-10-20").textContent).toContain("Mantenimiento");
    changeValue(canal, "");
    changeValue(unidad, "u2");
    expect(celda(rendered, "2026-10-11").textContent).toContain("Bruno");
    expect(celda(rendered, "2026-10-20").textContent).not.toContain("Mantenimiento");
  });

  it("apagar la capa de reservas las oculta", async () => {
    rendered = await abrir();
    const casilla = [...rendered.container.querySelectorAll("label")].find((l) => l.textContent?.includes("Reservas"))!.querySelector("input")!;
    click(casilla);
    expect(celda(rendered, "2026-10-10").textContent).not.toContain("Ana Pérez");
    expect(celda(rendered, "2026-10-20").textContent).toContain("Mantenimiento");
  });
});

describe("Calendario visual -- teclado y accesibilidad", () => {
  it("la rejilla tiene una sola parada de Tab y las flechas mueven el foco entre días", async () => {
    rendered = await abrir();
    const paradas = [...rendered.container.querySelectorAll<HTMLButtonElement>("button[data-fecha]")].filter((b) => b.tabIndex === 0);
    expect(paradas).toHaveLength(1);
    expect(paradas[0]!.dataset.fecha).toBe("2026-10-15");
    act(() => celda(rendered!, "2026-10-15").focus());
    keydown(celda(rendered, "2026-10-15"), "ArrowRight");
    expect(document.activeElement).toBe(celda(rendered, "2026-10-16"));
    keydown(celda(rendered, "2026-10-16"), "ArrowDown");
    expect(document.activeElement).toBe(celda(rendered, "2026-10-23"));
    keydown(celda(rendered, "2026-10-23"), "ArrowLeft");
    expect(document.activeElement).toBe(celda(rendered, "2026-10-22"));
    keydown(celda(rendered, "2026-10-22"), "Home");
    expect(document.activeElement).toBe(celda(rendered, "2026-10-19"));
    keydown(celda(rendered, "2026-10-19"), "End");
    expect(document.activeElement).toBe(celda(rendered, "2026-10-25"));
  });

  it("RePág/AvPág cambian de mes y la flecha que sale de la rejilla también", async () => {
    rendered = await abrir();
    act(() => celda(rendered!, "2026-10-15").focus());
    keydown(celda(rendered, "2026-10-15"), "PageDown");
    await esperar();
    expect(rendered.container.querySelector("h2")!.textContent).toBe("noviembre de 2026");
    expect(document.activeElement).toBe(celda(rendered, "2026-11-15"));
    act(() => celda(rendered!, "2026-11-30").focus());
    keydown(celda(rendered, "2026-11-30"), "ArrowRight"); // 1-dic está en la última semana de la rejilla de noviembre
    await esperar();
    expect(document.activeElement).toBe(celda(rendered, "2026-12-01"));
  });

  it("cada día es un botón con un aria-label que resume su contenido y la rejilla expone filas y encabezados", async () => {
    rendered = await abrir();
    expect(celda(rendered, "2026-10-12").getAttribute("aria-label")).toBe("lunes 12 de octubre de 2026, 2 elementos, 1 salida");
    expect(rendered.container.querySelectorAll('[role="columnheader"]')).toHaveLength(7);
    expect(rendered.container.querySelectorAll('[role="row"]').length).toBeGreaterThanOrEqual(5);
  });

  it("seleccionar un día abre el detalle con ocupan la noche y salidas (check-out)", async () => {
    rendered = await abrir();
    click(celda(rendered, "2026-10-12"));
    await esperar();
    const detalle = rendered.container.querySelector('section[aria-label="Detalle"]')!;
    expect(detalle.getAttribute("aria-live")).toBe("polite");
    expect(detalle.textContent).toContain("Salen este día (check-out)");
    expect(detalle.textContent).toContain("Ana Pérez");
    expect(detalle.textContent).toContain("10 oct → 12 oct · 2 noches");
  });
});

describe("Calendario visual -- línea de tiempo, agenda móvil y gestión", () => {
  it("la línea de tiempo muestra una barra por elemento con su descripción completa, por unidad", async () => {
    rendered = await abrir({ conflictos: [CONFLICTO] });
    click(botonPorTexto(rendered, "Línea de tiempo"));
    const grupo = (n: string) => rendered!.container.querySelector(`[role="group"][aria-label="${n}"]`)!;
    const barras = (n: string) => [...grupo(n).querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(barras("Depa 101")).toEqual([
      "Depa 101: Reserva confirmada, canal Directa, huésped Ana Pérez, 10 oct → 12 oct · 2 noches",
      "Depa 101: Limpieza pendiente, 12 oct → 13 oct · 1 noche",
      "Depa 101: Mantenimiento (activo), 20 oct → 22 oct · 2 noches",
    ]);
    expect(barras("Depa 202")).toEqual(["Depa 202: Reserva confirmada, canal Airbnb, huésped Bruno, 11 oct → 14 oct · 3 noches, con conflicto"]);
    click(grupo("Depa 202").querySelector("button")!);
    expect(rendered.container.querySelector('section[aria-label="Detalle"]')!.textContent).toContain("Conflicto abierto");
  });

  it("la agenda móvil lista por día de llegada con unidad, estado y noches", async () => {
    rendered = await abrir();
    const agenda = rendered.container.querySelector('ol[aria-label="Agenda de octubre de 2026"]')!;
    expect(agenda.textContent).toContain("sábado 10 de octubre de 2026");
    expect(agenda.textContent).toContain("Depa 101 · Reserva confirmada, canal Directa, huésped Ana Pérez");
    expect(agenda.textContent).toContain("10 oct → 12 oct · 2 noches");
    expect(agenda.textContent).not.toContain("jueves 15 de octubre"); // un día sin actividad no aparece
  });

  it("'Gestionar en la lista de esta unidad' lleva a la pestaña Lista con esa unidad ya elegida", async () => {
    rendered = await abrir();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/unidades")) return res({ unidades: UNIDADES });
      if (url.endsWith("/unidades/u2/ocupaciones")) return res({ ocupaciones: [] });
      if (url.includes("/calendario?")) return res({ zona_horaria: "America/Cancun", hoy: "2026-10-15", total: 3, truncado: false, ocupaciones: OCUPACIONES });
      if (url.includes("/tareas?")) return res({ tareas: [TAREA] });
      return res({ zona_horaria: "America/Cancun", conflictos: [], total_abiertos: 0 });
    });
    click(celda(rendered, "2026-10-12"));
    await esperar();
    click(botonPorTexto(rendered, "Gestionar en la lista de esta unidad"));
    await esperar();
    expect(botonPorTexto(rendered, "Lista").getAttribute("aria-pressed")).toBe("true");
    expect(urlsDe("/unidades/u1/ocupaciones").length + urlsDe("/unidades/u2/ocupaciones").length).toBe(1);
    expect(rendered.container.textContent).toContain("+ Nueva reserva");
  });
});
