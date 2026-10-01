// @vitest-environment jsdom
//
// L-08 -- pantalla del KYC negativo 69-B. `fetch` global mockeado por ruta real: se verifica lo que se
// ve (semaforo y fecha de publicacion por situacion, alerta de proveedor propio, honestidad con la base
// sin migrar / sin lista), que cada accion dispare metodo/ruta/cuerpo reales y que el rol oculte lo que el
// servidor rechazaria.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Kyc69bPage } from "../src/verticals/licitaciones/pages/Kyc69b.tsx";
import { parseRfcsDelTexto } from "../src/verticals/licitaciones/lib/kyc-69b-client.ts";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: LicitacionesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "analyst", staffFullName: "Ana", staffEmail: "ana@example.com" };
const ROLE = (role: string): LicitacionesShellContext => ({ ...CTX, role });

type Handler = (init?: RequestInit) => { ok?: boolean; status?: number; body: unknown };

function stubFetch(routes: Record<string, Handler>) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace("https://api.test/licitaciones/prop-1/kyc-69b", "")}`;
    const handler = routes[key];
    if (!handler) return { ok: false, status: 500, json: async () => ({ error: { message: `sin ruta ${key}` } }) } as unknown as Response;
    const r = handler(init);
    return { ok: r.ok ?? true, status: r.status ?? (r.ok === false ? 500 : 200), json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

const text = () => rendered!.container.textContent ?? "";
const buttonByText = (t: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === t);
const field = (label: string) => rendered!.container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const calls = (method: string, path: string) => fetchMock.mock.calls.filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url).replace("https://api.test/licitaciones/prop-1/kyc-69b", "")}` === `${method} ${path}`);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

const INFO = {
  rojo: { semaforo: "rojo", etiqueta: "Definitivo", detalle: "Figura como definitivo en la lista del art. 69-B del CFF.", accionable: true },
  ambar: { semaforo: "ambar", etiqueta: "Presunto", detalle: "Figura como presunto en la lista del art. 69-B del CFF.", accionable: true },
  verde: { semaforo: "verde", etiqueta: "No aparece", detalle: "No figura en la edicion vigente. No es una constancia oficial.", accionable: false },
};
const FICHA = (over: Record<string, unknown>) => ({ id: "f1", rfc: "PRE850101AB1", rol: "proveedor", nombre: "Proveedor uno", creadaEn: "2026-10-01T00:00:00Z", periodo: "2024-06", encontrado: true, situacion: "presunto", fechaPublicacion: "2024-05-12", ...INFO.ambar, ...over });
const RESUMEN = (over: Record<string, unknown> = {}) => {
  const fichas = (over.fichas as unknown[]) ?? [];
  return { available: true, lista: { periodo: "2024-06", filas: 5, ingestadoEn: "2024-06-30" }, listaDisponible: true, periodo: "2024-06", fichas, alertas: [], ...over };
};

describe("pantalla del KYC 69-B de licitaciones", () => {
  it("base sin migrar: lo dice y no ofrece consulta ni cartera", async () => {
    stubFetch({ "GET ": () => ({ body: { available: false, lista: null, listaDisponible: false, periodo: null, fichas: [], alertas: [] } }) });
    rendered = renderComponent(<Kyc69bPage {...CTX} />);
    await settle();
    expect(text()).toContain("Aún no disponible");
    expect(field("RFC a consultar")).toBeNull();
    expect(text()).not.toContain("Mi cartera");
  });

  it("lista sin cargar: avisa que no se puede afirmar nada", async () => {
    stubFetch({ "GET ": () => ({ body: RESUMEN({ lista: null, listaDisponible: false, periodo: null }) }), "GET /consultas": () => ({ body: { available: true, consultas: [] } }) });
    rendered = renderComponent(<Kyc69bPage {...CTX} />);
    await settle();
    expect(text()).toContain("no se puede afirmar nada de ningún RFC");
  });

  it("consulta un lote: manda los RFC normalizados en el CUERPO (no en la URL) y muestra semaforo y fecha del SAT", async () => {
    stubFetch({
      "GET ": () => ({ body: RESUMEN() }),
      "GET /consultas": () => ({ body: { available: true, consultas: [] } }),
      "POST /consultar": () => ({
        body: {
          listaDisponible: true,
          periodo: "2024-06",
          filas: [
            { rfc: "PRE850101AB1", encontrado: true, periodo: "2024-06", nombre: "PRESUNTA SA", situacion: "presunto", oficioPresuncion: null, fechaPublicacion: "2024-05-12", ...INFO.ambar },
            { rfc: "DEF900202CD2", encontrado: true, periodo: "2024-06", nombre: null, situacion: "definitivo", oficioPresuncion: null, fechaPublicacion: "2024-06-03", ...INFO.rojo },
            { rfc: "LIM750505IJ5", encontrado: false, periodo: "2024-06", nombre: null, situacion: null, oficioPresuncion: null, fechaPublicacion: null, ...INFO.verde },
          ],
        },
      }),
    });
    rendered = renderComponent(<Kyc69bPage {...CTX} />);
    await settle();
    await act(async () => {
      changeValue(field("RFC a consultar") as HTMLTextAreaElement, " pre850101ab1, DEF900202CD2\nlim750505ij5 PRE850101AB1");
    });
    await act(async () => {
      await submitForm(field("RFC a consultar").closest("form")!);
    });
    await settle();
    const [post] = calls("POST", "/consultar");
    expect(bodyOf(post!)).toEqual({ rfcs: ["PRE850101AB1", "DEF900202CD2", "LIM750505IJ5"] });
    expect(String(post![0])).not.toContain("PRE850101AB1");
    const resultado = rendered!.container.querySelector('[aria-label="Resultado de la consulta"]')!.textContent!;
    expect(resultado).toContain("Presunto");
    expect(resultado).toContain("Definitivo");
    expect(resultado).toContain("No aparece");
    expect(resultado).toMatch(/12 may 2024/);
    expect(resultado).toMatch(/3 jun 2024/);
    expect(resultado).toContain("No es una constancia oficial");
  });

  it("mas de 50 RFC pegados: no llama al servidor y lo explica", async () => {
    stubFetch({ "GET ": () => ({ body: RESUMEN() }), "GET /consultas": () => ({ body: { available: true, consultas: [] } }) });
    rendered = renderComponent(<Kyc69bPage {...CTX} />);
    await settle();
    const muchos = Array.from({ length: 51 }, (_, i) => `ZZZ010101${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}1`).join(" ");
    await act(async () => {
      changeValue(field("RFC a consultar") as HTMLTextAreaElement, muchos);
    });
    await act(async () => {
      await submitForm(field("RFC a consultar").closest("form")!);
    });
    await settle();
    expect(calls("POST", "/consultar")).toHaveLength(0);
    expect(text()).toContain("Máximo 50 RFC");
  });

  it("un 400 del servidor (RFC invalido) se muestra tal cual", async () => {
    stubFetch({
      "GET ": () => ({ body: RESUMEN() }),
      "GET /consultas": () => ({ body: { available: true, consultas: [] } }),
      "POST /consultar": () => ({ ok: false, status: 400, body: { message: 'RFC "XX": debe tener 12 caracteres (persona moral) o 13 (persona fisica).' } }),
    });
    rendered = renderComponent(<Kyc69bPage {...CTX} />);
    await settle();
    await act(async () => {
      changeValue(field("RFC a consultar") as HTMLTextAreaElement, "xx");
    });
    await act(async () => {
      await submitForm(field("RFC a consultar").closest("form")!);
    });
    await settle();
    expect(text()).toContain("debe tener 12 caracteres");
  });

  it("alerta de proveedor propio con la fecha de publicacion, y semaforo en la ficha", async () => {
    const prov = FICHA({});
    const comp = FICHA({ id: "f2", rfc: "DEF900202CD2", rol: "competidor", nombre: "Rival", situacion: "definitivo", fechaPublicacion: "2024-06-03", ...INFO.rojo });
    stubFetch({ "GET ": () => ({ body: RESUMEN({ fichas: [prov, comp], alertas: [prov] }) }), "GET /consultas": () => ({ body: { available: true, consultas: [] } }) });
    rendered = renderComponent(<Kyc69bPage {...CTX} />);
    await settle();
    expect(text()).toContain("Alerta: un proveedor tuyo figura en la lista 69-B");
    expect(text()).toContain("publicado por el SAT el 12 may 2024");
    expect(text()).toContain("Proveedores");
    expect(text()).toContain("Competidores");
    expect(text()).toContain("Rival");
  });

  it("agrega una ficha: POST con RFC en mayusculas, rol y nombre; recarga la cartera", async () => {
    let fichas: unknown[] = [];
    stubFetch({
      "GET ": () => ({ body: RESUMEN({ fichas }) }),
      "GET /consultas": () => ({ body: { available: true, consultas: [] } }),
      "POST /fichas": () => {
        fichas = [FICHA({})];
        return { status: 201, body: { id: "f1" } };
      },
    });
    rendered = renderComponent(<Kyc69bPage {...CTX} />);
    await settle();
    await act(async () => {
      changeValue(field("RFC de la ficha") as HTMLInputElement, "pre850101ab1");
      changeValue(field("Nombre de la ficha") as HTMLInputElement, "Proveedor uno");
    });
    await act(async () => {
      await submitForm(field("RFC de la ficha").closest("form")!);
    });
    await settle();
    expect(bodyOf(calls("POST", "/fichas")[0]!)).toEqual({ rfc: "PRE850101AB1", rol: "proveedor", nombre: "Proveedor uno" });
    expect(text()).toContain("PRE850101AB1");
  });

  it("viewer: ve la cartera pero no puede consultar, agregar ni quitar; no ve la bitacora", async () => {
    const prov = FICHA({});
    stubFetch({ "GET ": () => ({ body: RESUMEN({ fichas: [prov], alertas: [prov] }) }) });
    rendered = renderComponent(<Kyc69bPage {...ROLE("viewer")} />);
    await settle();
    expect(field("RFC a consultar")).toBeNull();
    expect(field("RFC de la ficha")).toBeNull();
    expect(buttonByText("Quitar")).toBeUndefined();
    expect(text()).toContain("no hacer consultas nuevas");
    expect(calls("GET", "/consultas")).toHaveLength(0);
  });

  it("la bitacora de consultas se muestra solo a roles de decision", async () => {
    stubFetch({
      "GET ": () => ({ body: RESUMEN() }),
      "GET /consultas": () => ({ body: { available: true, consultas: [{ id: "c1", rfc: "LIM750505IJ5", encontrado: false, situacion: null, periodo: "2024-06", consultadoEn: "2026-10-01T15:00:00Z" }] } }),
    });
    rendered = renderComponent(<Kyc69bPage {...ROLE("owner")} />);
    await settle();
    expect(text()).toContain("Consultas recientes de tu organización");
    expect(text()).toContain("LIM750505IJ5");
    rendered.unmount();
    rendered = renderComponent(<Kyc69bPage {...ROLE("writer")} />);
    await settle();
    expect(text()).not.toContain("Consultas recientes");
  });
});

describe("parseRfcsDelTexto", () => {
  it("parte por separadores, pasa a mayusculas y quita duplicados", () => {
    expect(parseRfcsDelTexto("a1, b2;\nA1  c3")).toEqual(["A1", "B2", "C3"]);
    expect(parseRfcsDelTexto("  ")).toEqual([]);
  });
});
