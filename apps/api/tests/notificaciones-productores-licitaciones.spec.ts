// L-30/L-32: productores `licitaciones.renovacion.por_vencer`, `.cobranza.factura_vencida`, `.documentos.por_vencer`
// (barrido existente), `.convocatoria.bases_modificadas` (escritura que crea la version) y `.kyc.proveedor_empeoro`
// (re-tamizado), al final de este archivo.
// Productor `licitaciones.convocatoria.nueva`: la ingesta automatica avisa (una por organizacion por dia, solo el conteo) cuando creo
// registros nuevos; sin registros nuevos no emite, y una emision que falla (base sin 0039) no cambia el barrido ni la respuesta.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import type { AvisosSistemaRepository, KycRetamizadoResultado } from "@atiende/domain-licitaciones";
import { inicioDeSemana } from "../src/routes/verticals/licitaciones/avisos-campana.ts";
import { conEmisiones } from "./support/emisiones.ts";

const HEADER = "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,descripcion_contrato,contract_type,work_category_id,tipo_contratacion,tipo_expediente,importe,moneda,fecha_inicio,fecha_fin,project_code,ff_fecha_inicio,ff_fecha_fin";
const csv = (rows: string[]) => `${[HEADER, ...rows].join("\n")}\n`;

afterEach(() => vi.unstubAllGlobals());

/** Base sin migrar: la funcion de emision no existe (SQLSTATE 42883). */
const errorSinMigrar = (): number => {
  throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
};

async function setup(opciones: { alEmitir?: () => number } = {}) {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const { deps, emisiones } = conEmisiones(ctx.deps, opciones);
  const cron = () => buildApp(deps).request("/internal/licitaciones/discover-tenders", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
  return { ctx, emisiones, cron };
}

describe("licitaciones.convocatoria.nueva", () => {
  it("emite UNA por organizacion con el conteo de registros nuevos, a analistas, con clave organizacion + dia y sin titulos", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csv(["CTR-1,EXP-1,Prov,Contrato secreto de prueba,,,,,,1000,MXN,2020-01-01,2020-06-01,,,"]), { status: 200 })));
    const s = await setup();
    expect((await s.cron()).status).toBe(200);
    const mias = s.emisiones.filter((e) => e.organizationId === s.ctx.organizationId);
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({ evento: "licitaciones.convocatoria.nueva", categoria: "operacion", severidad: "info", cuerpo: "Registros nuevos: 1.", enlace: "/licitaciones/{orgSlug}/convocatorias", roles: ["analyst"] });
    expect(mias[0]!.dedupeKey).toBe(`licitaciones.convocatoria.nueva:${s.ctx.organizationId}:${new Date().toISOString().slice(0, 10)}`);
    expect(JSON.stringify(mias[0])).not.toContain("secreto");
  });

  it("sin registros nuevos no emite", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csv([]), { status: 200 })));
    const s = await setup();
    expect((await s.cron()).status).toBe(200);
    expect(s.emisiones.filter((e) => e.evento === "licitaciones.convocatoria.nueva")).toHaveLength(0);
  });

  it("una emision que falla (base sin migrar) deja la respuesta del barrido intacta", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csv(["CTR-2,EXP-2,Prov,Otro contrato,,,,,,1000,MXN,2020-01-01,2020-06-01,,,"]), { status: 200 })));
    const s = await setup({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const res = await s.cron();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { corridas: { organization_id: string; fuentes: { source: string; creados: number }[] }[] };
    expect(body.corridas.find((c) => c.organization_id === s.ctx.organizationId)!.fuentes.find((f) => f.source === "compras_mx_historico")!.creados).toBe(1);
  });
});

const hoy = () => new Date().toISOString().slice(0, 10);
const ORG_B = "00000000-0000-0000-0000-00000000bb02";

describe("avisos del barrido /internal/licitaciones/alert-notifications (L-30)", () => {
  async function setup(opciones: { alEmitir?: () => number; documentos?: (orgId: string) => number | null | Error; poderes?: (orgId: string) => number | null | Error } = {}) {
    const ctx = await buildLicitacionesTestContext(buildApp, { submissionDeadline: null });
    const base = conEmisiones(ctx.deps, opciones);
    const avisos: AvisosSistemaRepository = {
      retamizarCarteraKyc: async () => ({ disponible: false, organizaciones: [] }),
      contarDocumentosPorVencer: async (orgId) => {
        const r = opciones.documentos ? opciones.documentos(orgId) : 0;
        if (r instanceof Error) throw r;
        return r;
      },
      contarPoderesPorVencer: async (orgId) => {
        const r = opciones.poderes ? opciones.poderes(orgId) : 0;
        if (r instanceof Error) throw r;
        return r;
      },
    };
    const deps = { ...base.deps, licitacionesAvisosRepo: () => avisos };
    const cron = () => buildApp(deps).request("/internal/licitaciones/alert-notifications", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    // Contrato que vence en 20 dias (alcanza los umbrales de renovacion) y una factura ya vencida, en la organizacion indicada.
    async function sembrarContrato(organizationId: string, tenderId: string) {
      await ctx.repo.createContract(organizationId, tenderId, ctx.staff.owner.id);
      await ctx.repo.updateContractMetadata(organizationId, tenderId, { endDate: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10) });
      await ctx.repo.createContractInvoice(organizationId, tenderId, { concepto: "Concepto-secreto-de-factura", amount: "1000.00", invoiceVerifiedOn: "2020-01-01", actorId: ctx.staff.owner.id });
    }
    return { ctx, emisiones: base.emisiones, cron, sembrarContrato };
  }

  it("la escritura real emite UNA aviso de renovacion y UNA de cobranza por organizacion, solo conteos; repetir el barrido no repite la renovacion y la cobranza conserva la misma clave", async () => {
    const s = await setup();
    await s.sembrarContrato(s.ctx.organizationId, s.ctx.tenderId);
    expect((await s.cron()).status).toBe(200);
    const mias = s.emisiones.filter((e) => e.organizationId === s.ctx.organizationId);
    const renovacion = mias.filter((e) => e.evento === "licitaciones.renovacion.por_vencer");
    const cobranza = mias.filter((e) => e.evento === "licitaciones.cobranza.factura_vencida");
    expect(renovacion).toHaveLength(1);
    expect(renovacion[0]).toMatchObject({ categoria: "operacion", severidad: "atencion", enlace: "/licitaciones/{orgSlug}/radar-renovaciones", roles: ["analyst"] });
    expect(renovacion[0]!.cuerpo).toMatch(/^Alertas de renovación nuevas: [1-9]\d*\.$/);
    expect(renovacion[0]!.dedupeKey).toBe(`licitaciones.renovacion.por_vencer:${s.ctx.organizationId}:${hoy()}`);
    expect(cobranza).toHaveLength(1);
    expect(cobranza[0]).toMatchObject({ categoria: "cobranza", cuerpo: "Facturas vencidas: 1." });
    expect(cobranza[0]!.dedupeKey).toBe(`licitaciones.cobranza.factura_vencida:${s.ctx.organizationId}:${inicioDeSemana(hoy())}`);
    expect(JSON.stringify(mias)).not.toContain("secreto");

    // Segunda corrida: el motor ya no crea alertas de renovacion (no hay evento nuevo); la factura sigue vencida y su aviso
    // reutiliza la clave semanal, que la base deduplica (core.emit_notification) -- aqui se comprueba la clave estable.
    s.emisiones.length = 0;
    expect((await s.cron()).status).toBe(200);
    expect(s.emisiones.filter((e) => e.evento === "licitaciones.renovacion.por_vencer")).toHaveLength(0);
    const otra = s.emisiones.filter((e) => e.evento === "licitaciones.cobranza.factura_vencida");
    expect(otra.map((e) => e.dedupeKey)).toEqual([cobranza[0]!.dedupeKey]);
  });

  it("aislamiento entre organizaciones: cada aviso lleva SU organizacion y su propia clave de dedupe", async () => {
    const s = await setup();
    s.ctx.repo.seedOrganization({ id: ORG_B, slug: "org-b-avisos", name: "Org B" });
    const tenderB = "00000000-0000-0000-0000-00000000bb03";
    s.ctx.repo.seedTender({ id: tenderB, organizationId: ORG_B, title: "Convocatoria B", submissionDeadline: null, updatedAt: new Date().toISOString() });
    await s.sembrarContrato(s.ctx.organizationId, s.ctx.tenderId);
    await s.sembrarContrato(ORG_B, tenderB);
    expect((await s.cron()).status).toBe(200);
    const cobranza = s.emisiones.filter((e) => e.evento === "licitaciones.cobranza.factura_vencida");
    expect(cobranza.map((e) => e.organizationId).sort()).toEqual([s.ctx.organizationId, ORG_B].sort());
    for (const e of cobranza) expect(e.dedupeKey).toContain(e.organizationId!);
    expect(new Set(cobranza.map((e) => e.dedupeKey)).size).toBe(2);
  });

  it("sin renovaciones ni facturas vencidas no emite nada", async () => {
    const s = await setup();
    expect((await s.cron()).status).toBe(200);
    expect(s.emisiones.filter((e) => /renovacion|cobranza/.test(e.evento))).toHaveLength(0);
  });

  it("documentos de empresa por vencer: emite el conteo con clave semanal; sin documentos o sin migracion 034 (null) no emite", async () => {
    const con = await setup({ documentos: () => 2 });
    expect((await con.cron()).status).toBe(200);
    const docs = con.emisiones.filter((e) => e.evento === "licitaciones.documentos.por_vencer");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ cuerpo: "Documentos aprobados por vencer (incluye la opinión 32-D si está registrada): 2.", enlace: "/licitaciones/{orgSlug}/datos-empresa", roles: ["analyst", "writer"] });
    expect(docs[0]!.dedupeKey).toBe(`licitaciones.documentos.por_vencer:${con.ctx.organizationId}:${inicioDeSemana(hoy())}`);

    for (const n of [0, null]) {
      const sin = await setup({ documentos: () => n });
      expect((await sin.cron()).status).toBe(200);
      expect(sin.emisiones.filter((e) => e.evento === "licitaciones.documentos.por_vencer")).toHaveLength(0);
    }
  });

  it("poder de firmante por vencer (L-P3-04): emite el conteo con clave semanal y enlace a la pestana de firmantes; sin poderes o sin migracion 040 (null) no emite; un error no rompe el barrido", async () => {
    const con = await setup({ poderes: () => 3 });
    expect((await con.cron()).status).toBe(200);
    const poderes = con.emisiones.filter((e) => e.evento === "licitaciones.firmante.poder_por_vencer");
    expect(poderes).toHaveLength(1);
    expect(poderes[0]).toMatchObject({ categoria: "operacion", severidad: "atencion", enlace: "/licitaciones/{orgSlug}/datos-empresa?tab=firmantes", roles: ["analyst", "writer"] });
    expect(poderes[0]!.cuerpo).toContain("por vencer: 3.");
    expect(poderes[0]!.dedupeKey).toBe(`licitaciones.firmante.poder_por_vencer:${con.ctx.organizationId}:${inicioDeSemana(hoy())}`);
    // sin nombres ni ids de firmantes: solo el conteo
    expect(JSON.stringify(poderes)).not.toMatch(/Ana|firmante-/);

    for (const n of [0, null]) {
      const sin = await setup({ poderes: () => n });
      expect((await sin.cron()).status).toBe(200);
      expect(sin.emisiones.filter((e) => e.evento === "licitaciones.firmante.poder_por_vencer")).toHaveLength(0);
    }
    const roto = await setup({ poderes: () => Object.assign(new Error("boom"), { code: "XX000" }), documentos: () => 1 });
    const res = await roto.cron();
    expect(res.status).toBe(200);
    expect(roto.emisiones.some((e) => e.evento === "licitaciones.documentos.por_vencer")).toBe(true);
  });

  it("un error de Postgres al contar documentos o al emitir deja el barrido intacto (200, ok) y no arrastra los demas avisos", async () => {
    const roto = await setup({ documentos: () => Object.assign(new Error("boom"), { code: "XX000" }) });
    await roto.sembrarContrato(roto.ctx.organizationId, roto.ctx.tenderId);
    const res = await roto.cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(roto.emisiones.some((e) => e.evento === "licitaciones.cobranza.factura_vencida")).toBe(true);

    const sinMigrar = await setup({ alEmitir: errorSinMigrar, documentos: () => 1 });
    await sinMigrar.sembrarContrato(sinMigrar.ctx.organizationId, sinMigrar.ctx.tenderId);
    const res2 = await sinMigrar.cron();
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ ok: true, deadline_reminders_created: 0 });
  });
});

describe("licitaciones.convocatoria.bases_modificadas (L-30)", () => {
  async function setup(opciones: { alEmitir?: () => number } = {}) {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps, opciones);
    const app = buildApp(deps);
    const alta = (budgetAmount: number, token = ctx.staff.writer.token) =>
      app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(token, { title: "Convocatoria con cambios", externalId: "LA-30/2026", budgetAmount }));
    return { ctx, app, emisiones, alta };
  }

  it("el alta (version 1) y un reenvio idéntico NO emiten; un cambio real de bases emite UNA con clave convocatoria + version", async () => {
    const s = await setup();
    const creada = await s.alta(100_000);
    const { id: tenderId } = (await creada.json()) as { id: string };
    expect(s.emisiones.filter((e) => e.evento === "licitaciones.convocatoria.bases_modificadas")).toHaveLength(0);

    await s.alta(100_000);
    expect(s.emisiones.filter((e) => e.evento === "licitaciones.convocatoria.bases_modificadas")).toHaveLength(0);

    expect((await s.alta(300_000)).status).toBe(200);
    const avisos = s.emisiones.filter((e) => e.evento === "licitaciones.convocatoria.bases_modificadas");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ organizationId: s.ctx.organizationId, categoria: "operacion", severidad: "atencion", enlace: "/licitaciones/{orgSlug}/seguimiento", roles: ["analyst", "writer", "reviewer"] });
    expect(avisos[0]!.dedupeKey).toBe(`licitaciones.convocatoria.bases_modificadas:${tenderId}:v2`);
    expect(JSON.stringify(avisos[0])).not.toContain("Convocatoria con cambios");

    // Repetir el MISMO cambio ya no crea version: no hay aviso nuevo.
    await s.alta(300_000);
    expect(s.emisiones.filter((e) => e.evento === "licitaciones.convocatoria.bases_modificadas")).toHaveLength(1);
  });

  it("un recalculo manual sin cambios no emite; tras un cambio que no paso por el alta (re-extraccion) el recalculo si", async () => {
    const s = await setup();
    const { id: tenderId } = (await (await s.alta(100_000)).json()) as { id: string };
    const recompute = () => s.app.request(`/licitaciones/${s.ctx.propertyId}/tenders/${tenderId}/versions/recompute`, authedJson(s.ctx.staff.writer.token, {}));
    expect((await recompute()).status).toBe(200);
    expect(s.emisiones).toHaveLength(0);

    // Un requisito nuevo cambia el snapshot sin pasar por el alta: el recalculo crea la v2 y avisa.
    await s.ctx.repo.replaceRequirementItems(s.ctx.organizationId, tenderId, [
      {
        id: "11111111-1111-4111-8111-111111111111",
        documentId: "bases",
        text: "Acta constitutiva certificada",
        requirementKind: "legal",
        obligatoriedad: "obligatorio",
        topicKey: null,
        requiredEvidence: [],
        extractedBy: "rule",
        page: 1,
        clause: "5.1",
        responsibleRole: "writer",
        deadline: null,
        status: "pendiente",
        confidence: 0.9,
      },
    ]);
    expect((await recompute()).status).toBe(201);
    const avisos = s.emisiones.filter((e) => e.evento === "licitaciones.convocatoria.bases_modificadas");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.dedupeKey).toBe(`licitaciones.convocatoria.bases_modificadas:${tenderId}:v2`);
  });

  it("una emision que falla (base sin migrar) no cambia la respuesta ni la escritura", async () => {
    const s = await setup({ alEmitir: errorSinMigrar });
    await s.alta(100_000);
    const res = await s.alta(250_000);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { budgetAmount: number }).budgetAmount).toBe(250_000);
  });
});

describe("licitaciones.kyc.proveedor_empeoro: re-tamizado de la cartera (L-32)", () => {
  const ORG_A = "00000000-0000-0000-0000-00000000aa01";
  function setupRetamizado(resultados: KycRetamizadoResultado[], opciones: { alEmitir?: () => number } = {}) {
    return buildLicitacionesTestContext(buildApp).then((ctx) => {
      const base = conEmisiones(ctx.deps, opciones);
      let llamada = 0;
      const avisos: AvisosSistemaRepository = {
        retamizarCarteraKyc: async () => resultados[Math.min(llamada++, resultados.length - 1)]!,
        contarDocumentosPorVencer: async () => 0,
        contarPoderesPorVencer: async () => 0,
      };
      const app = buildApp({ ...base.deps, licitacionesAvisosRepo: () => avisos });
      const run = (headers: Record<string, string> = { "x-atiende-internal-secret": ctx.deps.env.internalSecret }) => app.request("/internal/licitaciones/kyc-69b/retamizar", { method: "POST", headers });
      return { ctx, emisiones: base.emisiones, run };
    });
  }
  const org = (id: string, evaluadas: number, empeoradas: number, proveedoresEmpeorados: number) => ({ organizationId: id, periodo: "2024-06", evaluadas, empeoradas, proveedoresEmpeorados });

  it("rechaza sin el secreto interno", async () => {
    const s = await setupRetamizado([{ disponible: true, organizaciones: [] }]);
    expect((await s.run({})).status).toBe(401);
  });

  it("emite UNA alerta por organizacion con proveedores que empeoraron (solo conteo), con clave organizacion + edicion; competidores o sin empeoramiento no alertan", async () => {
    const s = await setupRetamizado([{ disponible: true, organizaciones: [org(ORG_A, 4, 3, 2), org(ORG_B, 5, 1, 0), org("00000000-0000-0000-0000-00000000cc03", 2, 0, 0)] }]);
    const res = await s.run();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disponible: true, organizaciones: 3, fichas_evaluadas: 11, alertas_emitidas: 1 });
    expect(s.emisiones).toHaveLength(1);
    expect(s.emisiones[0]).toMatchObject({
      evento: "licitaciones.kyc.proveedor_empeoro",
      organizationId: ORG_A,
      categoria: "fiscal",
      severidad: "critica",
      cuerpo: "Proveedores cuyo semáforo empeoró en la edición nueva: 2.",
      enlace: "/licitaciones/{orgSlug}/kyc-69b",
      roles: ["analyst", "reviewer"],
    });
    expect(s.emisiones[0]!.dedupeKey).toBe(`licitaciones.kyc.proveedor_empeoro:${ORG_A}:2024-06`);
  });

  it("si nada cambio (la funcion ya no devuelve filas) no alerta; repetir la ruta no duplica", async () => {
    const s = await setupRetamizado([{ disponible: true, organizaciones: [org(ORG_A, 4, 3, 2)] }, { disponible: true, organizaciones: [] }]);
    expect((await s.run()).status).toBe(200);
    expect((await s.run()).status).toBe(200);
    expect(s.emisiones).toHaveLength(1);
  });

  it("base sin la migracion 034: responde ok con disponible=false y no emite nada", async () => {
    const s = await setupRetamizado([{ disponible: false, organizaciones: [] }]);
    const res = await s.run();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disponible: false, alertas_emitidas: 0 });
    expect(s.emisiones).toHaveLength(0);
  });

  it("sin repositorio cableado (ambiente sin base) responde disponible=false", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const res = await buildApp(ctx.deps).request("/internal/licitaciones/kyc-69b/retamizar", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disponible: false });
  });

  it("un aviso que no se pudo emitir responde 503 para que se reintente (la transaccion revierte la evaluacion)", async () => {
    const s = await setupRetamizado([{ disponible: true, organizaciones: [org(ORG_A, 1, 1, 1)] }], { alEmitir: errorSinMigrar });
    expect((await s.run()).status).toBe(503);
  });
});

describe("inicioDeSemana", () => {
  it("devuelve el lunes de la semana (estable toda la semana, cambia al lunes siguiente)", () => {
    expect(inicioDeSemana("2026-10-05")).toBe("2026-10-05"); // lunes
    expect(inicioDeSemana("2026-10-08")).toBe("2026-10-05");
    expect(inicioDeSemana("2026-10-11")).toBe("2026-10-05"); // domingo
    expect(inicioDeSemana("2026-10-12")).toBe("2026-10-12");
  });
});
