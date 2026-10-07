// paridad3 L-P3-13: el listado de convocatorias NO se corta en 50 sin aviso. Con 251 convocatorias sembradas, la lista recorre todas
// (X-Total-Count / X-Next-Offset), los filtros se aplican en el servidor, el resumen cuenta sobre toda la organizacion y el matching
// respeta su techo y su default de plazo vigente.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";
import type { TenderRecord } from "@atiende/domain-licitaciones";

const TOTAL_SEMBRADAS = 251;

type Ctx = Awaited<ReturnType<typeof buildLicitacionesTestContext>>;

const DIA = 24 * 60 * 60 * 1000;

function sembrar(ctx: Ctx, n: number, over: (i: number) => Partial<TenderRecord> = () => ({})): void {
  for (let i = 0; i < n; i += 1) {
    ctx.repo.seedTender({
      id: randomUUID(),
      organizationId: ctx.organizationId,
      title: `Convocatoria sembrada ${i}`,
      submissionDeadline: null,
      // Mismo `updatedAt` en bloques de 10: el desempate por id debe evitar repetidos/saltos entre paginas.
      updatedAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 10) * 1000).toISOString(),
      source: "manual",
      externalId: `SEMB-${i}`,
      status: "discovered",
      ...over(i),
    });
  }
}

async function get(ctx: Ctx, path: string, token = ctx.staff.owner.token): Promise<Response> {
  return buildApp(ctx.deps).request(`/licitaciones/${ctx.propertyId}${path}`, authedJson(token));
}

describe("GET .../tenders -- listado completo (L-P3-13)", () => {
  it("con 251 convocatorias la lista recorre TODAS sin repetir ni saltar y X-Total-Count dice 252 (251 + la del fixture)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    sembrar(ctx, TOTAL_SEMBRADAS);
    const vistos = new Set<string>();
    let offset = 0;
    let paginas = 0;
    for (;;) {
      const res = await get(ctx, `/tenders?limit=200&offset=${offset}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-total-count")).toBe("252");
      const body = (await res.json()) as { tenders: { id: string }[] };
      for (const t of body.tenders) {
        expect(vistos.has(t.id)).toBe(false);
        vistos.add(t.id);
      }
      paginas += 1;
      const next = res.headers.get("x-next-offset");
      if (next === null) break;
      offset = Number(next);
    }
    expect(vistos.size).toBe(252);
    expect(paginas).toBe(2);
  });

  it("sin limit el default sigue siendo 50 pero ahora anuncia el total real y el siguiente offset", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    sembrar(ctx, 60);
    const res = await get(ctx, "/tenders");
    const body = (await res.json()) as { tenders: unknown[] };
    expect(body.tenders).toHaveLength(50);
    expect(res.headers.get("x-total-count")).toBe("61");
    expect(res.headers.get("x-next-offset")).toBe("50");
  });

  it("q, status y source filtran en el servidor: el total y la pagina reflejan el filtro", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    sembrar(ctx, 120, (i) => ({ status: i % 4 === 0 ? "go" : "discovered", source: i % 3 === 0 ? "nl_ocds" : "manual", contractingBody: i === 7 ? "Secretaría de Salud" : "IMSS" }));

    const porEstado = await get(ctx, "/tenders?status=go&limit=200");
    expect(porEstado.headers.get("x-total-count")).toBe("30");
    expect(((await porEstado.json()) as { tenders: { status: string }[] }).tenders.every((t) => t.status === "go")).toBe(true);

    const porFuente = await get(ctx, "/tenders?source=nl_ocds");
    expect(porFuente.headers.get("x-total-count")).toBe("40");

    const porTexto = await get(ctx, "/tenders?q=salud");
    expect(porTexto.headers.get("x-total-count")).toBe("1");
    const porFolio = await get(ctx, "/tenders?q=SEMB-11");
    expect(porFolio.headers.get("x-total-count")).toBe("11"); // SEMB-11 y SEMB-110..119 (la busqueda es por subcadena)
  });

  it("ids acota a lo pedido (para Seguimiento y Radar) y un id mal formado es 400, no se ignora", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    sembrar(ctx, 30);
    const res = await get(ctx, `/tenders?ids=${ctx.tenderId}`);
    const body = (await res.json()) as { tenders: { id: string }[] };
    expect(body.tenders.map((t) => t.id)).toEqual([ctx.tenderId]);
    expect((await get(ctx, "/tenders?ids=no-es-uuid")).status).toBe(400);
    expect((await get(ctx, "/tenders?status=inventado")).status).toBe(400);
    expect((await get(ctx, "/tenders?deadlineFrom=ayer")).status).toBe(400);
  });

  it("deadlineFrom/deadlineTo acotan por plazo y excluyen las convocatorias sin plazo", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const ahora = Date.now();
    sembrar(ctx, 20, (i) => ({ submissionDeadline: i < 5 ? new Date(ahora + (i + 1) * DIA).toISOString() : null }));
    const hasta = new Date(ahora + 3 * DIA + 1000).toISOString();
    const res = await get(ctx, `/tenders?deadlineFrom=${encodeURIComponent(new Date(ahora).toISOString())}&deadlineTo=${encodeURIComponent(hasta)}`);
    expect(res.headers.get("x-total-count")).toBe("3");
  });

  it("no mezcla organizaciones: una convocatoria de otra organizacion no aparece ni cuenta", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    ctx.repo.seedTender({ id: randomUUID(), organizationId: randomUUID(), title: "Ajena", submissionDeadline: null, updatedAt: "2026-02-01T00:00:00Z", status: "go" });
    const res = await get(ctx, "/tenders");
    expect(res.headers.get("x-total-count")).toBe("1");
    const resumen = (await (await get(ctx, "/tenders/summary")).json()) as { total: number };
    expect(resumen.total).toBe(1);
  });
});

describe("GET .../tenders/summary -- conteos de toda la organizacion", () => {
  it("cuadra con lo sembrado: total, abiertas, por vencer en 7 dias y por estado (sin tope de 50)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const ahora = Date.now();
    // 100 discovered (10 con plazo en 3 dias), 80 in_progress (5 con plazo en 3 dias), 40 won, 30 submitted con plazo en 2 dias (no cuentan por vencer).
    sembrar(ctx, 250, (i) => {
      if (i < 100) return { status: "discovered", submissionDeadline: i < 10 ? new Date(ahora + 3 * DIA).toISOString() : null };
      if (i < 180) return { status: "in_progress", submissionDeadline: i < 105 ? new Date(ahora + 3 * DIA).toISOString() : new Date(ahora + 30 * DIA).toISOString() };
      if (i < 220) return { status: "won", submissionDeadline: new Date(ahora + 2 * DIA).toISOString() };
      return { status: "submitted", submissionDeadline: new Date(ahora + 2 * DIA).toISOString() };
    });
    const res = await get(ctx, "/tenders/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; open: number; closingSoon: number; windowDays: number; byStatus: Record<string, number> };
    expect(body.total).toBe(251); // 250 + fixture
    expect(body.byStatus).toMatchObject({ in_progress: 80, won: 40, submitted: 30 });
    expect(body.byStatus.discovered).toBe(101);
    expect(body.open).toBe(251 - 40);
    expect(body.closingSoon).toBe(15);
    expect(body.windowDays).toBe(7);
  });

  it("lo puede leer un viewer y sin sesion es 401", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    expect((await get(ctx, "/tenders/summary", ctx.staff.viewer.token)).status).toBe(200);
    const sin = await buildApp(ctx.deps).request(`/licitaciones/${ctx.propertyId}/tenders/summary`);
    expect(sin.status).toBe(401);
  });
});

describe("GET .../tenders/matching -- acotado", () => {
  it("respeta el techo: limit=999 se recorta a 200 y por omision solo considera plazo vigente", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const ahora = Date.now();
    sembrar(ctx, 300, (i) => ({ submissionDeadline: i < 250 ? new Date(ahora + (i + 1) * 60_000).toISOString() : new Date(ahora - DIA).toISOString() }));
    const res = await get(ctx, "/tenders/matching?limit=999");
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(200);
    expect(res.headers.get("x-total-count")).toBe("251"); // 250 sembradas vigentes + la del fixture (plazo futuro); las 50 vencidas no cuentan
    expect(res.headers.get("x-next-offset")).toBe("200");
    const p2 = await get(ctx, "/tenders/matching?limit=200&offset=200");
    expect(((await p2.json()) as { results: unknown[] }).results).toHaveLength(51);
  });

  it("incluirVencidas=true suma las vencidas y ids pide convocatorias concretas sin importar el plazo", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const ahora = Date.now();
    sembrar(ctx, 10, () => ({ submissionDeadline: new Date(ahora - DIA).toISOString() }));
    expect((await get(ctx, "/tenders/matching")).headers.get("x-total-count")).toBe("1"); // solo la del fixture (plazo futuro)
    expect((await get(ctx, "/tenders/matching?incluirVencidas=true")).headers.get("x-total-count")).toBe("11");
    const porId = (await (await get(ctx, `/tenders/matching?ids=${ctx.tenderId}`)).json()) as { results: unknown[] };
    expect(porId.results).toHaveLength(1);
  });
});
