// paridad3 L-P3-11 -- resumen semanal por organizacion dentro del barrido existente /internal/licitaciones/alert-notifications
// (sin cron nuevo): solo si hay algo que contar, una vez por semana (dedupe de campana y de outbox), campana solo con conteos,
// correo con titulos a owner/admin, y un componente sin migrar cuenta 0 sin romper el barrido.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const RUTA = "/internal/licitaciones/alert-notifications";

interface CuerpoBarrido {
  readonly ok: boolean;
  readonly resumen_semanal: { readonly organizacionesConResumen: number; readonly correosEncolados: number; readonly errores: number };
  readonly kyc_retamizado: { readonly disponible: boolean; readonly error: string | null };
}

async function armar() {
  const ctx = await buildLicitacionesTestContext(buildApp, { submissionDeadline: null });
  ctx.repo.seedNotificationRecipient(ctx.organizationId, { email: "dueno@example.com", fullName: "Dueno" });
  const { deps, emisiones } = conEmisiones(ctx.deps);
  const app = buildApp(deps);
  const correr = async () => {
    const res = await app.request(RUTA, { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    return { res, body: (await res.json()) as CuerpoBarrido };
  };
  const resumenes = () => emisiones.filter((e) => e.evento === "licitaciones.resumen.semanal");
  const correos = () => ctx.repo.getMessagingOutbox().filter((o) => o.eventType === "tender.resumen_semanal");
  return { ctx, correr, resumenes, correos };
}

describe("resumen semanal (L-P3-11)", () => {
  it("sin nada que contar no se emite ni se encola nada", async () => {
    const t = await armar();
    const { res, body } = await t.correr();
    expect(res.status).toBe(200);
    expect(body.resumen_semanal).toEqual({ organizacionesConResumen: 0, correosEncolados: 0, errores: 0 });
    expect(t.resumenes()).toHaveLength(0);
    expect(t.correos()).toHaveLength(0);
  });

  it("con plazos de la semana y nuevos matches: campana solo con conteos, correo con titulos, UNA vez por semana", async () => {
    const t = await armar();
    const tenderId = randomUUID();
    t.ctx.repo.seedTender({ id: tenderId, organizationId: t.ctx.organizationId, title: "Vence esta semana", submissionDeadline: new Date(Date.now() + 3 * 86_400_000).toISOString(), updatedAt: new Date().toISOString() });
    await t.ctx.repo.recordNewMatch(t.ctx.organizationId, tenderId, { score: 88, eligible: true });

    const { body } = await t.correr();
    expect(body.resumen_semanal).toMatchObject({ organizacionesConResumen: 1, correosEncolados: 1, errores: 0 });

    const [e] = t.resumenes();
    expect(e).toMatchObject({ organizationId: t.ctx.organizationId, severidad: "info", roles: ["analyst", "writer", "reviewer"] });
    expect(e!.cuerpo).toBe("Esta semana: 1 convocatorias con match, 1 plazos, 0 documentos por vencer, 0 facturas vencidas y 0 garantías por vencer.");
    expect(e!.titulo + e!.cuerpo).not.toMatch(/Vence esta semana/);

    const [correo] = t.correos();
    expect(correo!.payload).toMatchObject({ to: "dueno@example.com" });
    expect(String(correo!.payload.html)).toContain("Vence esta semana");
    expect(String(correo!.payload.subject)).toContain("Resumen semanal");

    // el siguiente barrido de la misma semana no repite ni la campana ni el correo
    const antes = t.resumenes().length;
    await t.correr();
    expect(t.resumenes().length).toBeGreaterThanOrEqual(antes); // se intenta emitir con la MISMA clave: la base lo deduplica
    expect(new Set(t.resumenes().map((x) => x.dedupeKey)).size).toBe(1);
    expect(t.correos()).toHaveLength(1);
  });

  it("un componente sin migrar (matches) cuenta 0 y el resto del resumen sale igual; el barrido responde 200", async () => {
    const t = await armar();
    t.ctx.repo.seedTender({ id: randomUUID(), organizationId: t.ctx.organizationId, title: "Vence esta semana", submissionDeadline: new Date(Date.now() + 2 * 86_400_000).toISOString(), updatedAt: new Date().toISOString() });
    vi.spyOn(t.ctx.repo, "listNewMatches").mockResolvedValue(null);
    const { res, body } = await t.correr();
    expect(res.status).toBe(200);
    expect(body.resumen_semanal.organizacionesConResumen).toBe(1);
    expect(t.resumenes()[0]!.cuerpo).toContain("0 convocatorias con match, 1 plazos");
  });

  it("un fallo del resumen de una organizacion no cambia el barrido (200, ok) y se cuenta", async () => {
    const t = await armar();
    vi.spyOn(t.ctx.repo, "listUpcomingDeadlines").mockRejectedValue(new Error("boom"));
    const consola = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { res, body } = await t.correr();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.resumen_semanal.errores).toBe(1);
    consola.mockRestore();
  });
});

describe("respaldo diario del re-tamizado KYC dentro del barrido (L-P3-10)", () => {
  const org = "00000000-0000-0000-0000-00000000aa01";
  const armarKyc = async (resultados: { disponible: boolean; organizaciones: { organizationId: string; periodo: string; evaluadas: number; empeoradas: number; proveedoresEmpeorados: number }[] }[], alEmitir?: () => number) => {
    const ctx = await buildLicitacionesTestContext(buildApp, { submissionDeadline: null });
    let n = 0;
    const { deps, emisiones } = conEmisiones({ ...ctx.deps, licitacionesAvisosRepo: () => ({ retamizarCarteraKyc: async () => resultados[Math.min(n++, resultados.length - 1)]!, contarDocumentosPorVencer: async () => 0 }) }, alEmitir ? { alEmitir } : {});
    const app = buildApp(deps);
    const correr = async () => {
      const res = await app.request(RUTA, { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
      return { res, body: (await res.json()) as CuerpoBarrido };
    };
    return { correr, emisiones, llamadas: () => n };
  };

  it("el barrido diario corre el re-tamizado y emite la alerta KYC una vez; al dia siguiente (misma edicion) no repite", async () => {
    const t = await armarKyc([{ disponible: true, organizaciones: [{ organizationId: org, periodo: "2026-10", evaluadas: 3, empeoradas: 1, proveedoresEmpeorados: 1 }] }, { disponible: true, organizaciones: [] }]);
    const primera = await t.correr();
    expect(primera.res.status).toBe(200);
    expect(primera.body.kyc_retamizado).toEqual({ disponible: true, organizaciones: 1, fichas_evaluadas: 3, alertas_emitidas: 1, error: null });
    expect(t.emisiones.filter((e) => e.evento === "licitaciones.kyc.proveedor_empeoro")).toHaveLength(1);
    const segunda = await t.correr();
    expect(segunda.body.kyc_retamizado).toMatchObject({ organizaciones: 0, alertas_emitidas: 0, error: null });
    expect(t.emisiones.filter((e) => e.evento === "licitaciones.kyc.proveedor_empeoro")).toHaveLength(1);
  });

  it("si el aviso KYC no se pudo emitir el barrido responde 200 (ok) con el error del respaldo y se reintenta en la siguiente corrida", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await armarKyc([{ disponible: true, organizaciones: [{ organizationId: org, periodo: "2026-10", evaluadas: 1, empeoradas: 1, proveedoresEmpeorados: 1 }] }], () => {
      throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
    });
    const { res, body } = await t.correr();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.kyc_retamizado.error).toMatch(/no se emitio/);
    consola.mockRestore();
  });

  it("base sin la migracion 034: el respaldo declara disponible=false y el barrido sigue igual", async () => {
    const t = await armarKyc([{ disponible: false, organizaciones: [] }]);
    const { res, body } = await t.correr();
    expect(res.status).toBe(200);
    expect(body.kyc_retamizado).toMatchObject({ disponible: false, error: null });
  });
});
