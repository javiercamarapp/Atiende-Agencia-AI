// paridad3 L-P3-08 / L-P3-09 -- el cron de descubrimiento con fuentes FALSAS (sin red): avisa el cambio de bases de una convocatoria
// conocida (campana + correo + aprobacion invalidada), emite el nuevo match con dedupe, respeta el umbral de la organizacion, no
// avisa convocatorias sin plazo/vencidas/no elegibles, manda WhatsApp solo con opt-in y NUNCA pierde la version ni la
// invalidacion cuando un canal falla. Repositorio real en memoria (mismas reglas que la base); la RLS real se prueba en
// scripts/verify-licitaciones-autopiloto/ contra Postgres.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LICITACIONES_CONNECTOR_REGISTRY, sealInputs } from "@atiende/domain-licitaciones";
import type { LicitacionesSourceConnector, SourceConnectorId, TenderSourceIngestCandidate } from "@atiende/domain-licitaciones";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const SOURCE: SourceConnectorId = "yucatan_ocds";
const RUTA = "/internal/licitaciones/discover-tenders";

// Reloj FIJO por archivo: un plazo que cambia entre corridas por usar Date.now() seria (con razon) un cambio de bases.
const AHORA_MS = Date.now();
function proximo(dias: number): string {
  return new Date(AHORA_MS + dias * 86_400_000).toISOString();
}

const candidato = (over: Partial<TenderSourceIngestCandidate> = {}): TenderSourceIngestCandidate => ({
  externalId: "ocds-1",
  title: "Servicio de limpieza integral",
  submissionDeadline: proximo(20),
  contractingBody: "Municipio de prueba",
  cpvCodes: [],
  budgetAmount: 100_000,
  currency: "MXN",
  state: "Yucatan",
  procedureTypeRaw: null,
  ...over,
});

function usarFuente(candidates: () => TenderSourceIngestCandidate[]) {
  const real = LICITACIONES_CONNECTOR_REGISTRY.all();
  const connector: LicitacionesSourceConnector = {
    id: SOURCE,
    async *discover() {
      for (const c of candidates()) yield c;
    },
    fetchDetail: () => Promise.reject(new Error("n/a")),
  };
  vi.spyOn(LICITACIONES_CONNECTOR_REGISTRY, "all").mockReturnValue(real.map((d) => (d.id === SOURCE ? { ...d, connector } : { ...d, connector: undefined })));
}

afterEach(() => vi.restoreAllMocks());

async function armar(opts: { alEmitir?: () => number; perfil?: boolean; umbral?: number | null } = {}) {
  const ctx = await buildLicitacionesTestContext(buildApp);
  ctx.repo.seedNotificationRecipient(ctx.organizationId, { email: "dueno@example.com", fullName: "Dueno" });
  if (opts.perfil !== false) {
    await ctx.repo.upsertMatchingProfile(ctx.organizationId, { keywords: ["limpieza"], excludedKeywords: [], classifierCodes: [], entities: [], states: ["Yucatan"], budgetMin: null, budgetMax: null, actorId: ctx.staff.owner.id });
  }
  if (opts.umbral !== undefined) ctx.repo.setNewMatchMinScoreForTests(ctx.organizationId, opts.umbral);
  const { deps, emisiones } = conEmisiones(ctx.deps, opts.alEmitir ? { alEmitir: opts.alEmitir } : {});
  const app = buildApp(deps);
  const correr = async () => {
    const res = await app.request(RUTA, { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    return { res, body: (await res.json()) as Record<string, any> };
  };
  const tipos = (e: string) => emisiones.filter((x) => x.evento === e);
  return { ctx, emisiones, correr, tipos };
}

describe("cron de descubrimiento: cambio de bases (L-P3-08)", () => {
  it("la primera corrida es linea base (sin aviso de cambio); un cambio de plazo avisa en campana y por correo y deja la version y la invalidacion", async () => {
    const t = await armar();
    let actual = candidato();
    usarFuente(() => [actual]);

    await t.correr();
    expect(t.tipos("licitaciones.convocatoria.bases_modificadas")).toHaveLength(0);
    const [tender] = (await t.ctx.repo.listTenders(t.ctx.organizationId)).filter((x) => x.source === SOURCE);
    const proposal = await t.ctx.repo.getOrCreateProposal(t.ctx.organizationId, tender!.id, t.ctx.staff.owner.id, "Propuesta");
    await t.ctx.repo.approve(t.ctx.organizationId, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: t.ctx.staff.owner.id, actorRole: "owner", inputsHash: sealInputs({ tenderVersionHash: "x", companyProfileHash: "y", companyDocuments: [], rates: [], templates: [] }) });

    actual = candidato({ submissionDeadline: proximo(40) });
    const { res, body } = await t.correr();

    expect(res.status).toBe(200);
    expect(body.autopiloto).toMatchObject({ cambiosDeBases: 1, avisosAprobacionInvalidada: 1, correosCambioDeBases: 1, errores: 0 });
    expect(await t.ctx.repo.listTenderVersions(t.ctx.organizationId, tender!.id)).toHaveLength(2);
    expect(await t.ctx.repo.activeApprovalsCovering(t.ctx.organizationId, proposal.id, "expediente")).toHaveLength(0);

    const [aviso] = t.tipos("licitaciones.convocatoria.bases_modificadas");
    expect(aviso).toMatchObject({ organizationId: t.ctx.organizationId, severidad: "atencion", dedupeKey: `licitaciones.convocatoria.bases_modificadas:${tender!.id}:v2` });
    expect(aviso!.titulo + (aviso!.cuerpo ?? "")).not.toMatch(/limpieza|Municipio/i); // sin PII ni titulos en la campana
    expect(t.tipos("licitaciones.expediente.aprobacion_invalidada")[0]).toMatchObject({ dedupeKey: `licitaciones.expediente.aprobacion_invalidada:${tender!.id}:v2`, enlace: `/licitaciones/{orgSlug}/convocatorias/${tender!.id}/cierre` });

    const correos = t.ctx.repo.getMessagingOutbox().filter((o) => o.eventType === "tender.bases_modificadas");
    expect(correos).toHaveLength(1);
    expect(correos[0]!.payload).toMatchObject({ to: "dueno@example.com" });
    expect(String(correos[0]!.payload.subject)).toContain("Servicio de limpieza integral");
    expect(String(correos[0]!.payload.html)).toContain("Plazo de presentación");
  });

  it("reprocesar la MISMA version es idempotente: ni avisos ni correos nuevos", async () => {
    const t = await armar();
    let actual = candidato();
    usarFuente(() => [actual]);
    await t.correr();
    actual = candidato({ budgetAmount: 999 });
    await t.correr();
    const antes = t.emisiones.length;
    const correosAntes = t.ctx.repo.getMessagingOutbox().length;
    const { body } = await t.correr();
    expect(body.autopiloto).toMatchObject({ cambiosDeBases: 0, correosCambioDeBases: 0 });
    expect(t.emisiones).toHaveLength(antes);
    expect(t.ctx.repo.getMessagingOutbox()).toHaveLength(correosAntes);
  });

  it("si la campana falla (base sin migrar) la version y la invalidacion se CONSERVAN y el cron responde 200", async () => {
    const t = await armar({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    let actual = candidato();
    usarFuente(() => [actual]);
    await t.correr();
    const [tender] = (await t.ctx.repo.listTenders(t.ctx.organizationId)).filter((x) => x.source === SOURCE);
    actual = candidato({ submissionDeadline: proximo(60) });
    const { res } = await t.correr();
    expect(res.status).toBe(200);
    expect(await t.ctx.repo.listTenderVersions(t.ctx.organizationId, tender!.id)).toHaveLength(2);
  });
});

describe("cron de descubrimiento: nuevo match (L-P3-09)", () => {
  it("una convocatoria NUEVA elegible avisa en campana (solo la puntuacion), por correo y deja el registro; repetir el cron no duplica", async () => {
    const t = await armar();
    usarFuente(() => [candidato()]);
    const { body } = await t.correr();
    expect(body.autopiloto).toMatchObject({ nuevosMatches: 1, avisosNuevoMatch: 1, correosNuevoMatch: 1, errores: 0 });

    const [e] = t.tipos("licitaciones.convocatoria.nuevo_match");
    expect(e).toMatchObject({ organizationId: t.ctx.organizationId, severidad: "info", roles: ["analyst", "writer"] });
    expect(e!.cuerpo).toMatch(/Puntuación de afinidad: \d+ de 100/);
    expect(e!.titulo + e!.cuerpo).not.toMatch(/limpieza|Municipio/i);
    const correo = t.ctx.repo.getMessagingOutbox().find((o) => o.eventType === "tender.nuevo_match")!;
    expect(String(correo.payload.subject)).toContain("Servicio de limpieza integral");

    const antes = t.emisiones.length;
    await t.correr(); // la convocatoria ya no es nueva: ni registro ni avisos
    expect(t.emisiones).toHaveLength(antes);
    expect(t.ctx.repo.getMessagingOutbox().filter((o) => o.eventType === "tender.nuevo_match")).toHaveLength(1);
  });

  it("no avisa: sin perfil, sin plazo, plazo vencido, no elegible (estado distinto) ni bajo el umbral", async () => {
    const sinPerfil = await armar({ perfil: false });
    usarFuente(() => [candidato()]);
    expect((await sinPerfil.correr()).body.autopiloto).toMatchObject({ nuevosMatches: 0 });

    const t = await armar();
    usarFuente(() => [candidato({ externalId: "a", submissionDeadline: null }), candidato({ externalId: "b", submissionDeadline: "2020-01-01T00:00:00Z" }), candidato({ externalId: "c", state: "Oaxaca" })]);
    const { body } = await t.correr();
    expect(body.autopiloto).toMatchObject({ nuevosMatches: 0, avisosNuevoMatch: 0 });
    expect(t.tipos("licitaciones.convocatoria.nuevo_match")).toHaveLength(0);

    const alto = await armar({ umbral: 100 });
    usarFuente(() => [candidato({ title: "Compra de papeleria" })]);
    expect((await alto.correr()).body.autopiloto).toMatchObject({ nuevosMatches: 0 });
  });

  it("respeta el umbral de la organizacion: con umbral 0 avisa una convocatoria que sin umbral no (perfil sin requisitos duros)", async () => {
    const soloPalabras = async (umbral: number | null) => {
      const t = await armar({ perfil: false, umbral });
      await t.ctx.repo.upsertMatchingProfile(t.ctx.organizationId, { keywords: ["limpieza"], excludedKeywords: [], classifierCodes: [], entities: [], states: [], budgetMin: null, budgetMax: null, actorId: t.ctx.staff.owner.id });
      return t;
    };
    usarFuente(() => [candidato()]);
    expect((await (await soloPalabras(null)).correr()).body.autopiloto).toMatchObject({ nuevosMatches: 0 });
    usarFuente(() => [candidato()]);
    expect((await (await soloPalabras(0)).correr()).body.autopiloto).toMatchObject({ nuevosMatches: 1 });
  });

  it("en la campana salen solo las mejores 5 (una por convocatoria); el correo es UNO por organizacion con el total", async () => {
    const t = await armar();
    usarFuente(() => Array.from({ length: 8 }, (_, i) => candidato({ externalId: `m-${i}`, title: `Servicio de limpieza ${i}` })));
    const { body } = await t.correr();
    expect(body.autopiloto).toMatchObject({ nuevosMatches: 8, avisosNuevoMatch: 5, correosNuevoMatch: 1 });
    expect(t.tipos("licitaciones.convocatoria.nuevo_match")).toHaveLength(5);
    const correo = t.ctx.repo.getMessagingOutbox().find((o) => o.eventType === "tender.nuevo_match")!;
    expect(String(correo.payload.subject)).toContain("8 convocatorias");
  });

  it("base sin la migracion 039: el nuevo match se declara no disponible y el cron sigue en 200 sin perder la ingesta", async () => {
    const t = await armar();
    vi.spyOn(t.ctx.repo, "getNewMatchContext").mockResolvedValue(null);
    usarFuente(() => [candidato()]);
    const { res, body } = await t.correr();
    expect(res.status).toBe(200);
    expect(body.autopiloto).toMatchObject({ matchNoDisponible: 1, nuevosMatches: 0 });
    expect((await t.ctx.repo.listTenders(t.ctx.organizationId)).some((x) => x.source === SOURCE)).toBe(true);
  });

  it("un canal que lanza (correo) no revierte el registro del match ni la campana", async () => {
    const t = await armar();
    vi.spyOn(t.ctx.repo, "enqueueMessagingOutbox").mockRejectedValue(new Error("outbox caido"));
    const consola = vi.spyOn(console, "error").mockImplementation(() => undefined);
    usarFuente(() => [candidato()]);
    const { body } = await t.correr();
    expect(body.autopiloto).toMatchObject({ nuevosMatches: 1, avisosNuevoMatch: 1, correosNuevoMatch: 0 });
    expect((await t.ctx.repo.listNewMatches(t.ctx.organizationId, "2000-01-01T00:00:00Z", 10))!).toHaveLength(1);
    consola.mockRestore();
  });
});
