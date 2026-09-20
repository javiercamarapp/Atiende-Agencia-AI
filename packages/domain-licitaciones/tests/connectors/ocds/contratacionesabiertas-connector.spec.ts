// Fase 13 — conector genérico de la plataforma "contratacionesabiertas"
// (Yucatán/INAIP + Guadalajara municipio). `fetchImpl` inyectado devuelve
// exactamente la FORMA real observada contra ambas instancias 2026-09-20
// (`/edca/fiscalYears` -> `{fiscalYears:[...]}`, `/edca/contractingprocess/{year}`
// -> `{arrayReleasePackage:[...]}`, un año no activado -> 404 con cuerpo JSON
// real) -- ver evidencia completa en `connector-registry.ts` y en el fixture
// real `../../fixtures/ocds/contratacionesabiertas-yucatan-contractingprocess-2025.json`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildCandidateYears,
  createContratacionesAbiertasConnector,
  createGuadalajaraOcdsConnector,
  createYucatanOcdsConnector,
  GUADALAJARA_OCDS_ID,
  YUCATAN_OCDS_ID,
} from "../../../src/connectors/ocds/contratacionesabiertas-connector.ts";
import { CaptchaDetectedError, RateLimitedError } from "../../../src/connector-registry.ts";
import type { DroppedRowInfo } from "../../../src/connectors/types.ts";

const ACCESS_DENIED_FIXTURE_PATH = fileURLToPath(new URL("../../fixtures/compras-mx-historico-access-denied.html", import.meta.url));
const YUCATAN_FISCAL_YEARS_FIXTURE_PATH = fileURLToPath(new URL("../../fixtures/ocds/contratacionesabiertas-yucatan-fiscal-years.json", import.meta.url));
const YUCATAN_CONTRACTINGPROCESS_2025_FIXTURE_PATH = fileURLToPath(new URL("../../fixtures/ocds/contratacionesabiertas-yucatan-contractingprocess-2025.json", import.meta.url));

const REAL_FISCAL_YEARS_YUCATAN = JSON.parse(readFileSync(YUCATAN_FISCAL_YEARS_FIXTURE_PATH, "utf8")) as unknown;
const REAL_CONTRACTINGPROCESS_2025_YUCATAN = JSON.parse(readFileSync(YUCATAN_CONTRACTINGPROCESS_2025_FIXTURE_PATH, "utf8")) as unknown;
/** Cuerpo REAL verificado (2026-09-20) contra `contractingprocess/2026` en ambas instancias -- JSON legítimo, no HTML de bloqueo. */
const REAL_404_BODY = { status: 404, message: "No se encontrarón resultados con el parámetro seleccionado." };

const NOW = new Date("2026-09-20T12:00:00Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fiscalYears(years: readonly { year: number; status?: boolean }[]) {
  return { fiscalYears: years.map((y) => ({ id: y.year, year: y.year, status: y.status ?? true, createdAt: "2025-06-25T13:49:41Z", updatedAt: "2025-06-25T13:49:41Z" })) };
}

function releasePackage(releases: unknown[]) {
  return { uri: "http://example.test/release-package.json", version: "1.1", publishedDate: "2025-07-17T15:38:28-05:00", releases };
}

describe("buildCandidateYears", () => {
  it("siempre incluye el año actual (reloj real) aunque la fuente no lo haya listado todavía", () => {
    expect(buildCandidateYears(2026, [2020, 2021, 2022, 2023, 2024, 2025], 2)).toEqual([2026, 2025]);
  });

  it("nunca pide más de maxYears años, tomando los más recientes activos", () => {
    expect(buildCandidateYears(2026, [2020, 2021, 2022, 2023, 2024, 2025], 3)).toEqual([2026, 2025, 2024]);
  });

  it("no duplica el año si ya está entre los activos más recientes", () => {
    expect(buildCandidateYears(2025, [2025], 2)).toEqual([2025]);
  });

  it("con un solo año activo (plataforma recién adoptada, caso real Guadalajara) produce [actual, ese año]", () => {
    expect(buildCandidateYears(2026, [2025], 2)).toEqual([2026, 2025]);
  });
});

describe("createContratacionesAbiertasConnector().discover()", () => {
  function connectorWith(fetchImpl: typeof fetch) {
    return createContratacionesAbiertasConnector({
      id: YUCATAN_OCDS_ID,
      sourceLabel: "Yucatán (INAIP)",
      baseUrl: "https://captura.contratacionesabiertas.inaipyucatan.org.mx",
      fixedState: "Yucatán",
      fetchImpl,
    });
  }

  it("lee /edca/fiscalYears primero y nunca hardcodea el año -- pide el actual + el más reciente activo, en ese orden", async () => {
    const calledUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrls.push(url);
      if (url.endsWith("/edca/fiscalYears")) return jsonResponse(fiscalYears([{ year: 2024 }, { year: 2025 }]));
      if (url.endsWith("/edca/contractingprocess/2026")) return jsonResponse(REAL_404_BODY, 404);
      if (url.endsWith("/edca/contractingprocess/2025")) return jsonResponse({ arrayReleasePackage: [] });
      throw new Error(`URL inesperada en el test: ${url}`);
    });
    const connector = connectorWith(fetchImpl as unknown as typeof fetch);
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW })) results.push(c);

    expect(calledUrls).toEqual([
      "https://captura.contratacionesabiertas.inaipyucatan.org.mx/edca/fiscalYears",
      "https://captura.contratacionesabiertas.inaipyucatan.org.mx/edca/contractingprocess/2026",
      "https://captura.contratacionesabiertas.inaipyucatan.org.mx/edca/contractingprocess/2025",
    ]);
    expect(results).toEqual([]);
  });

  it("un 404 real en un año fiscal no activado (evidencia real: contractingprocess/2026) se trata como 'sin datos ese año' -- nunca lanza, nunca aborta el resto de años candidatos", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/edca/fiscalYears")) return jsonResponse(fiscalYears([{ year: 2025 }]));
      if (url.endsWith("/edca/contractingprocess/2026")) return jsonResponse(REAL_404_BODY, 404);
      if (url.endsWith("/edca/contractingprocess/2025")) {
        return jsonResponse({
          arrayReleasePackage: [
            releasePackage([{ ocid: "ocds-vigente-1", date: "2025-09-01T00:00:00-05:00", tender: { title: "Servicio vigente", status: "active" } }]),
          ],
        });
      }
      throw new Error(`URL inesperada: ${url}`);
    });
    const connector = connectorWith(fetchImpl as unknown as typeof fetch);
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW })) results.push(c);
    expect(results.map((r) => r.externalId)).toEqual(["ocds-vigente-1"]);
  });

  it("deduplica por ocid tomando el release MÁS RECIENTE por `date` a través de varios tags (planning/tender/award/contract, caso real observado en Guadalajara)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/edca/fiscalYears")) return jsonResponse(fiscalYears([{ year: 2025 }]));
      if (url.endsWith("/edca/contractingprocess/2026")) return jsonResponse(REAL_404_BODY, 404);
      if (url.endsWith("/edca/contractingprocess/2025")) {
        return jsonResponse({
          arrayReleasePackage: [
            releasePackage([{ ocid: "ocds-a", date: "2025-01-01T00:00:00-05:00", tag: ["planning"], tender: { title: "Planeación", status: "active" } }]),
            releasePackage([{ ocid: "ocds-a", date: "2025-06-01T00:00:00-05:00", tag: ["contract"], tender: { title: "Ya contratado", status: "complete" } }]),
          ],
        });
      }
      throw new Error(`URL inesperada: ${url}`);
    });
    const connector = connectorWith(fetchImpl as unknown as typeof fetch);
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW })) results.push(c);
    // El release más reciente (contract, complete) gana -- no es vigente, así que el ocid completo desaparece (mismo criterio que nl-ocds-connector.ts).
    expect(results).toEqual([]);
  });

  it("respeta params.limit -- nunca produce más de los solicitados", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/edca/fiscalYears")) return jsonResponse(fiscalYears([{ year: 2025 }]));
      if (url.endsWith("/edca/contractingprocess/2026")) return jsonResponse(REAL_404_BODY, 404);
      return jsonResponse({
        arrayReleasePackage: [
          releasePackage([
            { ocid: "ocds-1", date: "2025-09-01T00:00:00-05:00", tender: { title: "Uno", status: "active" } },
            { ocid: "ocds-2", date: "2025-09-01T00:00:00-05:00", tender: { title: "Dos", status: "active" } },
          ]),
        ],
      });
    });
    const connector = connectorWith(fetchImpl as unknown as typeof fetch);
    const results = [];
    for await (const c of connector.discover({ limit: 1 }, { now: () => NOW })) results.push(c);
    expect(results).toHaveLength(1);
  });

  it("usa el fixture REAL de fiscalYears de Yucatán (2020-2025, ninguno 2026) + el fixture REAL de contractingprocess/2025 (5 release packages reales, todos tender.status='complete') -- hoy produce 0 vigentes, coherente con el alcance chico documentado (~5 contratos/año, todos ya cerrados)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/edca/fiscalYears")) return jsonResponse(REAL_FISCAL_YEARS_YUCATAN);
      if (url.endsWith("/edca/contractingprocess/2026")) return jsonResponse(REAL_404_BODY, 404);
      if (url.endsWith("/edca/contractingprocess/2025")) return jsonResponse(REAL_CONTRACTINGPROCESS_2025_YUCATAN);
      throw new Error(`URL inesperada: ${url}`);
    });
    const connector = connectorWith(fetchImpl as unknown as typeof fetch);
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW })) results.push(c);
    expect(results).toEqual([]); // Evidencia real: las 5 releases reales de 2025 son 'complete', ninguna vigente hoy.
  });

  it("SR-14: un cuerpo de bloqueo real (200 con HTML de Access Denied) en /edca/fiscalYears lanza CaptchaDetectedError -- nunca '0 candidatos' en silencio", async () => {
    const html = readFileSync(ACCESS_DENIED_FIXTURE_PATH, "utf8");
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200 }));
    const connector = connectorWith(fetchImpl as unknown as typeof fetch);
    async function drain() {
      const out = [];
      for await (const c of connector.discover({}, { now: () => NOW })) out.push(c);
      return out;
    }
    await expect(drain()).rejects.toThrow(CaptchaDetectedError);
  });

  it("SR-14: un cuerpo de bloqueo en /edca/contractingprocess/{year} también lanza CaptchaDetectedError -- un 200-bloqueo no se confunde con el 404 legítimo de 'año no activado'", async () => {
    const html = readFileSync(ACCESS_DENIED_FIXTURE_PATH, "utf8");
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/edca/fiscalYears")) return jsonResponse(fiscalYears([{ year: 2025 }]));
      return new Response(html, { status: 200 });
    });
    const connector = connectorWith(fetchImpl as unknown as typeof fetch);
    async function drain() {
      const out = [];
      for await (const c of connector.discover({}, { now: () => NOW })) out.push(c);
      return out;
    }
    await expect(drain()).rejects.toThrow(CaptchaDetectedError);
  });

  it("429 en /edca/fiscalYears lanza RateLimitedError -- la corrida se detiene por completo", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
    const connector = connectorWith(fetchImpl as unknown as typeof fetch);
    async function drain() {
      const out = [];
      for await (const c of connector.discover({}, { now: () => NOW })) out.push(c);
      return out;
    }
    await expect(drain()).rejects.toThrow(RateLimitedError);
  });

  it("429 en /edca/contractingprocess/{year} lanza RateLimitedError -- mismo criterio que nl-ocds-connector.ts (backoff = próxima corrida programada)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/edca/fiscalYears")) return jsonResponse(fiscalYears([{ year: 2025 }]));
      return new Response("", { status: 429 });
    });
    const connector = connectorWith(fetchImpl as unknown as typeof fetch);
    async function drain() {
      const out = [];
      for await (const c of connector.discover({}, { now: () => NOW })) out.push(c);
      return out;
    }
    await expect(drain()).rejects.toThrow(RateLimitedError);
  });

  it("una respuesta HTTP no-ok distinta de 404/429 lanza (nunca se interpreta como '0 registros')", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/edca/fiscalYears")) return jsonResponse(fiscalYears([{ year: 2025 }]));
      return new Response("", { status: 503 });
    });
    const connector = connectorWith(fetchImpl as unknown as typeof fetch);
    async function drain() {
      const out = [];
      for await (const c of connector.discover({}, { now: () => NOW })) out.push(c);
      return out;
    }
    await expect(drain()).rejects.toThrow(/503/);
  });

  it("un release descartado por el mapeador (sin título) se reporta vía reportDropped -- nunca desaparece en silencio", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/edca/fiscalYears")) return jsonResponse(fiscalYears([{ year: 2025 }]));
      if (url.endsWith("/edca/contractingprocess/2026")) return jsonResponse(REAL_404_BODY, 404);
      return jsonResponse({ arrayReleasePackage: [releasePackage([{ ocid: "ocds-sin-titulo", date: "2025-09-01T00:00:00-05:00", tender: { status: "active" } }])] });
    });
    const connector = connectorWith(fetchImpl as unknown as typeof fetch);
    const dropped: DroppedRowInfo[] = [];
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW, reportDropped: (d) => dropped.push(d) })) results.push(c);
    expect(results).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toMatch(/sin tender\.title/);
  });

  it("fetchDetail no está implementado -- lanza explícitamente", async () => {
    const connector = connectorWith((async () => new Response("")) as unknown as typeof fetch);
    await expect(connector.fetchDetail("ocds-1")).rejects.toThrow(/no está implementado/);
  });
});

describe("createYucatanOcdsConnector() / createGuadalajaraOcdsConnector()", () => {
  it("Yucatán usa el host real del INAIP y fixedState 'Yucatán' -- id yucatan_ocds", async () => {
    const calledUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrls.push(url);
      if (url.includes("/edca/fiscalYears")) return jsonResponse(fiscalYears([{ year: 2025 }]));
      return jsonResponse(REAL_404_BODY, 404);
    });
    const connector = createYucatanOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(connector.id).toBe(YUCATAN_OCDS_ID);
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW })) results.push(c);
    expect(calledUrls[0]).toBe("https://captura.contratacionesabiertas.inaipyucatan.org.mx/edca/fiscalYears");
  });

  it("Guadalajara usa el host real del municipio (puerto 3000, DISTINTO de miradapublica) y fixedState 'Jalisco' (municipio, no entidad federativa -- ver comentario del conector) -- id guadalajara_ocds", async () => {
    const calledUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrls.push(url);
      if (url.includes("/edca/fiscalYears")) return jsonResponse(fiscalYears([{ year: 2025 }]));
      if (url.includes("/edca/contractingprocess/2025")) {
        return jsonResponse({ arrayReleasePackage: [releasePackage([{ ocid: "ocds-gdl-1", date: "2025-09-01T00:00:00-05:00", tender: { title: "Servicio municipal vigente", status: "active" } }])] });
      }
      return jsonResponse(REAL_404_BODY, 404);
    });
    const connector = createGuadalajaraOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(connector.id).toBe(GUADALAJARA_OCDS_ID);
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW })) results.push(c);
    expect(calledUrls[0]).toBe("https://contratacionesabiertas.guadalajara.gob.mx:3000/edca/fiscalYears");
    expect(results).toEqual([expect.objectContaining({ externalId: "ocds-gdl-1", state: "Jalisco" })]);
  });
});
