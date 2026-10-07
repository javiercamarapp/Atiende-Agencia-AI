// paridad3 L-P3-09 -- regla de "nuevo match": umbral por organizacion, elegibilidad, plazo y dedupe. Sin red ni reloj real.
import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { evaluateNewMatch } from "../src/new-match.ts";
import type { NewMatchContext } from "../src/new-match.ts";
import type { MatchingProfileRecord, TenderRecord } from "../src/types.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "org-1";
const AHORA = new Date("2026-10-07T12:00:00Z");

const perfil = (over: Partial<MatchingProfileRecord> = {}): MatchingProfileRecord => ({
  organizationId: ORG,
  keywords: ["limpieza"],
  excludedKeywords: [],
  classifierCodes: [],
  entities: [],
  states: ["Jalisco"],
  budgetMin: null,
  budgetMax: null,
  updatedBy: null,
  updatedAt: "",
  ...over,
});

const tender = (over: Partial<TenderRecord> = {}): TenderRecord => ({
  id: "t-1",
  organizationId: ORG,
  title: "Servicio de limpieza integral",
  submissionDeadline: "2026-11-01T18:00:00-06:00",
  updatedAt: "2026-10-07T00:00:00Z",
  source: "compras_mx_historico",
  externalId: "x",
  contractingBody: "Municipio",
  cpvCodes: [],
  budgetAmount: 100_000,
  currency: "MXN",
  state: "Jalisco",
  procedureTypeRaw: null,
  status: "discovered",
  ...over,
});

const ctx = (over: Partial<NewMatchContext> = {}): NewMatchContext => ({ minScore: null, profile: perfil(), ...over });

describe("evaluateNewMatch", () => {
  it("sin umbral: avisa solo las ELEGIBLES (cumplen los requisitos duros del perfil)", () => {
    const ok = evaluateNewMatch(tender(), ctx(), AHORA);
    expect(ok).toMatchObject({ notify: true, eligible: true, skipReason: null });
    expect(ok.score).toBeGreaterThan(0);
    // fuera de los estados donde opera la organizacion: no cumple -> no avisa
    expect(evaluateNewMatch(tender({ state: "Oaxaca" }), ctx(), AHORA)).toMatchObject({ notify: false, skipReason: "no_cumple" });
  });

  it("con umbral: avisa si la puntuacion lo alcanza y no incumple un requisito duro; no avisa bajo el umbral", () => {
    const score = evaluateNewMatch(tender(), ctx(), AHORA).score;
    expect(evaluateNewMatch(tender(), ctx({ minScore: score }), AHORA).notify).toBe(true);
    // misma elegibilidad (estado correcto) pero sin afinidad con las palabras clave: la puntuacion queda bajo el umbral
    const lejana = evaluateNewMatch(tender({ title: "Compra de papeleria" }), ctx({ minScore: 90 }), AHORA);
    expect(lejana.score).toBeLessThan(90);
    expect(lejana).toMatchObject({ notify: false, skipReason: "bajo_umbral" });
    // aun con umbral 0, un requisito duro incumplido NUNCA avisa
    expect(evaluateNewMatch(tender({ state: "Oaxaca" }), ctx({ minScore: 0 }), AHORA)).toMatchObject({ notify: false, skipReason: "no_cumple" });
  });

  it("umbral 0 avisa una convocatoria sin incumplimientos aunque no sea 'elegible' del todo", () => {
    // perfil solo con palabras clave: elegibilidad no_evaluable (no hay requisito duro configurado), pero sin umbral NO avisa y con umbral 0 SI
    const soloPalabras = perfil({ states: [] });
    expect(evaluateNewMatch(tender(), ctx({ profile: soloPalabras }), AHORA)).toMatchObject({ notify: false, skipReason: "no_elegible" });
    expect(evaluateNewMatch(tender(), ctx({ profile: soloPalabras, minScore: 0 }), AHORA).notify).toBe(true);
  });

  it("sin plazo conocido, con plazo vencido o sin perfil NO avisa (nunca se fabrica un plazo)", () => {
    expect(evaluateNewMatch(tender({ submissionDeadline: null }), ctx(), AHORA)).toMatchObject({ notify: false, skipReason: "sin_plazo" });
    expect(evaluateNewMatch(tender({ submissionDeadline: "basura" }), ctx(), AHORA)).toMatchObject({ notify: false, skipReason: "sin_plazo" });
    expect(evaluateNewMatch(tender({ submissionDeadline: "2026-10-01T00:00:00Z" }), ctx(), AHORA)).toMatchObject({ notify: false, skipReason: "plazo_vencido" });
    expect(evaluateNewMatch(tender({ submissionDeadline: AHORA.toISOString() }), ctx(), AHORA)).toMatchObject({ notify: false, skipReason: "plazo_vencido" });
    expect(evaluateNewMatch(tender(), ctx({ profile: null }), AHORA)).toMatchObject({ notify: false, skipReason: "sin_perfil" });
  });
});

describe("InMemoryLicitacionesRepository -- avisos de nuevo match", () => {
  it("dedupe por organizacion y convocatoria: la primera vez true, la segunda false; la lista sale por puntuacion", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const a = await repo.ingestTendersFromSource(ORG, "compras_mx_historico", [
      { externalId: "a", title: "A", submissionDeadline: null, contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", state: null, procedureTypeRaw: null },
      { externalId: "b", title: "B", submissionDeadline: null, contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", state: null, procedureTypeRaw: null },
    ]);
    const [ta, tb] = a.tenders;
    expect(await repo.recordNewMatch(ORG, ta!.id, { score: 60, eligible: true })).toBe(true);
    expect(await repo.recordNewMatch(ORG, ta!.id, { score: 99, eligible: true })).toBe(false);
    expect(await repo.recordNewMatch(ORG, tb!.id, { score: 80, eligible: false })).toBe(true);
    const lista = await repo.listNewMatches(ORG, "2000-01-01T00:00:00Z", 10);
    expect(lista!.map((n) => [n.tenderId, n.score, n.tenderTitle])).toEqual([[tb!.id, 80, "B"], [ta!.id, 60, "A"]]);
    expect(await repo.listNewMatches(ORG, "2999-01-01T00:00:00Z", 10)).toEqual([]);
  });

  it("cross-tenant: no se puede registrar un aviso sobre la convocatoria de otra organizacion", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const r = await repo.ingestTendersFromSource(ORG, "compras_mx_historico", [{ externalId: "a", title: "A", submissionDeadline: null, contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", state: null, procedureTypeRaw: null }]);
    await expect(repo.recordNewMatch("org-2", r.tenders[0]!.id, { score: 50, eligible: true })).rejects.toThrow(/no pertenece/);
  });

  it("el contexto trae umbral y perfil de la organizacion", async () => {
    const repo = new InMemoryLicitacionesRepository();
    repo.setNewMatchMinScoreForTests(ORG, 70);
    await repo.upsertMatchingProfile(ORG, { keywords: ["x"], excludedKeywords: [], classifierCodes: [], entities: [], states: [], budgetMin: null, budgetMax: null, actorId: "u" });
    const c = await repo.getNewMatchContext(ORG);
    expect(c!.minScore).toBe(70);
    expect(c!.profile!.keywords).toEqual(["x"]);
    expect((await repo.getNewMatchContext("otra"))!.profile).toBeNull();
  });
});

describe("PostgresLicitacionesRepository -- nuevo match contra la base SIN la migracion 039 (AbortAwareFakeSession)", () => {
  const sinMigrar = (fn: string) => Object.assign(new Error(`function licitaciones.${fn}(uuid) does not exist`), { code: "42883" });

  it.each([
    ["getNewMatchContext", /system_get_new_match_context/, (r: PostgresLicitacionesRepository) => r.getNewMatchContext(ORG)],
    ["recordNewMatch", /system_record_new_match/, (r: PostgresLicitacionesRepository) => r.recordNewMatch(ORG, "t", { score: 1, eligible: true })],
    ["listNewMatches", /system_list_new_matches/, (r: PostgresLicitacionesRepository) => r.listNewMatches(ORG, "2026-01-01T00:00:00Z", 5)],
  ])("%s: 42883 degrada a null con SAVEPOINT y deja la sesion utilizable", async (_n, match, llamar) => {
    const session = new AbortAwareFakeSession([
      { match, respond: () => sinMigrar(String(match).replace(/[\/]/g, "")) },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    expect(await llamar(new PostgresLicitacionesRepository(session))).toBeNull();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("base migrada: arma el contexto con el perfil y el umbral; sin perfil el contexto lo declara", async () => {
    const conPerfil = new AbortAwareFakeSession([
      {
        match: /system_get_new_match_context/,
        respond: () => [{ out_min_score: 65, out_has_profile: true, out_keywords: ["a"], out_excluded_keywords: [], out_classifier_codes: [], out_entities: [], out_states: ["Jalisco"], out_budget_min: "1000", out_budget_max: null }],
      },
    ]);
    const c = await new PostgresLicitacionesRepository(conPerfil).getNewMatchContext(ORG);
    expect(c).toMatchObject({ minScore: 65, profile: { keywords: ["a"], states: ["Jalisco"], budgetMin: 1000, budgetMax: null } });
    const sinPerfil = new AbortAwareFakeSession([{ match: /system_get_new_match_context/, respond: () => [{ out_min_score: null, out_has_profile: false, out_keywords: [], out_excluded_keywords: [], out_classifier_codes: [], out_entities: [], out_states: [], out_budget_min: null, out_budget_max: null }] }]);
    expect(await new PostgresLicitacionesRepository(sinPerfil).getNewMatchContext(ORG)).toEqual({ minScore: null, profile: null });
  });
});

describe("tenant_config con el umbral (L-P3-09) contra la base SIN la migracion 039", () => {
  const sinColumna = Object.assign(new Error('column "new_match_min_score" does not exist'), { code: "42703" });

  it("leer: sin la columna cae a la zona horaria de la 027 (umbral null) y la sesion sigue utilizable", async () => {
    let n = 0;
    const session = new AbortAwareFakeSession([
      { match: /select timezone, new_match_min_score/, respond: () => sinColumna },
      { match: /select timezone from licitaciones.tenant_config/, respond: () => (++n, [{ timezone: "America/Tijuana" }]) },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    expect(await new PostgresLicitacionesRepository(session).findTenantConfig(ORG)).toEqual({ organizationId: ORG, timezone: "America/Tijuana", newMatchMinScore: null });
    expect(n).toBe(1);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("leer: sin tabla (ni la 027) el vacio honesto", async () => {
    const sinTabla = Object.assign(new Error('relation "licitaciones.tenant_config" does not exist'), { code: "42P01" });
    const session = new AbortAwareFakeSession([{ match: /tenant_config/, respond: () => sinTabla }]);
    expect(await new PostgresLicitacionesRepository(session).findTenantConfig(ORG)).toEqual({ organizationId: ORG, timezone: null, newMatchMinScore: null });
  });

  it("guardar el umbral sin la columna lanza TenantConfigNotMigratedError; guardar SOLO la zona usa la sentencia de siempre (sin la columna nueva)", async () => {
    const { TenantConfigNotMigratedError } = await import("../src/errors.ts");
    const conUmbral = new AbortAwareFakeSession([{ match: /new_match_min_score/, respond: () => sinColumna }]);
    await expect(new PostgresLicitacionesRepository(conUmbral).upsertTenantConfig(ORG, { newMatchMinScore: 60 })).rejects.toBeInstanceOf(TenantConfigNotMigratedError);

    const soloZona = new AbortAwareFakeSession([{ match: /insert into licitaciones.tenant_config \(organization_id, timezone\) values/, respond: () => [{ timezone: "America/Tijuana" }] }]);
    expect(await new PostgresLicitacionesRepository(soloZona).upsertTenantConfig(ORG, { timezone: "America/Tijuana" })).toMatchObject({ timezone: "America/Tijuana" });
    expect(soloZona.calls.some((c) => c.includes("new_match_min_score"))).toBe(false);
  });
});
