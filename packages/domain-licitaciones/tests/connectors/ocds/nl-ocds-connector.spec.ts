// Fase 9 — conector real de Nuevo León. `fetchImpl` inyectado devuelve
// exactamente la FORMA real observada contra `https://api-ocds.nl.gob.mx/api/releases`
// (paginación Laravel, `data: [{numberPublication, releases}]`) -- ver
// evidencia completa en connector-registry.ts y en el fixture real
// `../../fixtures/ocds/nl-releases-page-sample.json`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createNlOcdsConnector } from "../../../src/connectors/ocds/nl-ocds-connector.ts";
import { CaptchaDetectedError, RateLimitedError } from "../../../src/connector-registry.ts";
import type { DroppedRowInfo } from "../../../src/connectors/types.ts";

const ACCESS_DENIED_FIXTURE_PATH = fileURLToPath(new URL("../../fixtures/compras-mx-historico-access-denied.html", import.meta.url));

function page(overrides: Partial<{ data: unknown[]; last_page: number }> = {}) {
  return { current_page: 1, data: overrides.data ?? [], last_page: overrides.last_page ?? 1, per_page: 10, total: 0 };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const NOW = new Date("2026-09-19T00:00:00Z");

describe("createNlOcdsConnector().discover()", () => {
  it("hace peticiones HTTP reales (vía fetchImpl inyectado) paginando por ?page=N hasta last_page", async () => {
    const p1 = page({
      last_page: 2,
      data: [{ numberPublication: 2, releases: [{ ocid: "ocds-a", date: "2026-09-18T00:00:00Z", tender: { title: "Uno", status: "active" } }] }],
    });
    const p2 = page({
      last_page: 2,
      data: [{ numberPublication: 1, releases: [{ ocid: "ocds-b", date: "2026-09-01T00:00:00Z", tender: { title: "Dos", status: "active" } }] }],
    });
    const fetchImpl = vi.fn(async (url: string) => (url.includes("page=2") ? jsonResponse(p2) : jsonResponse(p1)));

    const connector = createNlOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW })) results.push(c);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![0]).toContain("page=1");
    expect(fetchImpl.mock.calls[1]![0]).toContain("page=2");
    expect(results.map((r) => r.externalId).sort()).toEqual(["ocds-a", "ocds-b"]);
  });

  it("nunca pide más páginas que maxPages, aunque last_page real sea mayor", async () => {
    const p1 = page({ last_page: 9, data: [{ numberPublication: 3, releases: [{ ocid: "ocds-a", date: "2026-09-18T00:00:00Z", tender: { title: "Uno", status: "active" } }] }] });
    const fetchImpl = vi.fn(async () => jsonResponse(p1));
    const connector = createNlOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch, maxPages: 1 });
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW })) results.push(c);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("deduplica por ocid tomando el release MÁS RECIENTE por `date` -- un release viejo 'active' no gana sobre uno nuevo 'cancelled'", async () => {
    const p1 = page({
      data: [
        {
          numberPublication: 1,
          releases: [
            { ocid: "ocds-a", date: "2026-05-01T00:00:00Z", tender: { title: "Versión vieja", status: "active" } },
            { ocid: "ocds-a", date: "2026-09-01T00:00:00Z", tender: { title: "Versión nueva", status: "cancelled" } },
          ],
        },
      ],
    });
    const fetchImpl = vi.fn(async () => jsonResponse(p1));
    const connector = createNlOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW })) results.push(c);
    // La versión más reciente ('cancelled') no es vigente -- se descarta por completo, la vieja 'active' NUNCA se usa aunque sí sea vigente por sí sola.
    expect(results).toHaveLength(0);
  });

  it("solo produce releases VIGENTES (status active y/o tenderPeriod futuro) -- uno cerrado real se excluye sin reportarse como 'dropped'", async () => {
    const p1 = page({
      data: [
        {
          numberPublication: 1,
          releases: [
            { ocid: "ocds-vigente", date: "2026-09-18T00:00:00Z", tender: { title: "Vigente", status: "active" } },
            { ocid: "ocds-cerrado", date: "2026-01-01T00:00:00Z", tender: { title: "Cerrado", status: "complete" } },
          ],
        },
      ],
    });
    const fetchImpl = vi.fn(async () => jsonResponse(p1));
    const connector = createNlOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const dropped: DroppedRowInfo[] = [];
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW, reportDropped: (d) => dropped.push(d) })) results.push(c);
    expect(results.map((r) => r.externalId)).toEqual(["ocds-vigente"]);
    expect(dropped).toEqual([]); // el descarte por vigencia no es un "dropped row" (ver comentario del conector) -- solo lo son las filas malformadas.
  });

  it("respeta params.limit -- nunca produce más de los solicitados", async () => {
    const p1 = page({
      data: [
        {
          numberPublication: 1,
          releases: [
            { ocid: "ocds-1", date: "2026-09-18T00:00:00Z", tender: { title: "Uno", status: "active" } },
            { ocid: "ocds-2", date: "2026-09-18T00:00:00Z", tender: { title: "Dos", status: "active" } },
          ],
        },
      ],
    });
    const fetchImpl = vi.fn(async () => jsonResponse(p1));
    const connector = createNlOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const results = [];
    for await (const c of connector.discover({ limit: 1 }, { now: () => NOW })) results.push(c);
    expect(results).toHaveLength(1);
  });

  it("SR-14: ante el HTML de bloqueo real, lanza CaptchaDetectedError -- nunca '0 candidatos' en silencio", async () => {
    const html = readFileSync(ACCESS_DENIED_FIXTURE_PATH, "utf8");
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200 }));
    const connector = createNlOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    async function drain() {
      const out = [];
      for await (const c of connector.discover({}, { now: () => NOW })) out.push(c);
      return out;
    }
    await expect(drain()).rejects.toThrow(CaptchaDetectedError);
  });

  it("429 lanza RateLimitedError -- la corrida se detiene por completo (backoff = próxima corrida programada)", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
    const connector = createNlOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    async function drain() {
      const out = [];
      for await (const c of connector.discover({}, { now: () => NOW })) out.push(c);
      return out;
    }
    await expect(drain()).rejects.toThrow(RateLimitedError);
  });

  it("una respuesta HTTP no-ok lanza (nunca se interpreta como '0 registros')", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    const connector = createNlOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    async function drain() {
      const out = [];
      for await (const c of connector.discover({}, { now: () => NOW })) out.push(c);
      return out;
    }
    await expect(drain()).rejects.toThrow(/503/);
  });

  it("fetchDetail no está implementado -- lanza explícitamente", async () => {
    const connector = createNlOcdsConnector();
    await expect(connector.fetchDetail("ocds-1")).rejects.toThrow(/no está implementado/);
  });
});
