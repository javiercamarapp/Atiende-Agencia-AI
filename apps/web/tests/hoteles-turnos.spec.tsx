// @vitest-environment jsdom
//
// H-35 -- turnos de camaristas (GET|POST /hoteles/:propertyId/housekeeping/turnos, sin UI hasta ahora): cliente + panel.
// `fetch` global mockeado por ruta real contra apps/api/.../hoteles/housekeeping.ts. La LFT la valida SIEMPRE el servidor: el 422
// trae las violaciones con su cita legal y no se guarda nada; el panel las muestra tal cual.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicarTurnos, turnosDelRango, validarPlantilla } from "../src/verticals/hoteles/lib/turnos-client.ts";
import { TurnosPanel } from "../src/verticals/hoteles/pages/TurnosPanel.tsx";
import { changeValue, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const CAMARISTAS = [{ id: "u1", nombre: "Ana" }];
const VIOLACION = { type: "jornada_diaria_excedida", staffId: "u1", article: "LFT art. 61 y 66", message: "El 2026-12-03 programa 12 h: excede el tope de 11 h.", scope: { workDate: "2026-12-03" } };

describe("turnos-client", () => {
  it("turnosDelRango arma un turno por cada fecha del rango en los dias elegidos (domingo = 0)", () => {
    // 2026-11-30 es lunes.
    const t = turnosDelRango("2026-11-30", "2026-12-06", new Set([1, 3, 0]), "08:00", "16:00");
    expect(t.map((x) => x.workDate)).toEqual(["2026-11-30", "2026-12-02", "2026-12-06"]);
    expect(t[0]).toEqual({ workDate: "2026-11-30", startTime: "08:00", endTime: "16:00" });
  });

  it("validarPlantilla exige camarista, rango, horas y dias", () => {
    const d = new Set([1]);
    expect(validarPlantilla("", "2026-11-30", "2026-12-06", "08:00", "16:00", d)).toMatch(/camarista/);
    expect(validarPlantilla("u1", "2026-12-06", "2026-11-30", "08:00", "16:00", d)).toMatch(/rango/);
    expect(validarPlantilla("u1", "2026-11-30", "2026-12-06", "", "16:00", d)).toMatch(/hora/);
    expect(validarPlantilla("u1", "2026-11-30", "2026-12-06", "08:00", "16:00", new Set())).toMatch(/día/);
    expect(validarPlantilla("u1", "2026-12-01", "2026-12-01", "08:00", "16:00", new Set([0]))).toMatch(/Ningún día/);
    expect(validarPlantilla("u1", "2026-11-30", "2026-12-06", "08:00", "16:00", d)).toBeNull();
  });

  it("publicarTurnos devuelve las violaciones del 422 sin lanzar, y los turnos en el 201", async () => {
    const rechazo = vi.fn(async () => new Response(JSON.stringify({ ok: false, publicado: false, violaciones: [VIOLACION] }), { status: 422 })) as unknown as typeof fetch;
    expect(await publicarTurnos(rechazo, "http://api.local", "tok", "prop-1", { staffId: "u1", fromDate: "2026-12-03", toDate: "2026-12-03", shifts: [] })).toEqual({ publicado: false, violaciones: [VIOLACION] });
    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true, publicado: true, violaciones: [], turnos: [{ id: "t1", staffId: "u1", fecha: "2026-12-03", inicio: "08:00", fin: "16:00" }] }), { status: 201 })) as unknown as typeof fetch;
    expect(await publicarTurnos(ok, "http://api.local", "tok", "prop-1", { staffId: "u1", fromDate: "2026-12-03", toDate: "2026-12-03", shifts: [] })).toMatchObject({ publicado: true });
    const roto = vi.fn(async () => new Response(JSON.stringify({ code: "forbidden", message: "No tienes permiso para realizar esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(publicarTurnos(roto, "http://api.local", "tok", "prop-1", { staffId: "u1", fromDate: "2026-12-03", toDate: "2026-12-03", shifts: [] })).rejects.toThrow(/permiso/);
  });
});

function stubFetch(over: { publicar?: Response; consulta?: unknown } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/housekeeping/turnos?")) {
      return json(over.consulta ?? { turnos: [{ id: "t1", staffId: "u1", fecha: "2026-12-02", inicio: "08:00", fin: "16:00" }], cumplimiento: { valido: true, violaciones: [] } });
    }
    if (method === "POST" && url.endsWith("/housekeeping/turnos")) return over.publicar ?? json({ ok: true, publicado: true, violaciones: [], turnos: [{ id: "t2" }, { id: "t3" }] }, 201);
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
const montar = (role = "frontdesk") => {
  rendered = renderComponent(<TurnosPanel apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" role={role} hoy="2026-12-02" camaristas={CAMARISTAS} />);
};
const texto = () => rendered!.container.textContent ?? "";
function llenar() {
  const c = rendered!.container;
  changeValue(c.querySelector("#turno-camarista") as HTMLSelectElement, "u1");
  changeValue(c.querySelector("#turno-inicio") as HTMLInputElement, "08:00");
  changeValue(c.querySelector("#turno-fin") as HTMLInputElement, "16:00");
}

describe("TurnosPanel", () => {
  it("consulta la semana (lunes a domingo) que contiene hoy y muestra turnos y cumplimiento", async () => {
    stubFetch();
    montar();
    await esperar();
    const url = String(fetchMock.mock.calls.find((c) => String(c[0]).includes("/turnos?"))![0]);
    expect(url).toContain("desde=2026-11-30");
    expect(url).toContain("hasta=2026-12-06");
    expect(texto()).toContain("Cumple la LFT");
    expect(texto()).toContain("08:00 – 16:00");
    expect(texto()).toContain("Ana");
  });

  it("publica la plantilla de lunes a viernes y recarga", async () => {
    stubFetch();
    montar();
    await esperar();
    llenar();
    await submitForm([...rendered!.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Publicar plantilla"))!);
    await esperar();
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST")!;
    const body = JSON.parse(post[1].body as string);
    expect(body).toMatchObject({ staffId: "u1", fromDate: "2026-11-30", toDate: "2026-12-06" });
    expect(body.shifts.map((s: { workDate: string }) => s.workDate)).toEqual(["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"]);
    expect(texto()).toContain("Plantilla publicada: 2 turno(s) para Ana.");
  });

  it("un 422 de la LFT muestra la cita legal y el mensaje del servidor, y no dice que se publico", async () => {
    stubFetch({ publicar: json({ ok: false, publicado: false, violaciones: [VIOLACION] }, 422) });
    montar();
    await esperar();
    llenar();
    await submitForm([...rendered!.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Publicar plantilla"))!);
    await esperar();
    expect(texto()).toContain("No se publicó: la plantilla incumple la LFT.");
    expect(texto()).toContain("LFT art. 61 y 66");
    expect(texto()).toContain("excede el tope de 11 h");
    expect(texto()).not.toContain("Plantilla publicada");
  });

  it("sin datos completos no llama al servidor", async () => {
    stubFetch();
    montar();
    await esperar();
    await submitForm([...rendered!.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Publicar plantilla"))!);
    expect(texto()).toContain("Elige a la camarista.");
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
  });

  it("muestra incumplimientos ya publicados (defensa en profundidad) y housekeeping solo consulta", async () => {
    stubFetch({ consulta: { turnos: [], cumplimiento: { valido: false, violaciones: [VIOLACION] } } });
    montar("housekeeping");
    await esperar();
    expect(texto()).toContain("Incumple la LFT");
    expect(texto()).toContain("No hay turnos publicados en este rango.");
    expect(texto()).not.toContain("Publicar plantilla");
  });
});
