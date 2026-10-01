// @vitest-environment jsdom
//
// H-27 -- <HuespedFichaPage /> y <HuespedesPage />: `fetch` global mockeado por ruta real contra apps/api/.../hoteles/huespedes.ts
// y el catalogo de reservas.ts. Cubre ficha completa, notas (crear/archivar/minimizacion), restriccion ARCO, base sin migrar,
// gating por rol y la busqueda del catalogo.
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { HuespedFichaPage } from "../src/verticals/hoteles/pages/HuespedFicha.tsx";
import { HuespedesPage } from "../src/verticals/hoteles/pages/Huespedes.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "frontdesk", staffFullName: "Ana", staffEmail: "ana@example.com" };

function ficha(over: Record<string, unknown> = {}) {
  return {
    huesped: { id: "g1", nombreCompleto: "Ana Torres", email: "ana@example.com", telefono: "5511112222" },
    resumen: { estancias: 2, noches: 6, ultimaEstancia: "2026-12-01", proximaLlegada: "2027-01-10" },
    estancias: [
      { reservaId: "r1", estado: "check_out", entrada: "2026-10-01", salida: "2026-10-04", tipoHabitacion: "Doble", habitacion: "101", montoNetoCentavos: 450050 },
      { reservaId: "r2", estado: "cancelada", entrada: "2026-11-01", salida: "2026-11-03", tipoHabitacion: "Suite", habitacion: null, montoNetoCentavos: 300000 },
    ],
    notas: { disponible: true, items: [{ id: "n1", tipo: "preferencia", texto: "Piso alto", creadaPor: "u1", creadaEn: "2026-11-30T10:00:00Z" }] },
    contactos: [{ id: "c1", motivo: "Pregunta por late check-out", canal: "whatsapp", mensaje: "¿Puedo salir a las 3?", creadoEn: "2026-11-30T10:00:00Z" }],
    consentimientos: [{ id: "k1", aviso: "v2", finalidadesOpcionales: ["marketing"], canal: "mostrador", fecha: "2026-10-01T10:00:00Z", revocado: false }],
    identidad: { registrada: true },
    arco: { restriccion: false },
    ...over,
  };
}

function stubFetch(over: { ficha?: Record<string, unknown>; notaFalla?: { status: number; code: string; message: string }; huespedes?: unknown[] } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b }) as unknown as Response;
    if (method === "GET" && url === "https://api.test/hoteles/prop-1/huespedes/g1/ficha") return json(ficha(over.ficha));
    if (method === "GET" && url.startsWith("https://api.test/hoteles/prop-1/huespedes")) return json(over.huespedes ?? [{ id: "g1", nombreCompleto: "Ana Torres", email: "ana@example.com", telefono: "5511112222" }]);
    if (method === "POST" && url.endsWith("/g1/notas")) {
      if (over.notaFalla) return json({ code: over.notaFalla.code, message: over.notaFalla.message }, over.notaFalla.status);
      return json({ id: "n2", tipo: "nota", texto: "x", creadaPor: "u1", creadaEn: "2026-12-02T10:00:00Z" }, 201);
    }
    if (method === "POST" && url.endsWith("/archivar")) return json({ id: "n1", tipo: "preferencia", texto: "Piso alto", creadaPor: "u1", creadaEn: "2026-11-30T10:00:00Z" });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
const montarFicha = (ctx: HotelesShellContext = CTX) => {
  rendered = renderComponent(
    <MemoryRouter initialEntries={["/hoteles/demo/huespedes/g1"]}>
      <Routes>
        <Route path="/hoteles/:orgSlug/huespedes/:guestId" element={<HuespedFichaPage {...ctx} />} />
      </Routes>
    </MemoryRouter>,
  );
};
const texto = () => rendered!.container.textContent ?? "";
const boton = (t: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === t || b.getAttribute("aria-label") === t)!;

describe("HuespedFichaPage (hoteles)", () => {
  it("muestra perfil, resumen, historial con monto neto, contactos, consentimientos e identidad (solo bandera)", async () => {
    stubFetch();
    montarFicha();
    expect(texto()).toContain("Cargando ficha");
    await esperar();
    const t = texto();
    expect(t).toContain("Ana Torres");
    expect(t).toContain("5511112222");
    expect(t).toContain("2 estancia(s) · 6 noche(s)");
    expect(t).toContain("$4,500.50 neto");
    expect(t).toContain("Cancelada");
    expect(t).toContain("Pregunta por late check-out");
    expect(t).toContain("Aviso v2");
    expect(t).toContain("Finalidades opcionales: marketing");
    expect(t).toContain("Identidad registrada");
    expect(t).toContain("Piso alto");
  });

  it("agrega una nota y recarga la ficha", async () => {
    stubFetch();
    montarFicha();
    await esperar();
    changeValue(rendered!.container.querySelector("textarea") as HTMLTextAreaElement, "Llega tarde por vuelo");
    await act(async () => {
      click(boton("Guardar"));
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    await esperar();
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST" && String(c[0]).endsWith("/g1/notas"));
    expect(JSON.parse(post![1].body as string)).toEqual({ tipo: "nota", texto: "Llega tarde por vuelo" });
    expect(fetchMock.mock.calls.filter((c) => c[0] === "https://api.test/hoteles/prop-1/huespedes/g1/ficha").length).toBeGreaterThan(1);
  });

  it("minimizacion: una nota con numero de tarjeta no se envia y se explica", async () => {
    stubFetch();
    montarFicha();
    await esperar();
    changeValue(rendered!.container.querySelector("textarea") as HTMLTextAreaElement, "Tarjeta 4111 1111 1111 1111");
    await act(async () => {
      click(boton("Guardar"));
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(texto()).toContain("No captures números de tarjeta ni de documento");
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
  });

  it("archivar una nota llama a su ruta", async () => {
    stubFetch();
    montarFicha();
    await esperar();
    await act(async () => {
      click(boton("Archivar nota"));
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST" && String(c[0]).endsWith("/notas/n1/archivar"))).toBe(true);
  });

  it("con ARCO de cancelacion/oposicion en curso avisa y no ofrece agregar notas", async () => {
    stubFetch({ ficha: { arco: { restriccion: true } } });
    montarFicha();
    await esperar();
    expect(texto()).toContain("ARCO en curso: sin notas nuevas");
    expect(rendered!.container.querySelector("textarea")).toBeNull();
  });

  it("muestra el error real del servidor al guardar (409 ARCO por carrera)", async () => {
    stubFetch({ notaFalla: { status: 409, code: "arco_en_curso", message: "El huesped tiene una solicitud ARCO de cancelacion u oposicion." } });
    montarFicha();
    await esperar();
    changeValue(rendered!.container.querySelector("textarea") as HTMLTextAreaElement, "algo");
    await act(async () => {
      click(boton("Guardar"));
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(texto()).toContain("solicitud ARCO");
  });

  it("base sin migrar: dice 'no disponible aun' en notas, consentimientos e identidad en vez de 'sin datos'", async () => {
    stubFetch({ ficha: { notas: { disponible: false, items: [] }, consentimientos: null, identidad: null, arco: null } });
    montarFicha();
    await esperar();
    const t = texto();
    expect(t).toContain("notas y preferencias aún no están activas");
    expect(t).toContain("consentimientos aún no están activos");
    expect(t).toContain("Identidad: no disponible aún");
    expect(rendered!.container.querySelector("textarea")).toBeNull();
  });

  it("housekeeping no tiene acceso y no consulta nada", async () => {
    stubFetch();
    montarFicha({ ...CTX, role: "housekeeping" });
    await esperar();
    expect(texto()).toContain("no tiene acceso");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("HuespedesPage (hoteles)", () => {
  it("lista el catalogo, busca con retraso y enlaza a la ficha", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubFetch();
    rendered = renderComponent(
      <MemoryRouter>
        <HuespedesPage {...CTX} />
      </MemoryRouter>,
    );
    await act(async () => {
      vi.advanceTimersByTime(300);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(texto()).toContain("Ana Torres");
    expect(rendered.container.querySelector('a[href="/hoteles/demo/huespedes/g1"]')).not.toBeNull();
    changeValue(rendered.container.querySelector("input") as HTMLInputElement, "Ana");
    await act(async () => {
      vi.advanceTimersByTime(300);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/huespedes?q=Ana"))).toBe(true);
  });

  it("sin resultados muestra el vacio honesto", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubFetch({ huespedes: [] });
    rendered = renderComponent(
      <MemoryRouter>
        <HuespedesPage {...CTX} />
      </MemoryRouter>,
    );
    await act(async () => {
      vi.advanceTimersByTime(300);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(texto()).toContain("aún no tiene huéspedes registrados");
  });
});
