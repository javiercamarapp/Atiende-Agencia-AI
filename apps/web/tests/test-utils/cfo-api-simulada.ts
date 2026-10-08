// CFO-07 · `fetch` falso para las pruebas de componente del CFO: sirve las MISMAS respuestas SINTÉTICAS que la API simulada de e2e
// (`e2e/mock-api/fixtures/restaurantes-cfo.ts`, generadas con CFO-04 + CFO-05), con estado propio por prueba y ganchos para forzar casos
// (vacío, error, 403, base sin migrar). Registra cada petición para afirmar qué se pidió.
import { vi } from "vitest";
import { rutasRestaurantesCfo } from "../../e2e/mock-api/fixtures/restaurantes-cfo.ts";
import { rutasRestaurantesCfoB } from "../../e2e/mock-api/fixtures/restaurantes-cfo-b.ts";
import { esRespuestaMarcada } from "../../e2e/mock-api/respuestas.ts";
import type { EstadoEscenario, Peticion } from "../../e2e/mock-api/tipos.ts";
import type { AlcanceVista } from "@atiende/domain-restaurantes/cfo";
import type { CfoPaginaProps } from "../../src/verticals/restaurantes/cfo/contexto.ts";
import { filtrosPorDefecto, type FiltrosCfo } from "../../src/verticals/restaurantes/cfo/filtros-url.ts";
import { PAGINAS_CFO } from "../../src/verticals/restaurantes/cfo/paginas.ts";

export const API = "https://api.test";
export const PROPIEDAD = "prop-1";
export const BASE_CFO = `${API}/v1/restaurantes/${PROPIEDAD}/admin/cfo`;
export const RANGO = { desde: "2026-09-21", hasta: "2026-09-27" } as const;
const A = "00000000-0000-4000-8000-0000000000";
export const IDS = { T1: `${A}a1`, T2: `${A}a2`, T3: `${A}a3`, T4: `${A}a4` } as const;

export interface PeticionRegistrada {
  readonly metodo: string;
  readonly ruta: string;
  readonly consulta: URLSearchParams;
  readonly cuerpo: unknown;
}

export type Forzado = { readonly status: number; readonly cuerpo?: unknown } | ((p: PeticionRegistrada) => { readonly status: number; readonly cuerpo?: unknown } | unknown | undefined);

function estadoNuevo(): EstadoEscenario {
  const mapa = new Map<string, unknown>();
  return {
    obtener: <T,>(clave: string, semilla: () => T): T => {
      if (!mapa.has(clave)) mapa.set(clave, semilla());
      return mapa.get(clave) as T;
    },
    guardar: (clave: string, valor: unknown) => void mapa.set(clave, valor),
  };
}

function coincide(patron: string, ruta: string): Record<string, string> | null {
  const rx = new RegExp(`^${patron.replace(/:[a-z]+/g, "([^/]+)")}$`);
  const m = rx.exec(ruta);
  return m ? { id: m[1] ?? "" } : null;
}

function respuesta(status: number, cuerpo: unknown): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => cuerpo ?? {}, blob: async () => new Blob([]) } as unknown as Response;
}

/**
 * `forzar`: clave `"GET /resumen"` (método + ruta tras `/admin/cfo`) -> respuesta forzada o función que la calcula (devolver `undefined` deja pasar a la fixture);
 * una función puede devolver un objeto plano (200) o `{ status, cuerpo }`.
 */
export function crearApiCfo(forzar: Readonly<Record<string, Forzado>> = {}) {
  const estado = estadoNuevo();
  const registro: PeticionRegistrada[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const metodo = init?.method ?? "GET";
    const ruta = url.pathname.replace(/^.*\/admin\/cfo/, "");
    const cuerpo = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const reg: PeticionRegistrada = { metodo, ruta, consulta: url.searchParams, cuerpo };
    registro.push(reg);
    const f = forzar[`${metodo} ${ruta}`];
    if (f !== undefined) {
      const r = typeof f === "function" ? f(reg) : f;
      if (r !== undefined) {
        if (typeof r === "object" && r !== null && "status" in r && typeof (r as { status: unknown }).status === "number") return respuesta((r as { status: number }).status, (r as { cuerpo?: unknown }).cuerpo);
        return respuesta(200, r);
      }
    }
    for (const r of [...rutasRestaurantesCfo, ...rutasRestaurantesCfoB]) {
      if (r.metodo !== metodo) continue;
      const params = coincide(r.patron.replace(":id", "[^/]+"), url.pathname);
      if (!params) continue;
      const p: Peticion = { metodo, ruta: url.pathname, query: url.searchParams, cuerpo, params, persona: null, cabeceras: {}, estado };
      const salida = await r.manejador(p);
      if (esRespuestaMarcada(salida)) return respuesta(salida.status, salida.cuerpo);
      if (typeof salida === "object" && salida !== null && "status" in salida && typeof (salida as { status: unknown }).status === "number") {
        return respuesta((salida as { status: number }).status, (salida as { cuerpo?: unknown }).cuerpo);
      }
      return respuesta(200, salida);
    }
    return respuesta(404, { message: `sin fixture: ${metodo} ${ruta}` });
  });
  return {
    fetch: fetchMock as unknown as typeof fetch,
    mock: fetchMock,
    registro,
    peticiones: (metodo: string, ruta: string): PeticionRegistrada[] => registro.filter((r) => r.metodo === metodo && r.ruta === ruta),
  };
}

/** Copia profunda editable de una respuesta de la fixture (para armar casos: sin datos, etc.). */
export async function respuestaBase<T>(ruta: string, consulta: Record<string, string> = {}): Promise<T> {
  const api = crearApiCfo();
  const q = new URLSearchParams({ ...RANGO, comparar: "periodo_anterior", ...consulta });
  const res = await api.fetch(`${BASE_CFO}${ruta}?${q.toString()}`, { method: "GET" });
  return structuredClone(await res.json()) as T;
}

export const flush = async (act: (f: () => Promise<void>) => Promise<void>, n = 12): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  });
};


/** Props de una pestaña del CFO como las arma `CfoLayout`, con el rango de la fixture SINTÉTICA. */
export async function propsPagina(api: ReturnType<typeof crearApiCfo>, sobre: { filtros?: Partial<FiltrosCfo>; role?: string; alcance?: Partial<AlcanceVista>; abrirPedidos?: CfoPaginaProps["abrirPedidos"]; setFiltros?: CfoPaginaProps["setFiltros"] } = {}): Promise<CfoPaginaProps> {
  const alcance = { ...(await respuestaBase<AlcanceVista>("/alcance")), ...sobre.alcance } as AlcanceVista;
  return {
    api: { fetchImpl: api.fetch, apiBaseUrl: API, token: "tok", propertyId: PROPIEDAD },
    role: sobre.role ?? "owner",
    orgSlug: "demo",
    base: "/restaurantes/demo",
    filtros: { ...filtrosPorDefecto("2026-09-28"), ...RANGO, ...sobre.filtros },
    alcance,
    setFiltros: sobre.setFiltros ?? (() => undefined),
    abrirPedidos: sobre.abrirPedidos ?? (() => undefined),
    pestanasDisponibles: new Set(PAGINAS_CFO.map((p) => p.slug)),
  };
}
