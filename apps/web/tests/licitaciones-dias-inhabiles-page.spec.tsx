// @vitest-environment jsdom
//
// L-22 -- pantalla del calendario de dias inhabiles. `fetch` global mockeado por ruta real: se verifica lo
// que se ve (oficiales verificados, sugeridos "validar con fiscalista/abogado" que NO cuentan hasta
// declararlos, honestidad con la base sin migrar), que cada accion dispare metodo/ruta/cuerpo reales y que el
// rol oculte lo que el servidor rechazaria.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiasInhabilesPage } from "../src/verticals/licitaciones/pages/DiasInhabiles.tsx";
import { textoDiasHabiles } from "../src/verticals/licitaciones/lib/dias-inhabiles-client.ts";
import type { PlazoDescripcion } from "../src/verticals/licitaciones/lib/dias-inhabiles-client.ts";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: LicitacionesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "analyst", staffFullName: "Ana", staffEmail: "ana@example.com" };

type Handler = (init?: RequestInit) => { ok?: boolean; status?: number; body: unknown };

function stubFetch(routes: Record<string, Handler>) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace("https://api.test/licitaciones/prop-1", "")}`;
    const handler = routes[key];
    if (!handler) return { ok: false, status: 500, json: async () => ({ error: { message: `sin ruta ${key}` } }) } as unknown as Response;
    const r = handler(init);
    return { ok: r.ok ?? true, status: r.status ?? (r.ok === false ? 500 : 200), headers: new Headers(), json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

const text = () => rendered!.container.textContent ?? "";
const buttonsByText = (t: string) => [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.trim() === t);
const field = (label: string) => rendered!.container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement;
const calls = (method: string, path: string) => fetchMock.mock.calls.filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url).replace("https://api.test/licitaciones/prop-1", "")}` === `${method} ${path}`);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

const OFICIALES = [
  { fecha: "2026-01-01", nombre: "Año Nuevo", alcance: "oficial", fuente: "Ley Federal del Trabajo, art. 74 (descanso obligatorio)", verificacion: "verificada" },
  { fecha: "2026-02-02", nombre: "Día de la Constitución (primer lunes de febrero)", alcance: "oficial", fuente: null, verificacion: "verificada" },
  { fecha: "2027-01-01", nombre: "Año Nuevo", alcance: "oficial", fuente: null, verificacion: "verificada" },
];
const SUGERIDOS = [
  { fecha: "2026-04-02", nombre: "Jueves Santo", motivo: "Validar con fiscalista/abogado: se considera inhabil segun el acuerdo que publique cada dependencia o entidad." },
  { fecha: "2026-04-03", nombre: "Viernes Santo", motivo: "Validar con fiscalista/abogado: se considera inhabil segun el acuerdo que publique cada dependencia o entidad." },
];
const DECLARADO = { id: "d1", fecha: "2026-04-03", nombre: "Viernes Santo", alcance: "organizacion", tenderId: null, publicadoPor: "SHCP", fuente: "DOF 2026-01-10", verificacion: "por_validar", createdAt: "2026-10-01T00:00:00Z" };
const RESUMEN = (over: Record<string, unknown> = {}) => ({
  available: true,
  timeZone: "America/Mexico_City",
  coberturaOficial: [2026, 2027],
  oficiales: OFICIALES,
  sugeridos: SUGERIDOS,
  declarados: [],
  efectivos: ["2026-01-01"],
  nota: "Validar con fiscalista/abogado: los dias inhabiles oficiales cargados aqui cubren solo 2026-2027.",
  puedeEditar: true,
  ...over,
});
const TENDERS = [{ id: "t1", organizationId: "o", title: "Suministro de papeleria", submissionDeadline: null, updatedAt: "2026-10-01T00:00:00Z", source: null, externalId: null, contractingBody: null, cpvCodes: [], budgetAmount: null, currency: null, state: null }];

describe("pantalla de dias inhabiles de licitaciones", () => {
  it("muestra oficiales por anio como verificados y los sugeridos como 'validar con fiscalista/abogado'", async () => {
    stubFetch({ "GET /dias-inhabiles": () => ({ body: RESUMEN() }), "GET /tenders?limit=200&open=true": () => ({ body: { tenders: TENDERS } }) });
    rendered = renderComponent(<DiasInhabilesPage {...CTX} />);
    await settle();
    expect(text()).toContain("Días inhábiles");
    expect(text()).toContain("Oficiales de plataforma");
    expect(text()).toContain("Año Nuevo");
    expect(text()).toContain("2027");
    expect(text()).toContain("Cubre 2026 y 2027");
    expect(text()).toContain("Jueves Santo");
    expect(text()).toContain("No cuentan en ningún plazo hasta que tu organización los declare");
    expect(text().match(/Validar con fiscalista\/abogado/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("base sin migrar: lo dice, los oficiales siguen y no ofrece declarar ni quitar", async () => {
    stubFetch({ "GET /dias-inhabiles": () => ({ body: RESUMEN({ available: false }) }), "GET /tenders?limit=200&open=true": () => ({ body: { tenders: TENDERS } }) });
    rendered = renderComponent(<DiasInhabilesPage {...CTX} />);
    await settle();
    expect(text()).toContain("aún no disponibles");
    expect(text()).toContain("migración 032");
    expect(text()).toContain("Año Nuevo");
    expect(field("Fecha del día inhábil")).toBeNull();
    expect(buttonsByText("Declarar para mi organización")).toHaveLength(0);
  });

  it("declarar un sugerido: POST real con fecha y nombre; recarga y avisa", async () => {
    let declarados: unknown[] = [];
    stubFetch({
      "GET /dias-inhabiles": () => ({ body: RESUMEN({ declarados }) }),
      "GET /tenders?limit=200&open=true": () => ({ body: { tenders: TENDERS } }),
      "POST /dias-inhabiles": () => {
        declarados = [DECLARADO];
        return { status: 201, body: DECLARADO };
      },
    });
    rendered = renderComponent(<DiasInhabilesPage {...CTX} />);
    await settle();
    const [viernes] = buttonsByText("Declarar para mi organización").slice(1);
    await act(async () => {
      click(viernes!);
    });
    await settle();
    const [post] = calls("POST", "/dias-inhabiles");
    expect(bodyOf(post!)).toMatchObject({ fecha: "2026-04-03", nombre: "Viernes Santo" });
    expect(text()).toContain("declarado para tu organización");
    expect(text()).toContain("Declarado por tu organización");
    expect(text()).toContain("Por validar");
  });

  it("formulario: declara un dia de UNA convocatoria con publicador y fuente", async () => {
    stubFetch({
      "GET /dias-inhabiles": () => ({ body: RESUMEN() }),
      "GET /tenders?limit=200&open=true": () => ({ body: { tenders: TENDERS } }),
      "POST /dias-inhabiles": () => ({ status: 201, body: { ...DECLARADO, tenderId: "t1", alcance: "convocatoria" } }),
    });
    rendered = renderComponent(<DiasInhabilesPage {...CTX} />);
    await settle();
    await act(async () => {
      changeValue(field("Fecha del día inhábil"), "2026-05-04");
      changeValue(field("Nombre del día inhábil"), "  Día de la convocante ");
      changeValue(field("Dependencia o entidad que lo publica"), "IMSS");
      changeValue(field("Fuente del día inhábil"), "Bases, punto 4.2");
      changeValue(field("Alcance del día inhábil"), "t1");
    });
    await act(async () => {
      await submitForm(field("Fecha del día inhábil").closest("form")!);
    });
    await settle();
    expect(bodyOf(calls("POST", "/dias-inhabiles")[0]!)).toEqual({ fecha: "2026-05-04", nombre: "Día de la convocante", tenderId: "t1", publicadoPor: "IMSS", fuente: "Bases, punto 4.2" });
  });

  it("un error del servidor (409 duplicado) se muestra tal cual", async () => {
    stubFetch({
      "GET /dias-inhabiles": () => ({ body: RESUMEN() }),
      "GET /tenders?limit=200&open=true": () => ({ body: { tenders: [] } }),
      "POST /dias-inhabiles": () => ({ ok: false, status: 409, body: { message: "Ya hay un día inhábil vigente para esa fecha en ese alcance." } }),
    });
    rendered = renderComponent(<DiasInhabilesPage {...CTX} />);
    await settle();
    await act(async () => {
      changeValue(field("Fecha del día inhábil"), "2026-05-04");
      changeValue(field("Nombre del día inhábil"), "Dia repetido");
    });
    await act(async () => {
      await submitForm(field("Fecha del día inhábil").closest("form")!);
    });
    await settle();
    expect(text()).toContain("Ya hay un día inhábil vigente");
    expect(field("Alcance del día inhábil")).toBeNull(); // sin convocatorias no hay selector
  });

  it("quitar un dia pide confirmacion y manda DELETE al id real", async () => {
    stubFetch({
      "GET /dias-inhabiles": () => ({ body: RESUMEN({ declarados: [DECLARADO] }) }),
      "GET /tenders?limit=200&open=true": () => ({ body: { tenders: TENDERS } }),
      "DELETE /dias-inhabiles/d1": () => ({ body: { ok: true } }),
    });
    rendered = renderComponent(<DiasInhabilesPage {...CTX} />);
    await settle();
    await act(async () => {
      click(buttonsByText("Quitar")[0]!);
    });
    await settle();
    expect(calls("DELETE", "/dias-inhabiles/d1")).toHaveLength(0); // nada sin confirmar
    expect(document.body.textContent).toContain("Queda registro de quién lo declaró");
    await act(async () => {
      click(buttonsByText("Quitar").at(-1)!);
    });
    await settle();
    expect(calls("DELETE", "/dias-inhabiles/d1")).toHaveLength(1);
  });

  it("rol de solo lectura: ve el calendario pero no declara ni quita", async () => {
    stubFetch({ "GET /dias-inhabiles": () => ({ body: RESUMEN({ puedeEditar: false, declarados: [DECLARADO] }) }), "GET /tenders?limit=200&open=true": () => ({ body: { tenders: TENDERS } }) });
    rendered = renderComponent(<DiasInhabilesPage {...CTX} role="viewer" />);
    await settle();
    expect(text()).toContain("Viernes Santo");
    expect(buttonsByText("Quitar")).toHaveLength(0);
    expect(buttonsByText("Declarar para mi organización")).toHaveLength(0);
    expect(field("Fecha del día inhábil")).toBeNull();
    expect(text()).toContain("solo owner, admin y analista");
  });

  it("falla la carga: muestra el error en vez de una pantalla vacia", async () => {
    stubFetch({ "GET /dias-inhabiles": () => ({ ok: false, status: 500, body: { message: "boom" } }), "GET /tenders?limit=200&open=true": () => ({ body: { tenders: [] } }) });
    rendered = renderComponent(<DiasInhabilesPage {...CTX} />);
    await settle();
    expect(text()).toContain("boom");
  });
});

describe("textoDiasHabiles", () => {
  const p = (over: Partial<PlazoDescripcion>): PlazoDescripcion => ({ fechaLimite: "2026-03-20", hoy: "2026-03-18", diasHabilesRestantes: 2, caeEnInhabil: false, motivoInhabil: null, siguienteDiaHabil: null, avisos: [], nota: "", ...over });
  it("describe dias habiles, hoy, cero en inhabil y vencido", () => {
    expect(textoDiasHabiles(p({}))).toBe("2 días hábiles");
    expect(textoDiasHabiles(p({ diasHabilesRestantes: 1 }))).toBe("1 día hábil");
    expect(textoDiasHabiles(p({ fechaLimite: "2026-03-18", diasHabilesRestantes: 0 }))).toBe("vence hoy");
    expect(textoDiasHabiles(p({ diasHabilesRestantes: 0, caeEnInhabil: true }))).toContain("cae en día inhábil");
    expect(textoDiasHabiles(p({ diasHabilesRestantes: -3 }))).toBe("vencido hace 3 días hábiles");
  });
});
