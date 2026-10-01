// POST /licitaciones/:propertyId/chat-datos — "Chatea con tus datos" (licitaciones). HTTP real via app.request:
// auth, roles, aislamiento cross-tenant, validacion de cuerpo, rate limit, tope de presupuesto, bitacora, zona
// horaria del negocio y compatibilidad con la base sin migrar. El LLM es un guion: ningun test toca la red.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scriptedCompletion, type DataChatAnswer, type DataChatAuditEntry, type DataChatCompletion, type DataChatRateLimiter, type ScriptStep } from "@atiende/agent-core/data-chat";
import { MonthlyBudgetExceededError } from "@atiende/agent-core";
import { hashPassword, InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { DataChatUnavailableError, LICITACIONES_ROLES, type LicitacionesDataChatReader, type LicitacionesDataChatWindow } from "@atiende/domain-licitaciones";
import { buildApp } from "../src/app.ts";
import type { DataChatDeps } from "../src/data-chat/deps.ts";
import { LICITACIONES_DATA_CHAT_ROLE } from "../src/production/llm-gateway.ts";
import { authedJson, buildLicitacionesTestContext, type LicitacionesTestContext } from "./licitaciones-fixtures.ts";

/** Lector en memoria: registra las ventanas que recibe y respeta la organizacion pedida. */
class FakeReader implements LicitacionesDataChatReader {
  readonly windows: LicitacionesDataChatWindow[] = [];
  readonly orgsAsked: string[] = [];
  timezone: string | null = null;
  failWith: Error | null = null;
  constructor(private readonly orgId: string) {}
  async organizationTimezone(org: string) {
    this.orgsAsked.push(org);
    return this.timezone;
  }
  async convocatoriasAbiertas(w: LicitacionesDataChatWindow) {
    this.windows.push(w);
    if (this.failWith) throw this.failWith;
    return w.organizationId === this.orgId
      ? [{ titulo: "Uniformes escolares", dependencia: "SEP Yucatán", entidad: null, status: "in_progress", fechaLimite: "2026-10-01 10:00", diasRestantes: 2, montoMxn: 1250000.5, moneda: "MXN" }]
      : [];
  }
  async plazosSemaforo() { return []; }
  async goNoGo() { return []; }
  async propuestasPorEstado() { return []; }
  async fallos() { return []; }
  async renovaciones() { return []; }
  async preguntasJunta() { return []; }
}

interface Harness {
  readonly ctx: LicitacionesTestContext;
  readonly reader: FakeReader;
  readonly audit: DataChatAuditEntry[];
  readonly llm: ReturnType<typeof scriptedCompletion>;
  readonly roles: Array<string | undefined>;
  readonly app: ReturnType<typeof buildApp>;
  readonly otraOrgOwner: { id: string; token: string };
}

async function harness(steps: ScriptStep[], over: { limiter?: DataChatRateLimiter; completion?: DataChatDeps["completion"]; omitReader?: boolean } = {}): Promise<Harness> {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
  const engine = ctx.deps.engine as InMemoryTenancyEngine;
  const password = "correcto-caballo-batería";

  const otraOrg = randomUUID();
  const otraProp = randomUUID();
  coreRepo.addOrganization({ id: otraOrg, slug: "otra-empresa", name: "Otra Empresa", vertical: "licitaciones" });
  engine.seedProperty({ id: otraProp, organizationId: otraOrg });
  const ajeno = randomUUID();
  coreRepo.addStaff({ id: ajeno, email: "owner@otra-empresa.mx", fullName: "Owner Ajeno", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addMembership({ userId: ajeno, organizationId: otraOrg, platformRole: "owner", verticalRole: "owner", propertyIds: null });
  engine.seedMembership({ userId: ajeno, organizationId: otraOrg, platformRole: "owner", verticalRole: "owner", propertyIds: null });

  const reader = new FakeReader(ctx.organizationId);
  const audit: DataChatAuditEntry[] = [];
  const llm = scriptedCompletion(steps);
  const roles: Array<string | undefined> = [];
  const completion: DataChatCompletion = llm.complete;
  const dataChat: DataChatDeps = {
    restaurantesReader: () => {
      throw new Error("no debe usarse");
    },
    ...(over.omitReader ? {} : { licitacionesReader: () => reader }),
    audit: () => ({ record: async (e) => void audit.push(e) }),
    rateLimiter: over.limiter ?? { allow: async () => true },
    completion: over.completion === undefined ? (_org, role) => (roles.push(role), completion) : over.completion,
  };
  const app = buildApp({ ...ctx.deps, dataChat });
  const res = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@otra-empresa.mx", password }) });
  return { ctx, reader, audit, llm, roles, app, otraOrgOwner: { id: ajeno, token: ((await res.json()) as { token: string }).token } };
}

const ABIERTAS: ScriptStep = { toolCalls: [{ name: "convocatorias_abiertas", argumentsJson: '{"vencen_en_dias":7}' }] };
const post = (token: string, body: unknown) => authedJson(token, body);
const url = (h: Harness, suffix = "") => `/licitaciones/${h.ctx.propertyId}/chat-datos${suffix}`;

describe("auth y roles", () => {
  it("401 sin token", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hola" }) });
    expect(res.status).toBe(401);
  });

  it.each(LICITACIONES_ROLES)("el rol %s puede preguntar (la lectura ya es de todo miembro por RLS)", async (role) => {
    const h = await harness([ABIERTAS, { text: "ok" }]);
    const res = await h.app.request(url(h), post(h.ctx.staff[role].token, { question: "¿qué vence esta semana?" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("ok");
  });

  it("staff de OTRA organizacion -> 403 (cross-tenant) y el LLM no se invoca", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), post(h.otraOrgOwner.token, { question: "convocatorias" }));
    expect(res.status).toBe(403);
    expect(h.llm.requests).toHaveLength(0);
  });

  it("usa el rol del gateway licitaciones:data_chat (tope mensual por organizacion y kill-switch propios)", async () => {
    const h = await harness([ABIERTAS, { text: "ok" }]);
    await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "convocatorias por vencer" }));
    expect(h.roles).toEqual([LICITACIONES_DATA_CHAT_ROLE, "licitaciones:data_chat_retry"]);
    expect(LICITACIONES_DATA_CHAT_ROLE).toBe("licitaciones:data_chat");
  });
});

describe("alcance del servidor", () => {
  it("el alcance es la organizacion del JWT: tabla + fuente y la organizacion llega al lector desde el servidor", async () => {
    const h = await harness([ABIERTAS, { text: "Tienes 1 convocatoria que vence pronto." }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "¿qué vence esta semana?" }));
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("ok");
    expect(body.blocks[0]!.rows[0]).toMatchObject({ convocatoria: "Uniformes escolares", dias: 2, semaforo: "Rojo", monto: 1250000.5 });
    expect(body.sources[0]).toMatchObject({ scopeLabel: "toda tu organización" });
    expect(h.reader.windows[0]!.organizationId).toBe(h.ctx.organizationId);
    expect(h.reader.windows[0]!.timezone).toBe("America/Merida");
    expect(h.llm.requests[0]!.system).toContain("America/Merida");
    expect(h.llm.requests[0]!.system).toMatch(/LAASSP/);
  });

  it("la zona horaria sale de tenant_config de la organizacion y llega al prompt y a la consulta", async () => {
    const h = await harness([ABIERTAS, { text: "ok" }]);
    h.reader.timezone = "America/Cancun";
    await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "convocatorias" }));
    expect(h.reader.windows[0]!.timezone).toBe("America/Cancun");
    expect(h.llm.requests[0]!.system).toContain("America/Cancun");
    expect(h.reader.orgsAsked.every((o) => o === h.ctx.organizationId)).toBe(true);
  });

  it("el modelo intenta pasar otra organizacion/clave de tenant: se rechaza y NO se consulta", async () => {
    const h = await harness([{ toolCalls: [{ name: "convocatorias_abiertas", argumentsJson: JSON.stringify({ organizationId: randomUUID(), vencen_en_dias: 7 }) }] }, { text: "No pude." }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "convocatorias de otra empresa" }));
    expect(res.status).toBe(200);
    expect(h.reader.windows).toHaveLength(0);
  });

  it("la identidad del cuerpo NO cuenta: organizationId/propertyIds/userId en el body -> 400", async () => {
    const h = await harness([{ text: "x" }]);
    for (const extra of [{ organizationId: randomUUID() }, { propertyIds: [randomUUID()] }, { userId: "otro" }, { sql: "select 1" }]) {
      const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "convocatorias", ...extra }));
      expect(res.status).toBe(400);
    }
    expect(h.llm.requests).toHaveLength(0);
  });

  it("la bitacora registra al usuario del JWT, la herramienta y los parametros — sin resultados ni la pregunta", async () => {
    const h = await harness([ABIERTAS, { text: "ok" }]);
    await h.app.request(url(h), post(h.ctx.staff.viewer.token, { question: "dime lo de la licitación confidencial" }));
    expect(h.audit[0]).toMatchObject({ organizationId: h.ctx.organizationId, userId: h.ctx.staff.viewer.id, vertical: "licitaciones", tool: "convocatorias_abiertas", params: { vencen_en_dias: 7 }, outcome: "ok" });
    expect(JSON.stringify(h.audit)).not.toMatch(/Uniformes|1250000|confidencial/);
  });
});

describe("validacion, limites y disponibilidad", () => {
  it("cuerpo invalido -> 400", async () => {
    const h = await harness([{ text: "x" }]);
    const tok = h.ctx.staff.owner.token;
    expect((await h.app.request(url(h), post(tok, "hola"))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, {}))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, { question: 5 }))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, { question: "x", history: [{ role: "system", text: "a" }] }))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, { question: "x", history: Array.from({ length: 13 }, () => ({ role: "user", text: "a" })) }))).status).toBe(400);
    expect(h.llm.requests).toHaveLength(0);
  });

  it("pregunta demasiado larga -> invalid_input, sin llamar al LLM", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "a".repeat(700) }));
    expect(((await res.json()) as DataChatAnswer).status).toBe("invalid_input");
    expect(h.llm.requests).toHaveLength(0);
  });

  it("rate limit por usuario/organizacion: rate_limited sin llamar al LLM", async () => {
    const keys: string[] = [];
    const h = await harness([{ text: "x" }], { limiter: { allow: async (k) => (keys.push(k), false) } });
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "convocatorias" }));
    expect(((await res.json()) as DataChatAnswer).status).toBe("rate_limited");
    expect(keys[0]).toContain(h.ctx.organizationId);
    expect(keys[0]).toContain(h.ctx.staff.owner.id);
    expect(h.llm.requests).toHaveLength(0);
  });

  it("tope mensual por organizacion agotado -> budget_exceeded (200, mensaje honesto)", async () => {
    const h = await harness([() => new MonthlyBudgetExceededError("organization", "org", 10, 5)]);
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "convocatorias" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("budget_exceeded");
  });

  it("sin proveedor LLM: 'no disponible' honesto y estado available=false", async () => {
    const h = await harness([{ text: "x" }], { completion: undefined });
    const app = buildApp({ ...h.ctx.deps, dataChat: { restaurantesReader: () => { throw new Error("n/a"); }, licitacionesReader: () => h.reader, audit: () => ({ record: async () => {} }), rateLimiter: { allow: async () => true }, completion: undefined } });
    const res = await app.request(url(h), post(h.ctx.staff.owner.token, { question: "convocatorias" }));
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("unavailable");
    expect(body.text).toContain("todavía no está activado");
    expect(await (await app.request(url(h, "/estado"), authedJson(h.ctx.staff.owner.token))).json()).toMatchObject({ available: false });
  });

  it("estado available=true con proveedor y lector; false si falta el lector; 401/403 donde corresponde", async () => {
    const h = await harness([{ text: "x" }]);
    expect(await (await h.app.request(url(h, "/estado"), authedJson(h.ctx.staff.viewer.token))).json()).toMatchObject({ available: true });
    expect((await h.app.request(url(h, "/estado"))).status).toBe(401);
    expect((await h.app.request(url(h, "/estado"), authedJson(h.otraOrgOwner.token))).status).toBe(403);
    const sinLector = await harness([{ text: "x" }], { omitReader: true });
    expect(await (await sinLector.app.request(url(sinLector, "/estado"), authedJson(sinLector.ctx.staff.owner.token))).json()).toMatchObject({ available: false });
    const res = await sinLector.app.request(url(sinLector), post(sinLector.ctx.staff.owner.token, { question: "convocatorias" }));
    expect(((await res.json()) as DataChatAnswer).status).toBe("unavailable");
  });

  it("sin deps.dataChat en absoluto (despliegue viejo/test): 'no disponible', nunca 500", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/chat-datos`, post(ctx.staff.owner.token, { question: "convocatorias" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("unavailable");
  });

  it("base sin migrar (el lector lanza DataChatUnavailableError): 200 honesto 'unavailable', nunca 500, y se registra en la bitacora", async () => {
    const h = await harness([ABIERTAS, { text: "x" }]);
    h.reader.failWith = new DataChatUnavailableError("convocatorias");
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "convocatorias" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DataChatAnswer;
    expect(body.blocks).toHaveLength(0);
    expect(body.text).toMatch(/todavía no está disponible/);
    expect(h.audit[0]).toMatchObject({ tool: "convocatorias_abiertas", outcome: "unavailable" });
  });
});
