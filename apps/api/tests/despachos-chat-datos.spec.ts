// POST /despachos/:propertyId/chat-datos — "Chatea con tus datos" (despachos). HTTP real via app.request:
// auth, roles, aislamiento cross-tenant, alcance por membership (contador con UN cliente), validacion de
// cuerpo, rate limit, tope de presupuesto, bitacora y compatibilidad con la base sin migrar. El LLM es un
// guion (`scriptedCompletion`): ningun test toca la red ni gasta.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scriptedCompletion, type DataChatAnswer, type DataChatAuditEntry, type DataChatCompletion, type DataChatRateLimiter, type ScriptStep } from "@atiende/agent-core/data-chat";
import { MonthlyBudgetExceededError } from "@atiende/agent-core";
import { hashPassword, InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { DataChatUnavailableError, type DespachosDataChatReader, type DespachosDataChatWindow, type VisibleClient } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import type { DataChatDeps } from "../src/data-chat/deps.ts";
import { DESPACHOS_DATA_CHAT_ROLE } from "../src/production/llm-gateway.ts";
import { authedJson, buildDespachosTestContext, type DespachosTestContext } from "./despachos-fixtures.ts";

/** Lector en memoria que respeta el alcance igual que la base real: solo suma la cartera de los clientes pedidos. */
class ScopedReader implements DespachosDataChatReader {
  readonly windows: DespachosDataChatWindow[] = [];
  failWith: Error | null = null;
  constructor(
    private readonly clients: readonly VisibleClient[],
    private readonly cartera: Readonly<Record<string, number>>,
  ) {}
  async listVisibleClients(_org: string, ids: readonly string[] | null) {
    return ids === null ? this.clients : this.clients.filter((c) => ids.includes(c.propertyId));
  }
  async carteraPorCliente(w: DespachosDataChatWindow) {
    this.windows.push(w);
    if (this.failWith) throw this.failWith;
    const visible = w.propertyIds === null ? this.clients : this.clients.filter((c) => w.propertyIds!.includes(c.propertyId));
    return visible.filter((c) => (this.cartera[c.propertyId] ?? 0) > 0).map((c) => ({ cliente: c.name, cuentasPendientes: 1, montoPendiente: this.cartera[c.propertyId]!, cuentasVencidas: 0, montoVencido: 0 }));
  }
  async antiguedadCobranza() { return []; }
  async cfdiPorPeriodo() { return []; }
  async ivaAcreditable() { return []; }
  async obligacionesFiscales() { return []; }
  async cierresPendientes() { return []; }
  async cargaDeTrabajo() { return []; }
  async efosAlertas() { return { estado: "no_disponible" as const, periodoLista: null, alertas: [], truncado: false }; }
}

interface Harness {
  readonly ctx: DespachosTestContext;
  readonly reader: ScopedReader;
  readonly audit: DataChatAuditEntry[];
  readonly llm: ReturnType<typeof scriptedCompletion>;
  readonly roles: Array<string | undefined>;
  readonly app: ReturnType<typeof buildApp>;
  readonly propertyB: string;
  readonly contadorUno: { token: string; id: string };
  readonly otraOrgAdmin: { token: string; id: string };
}

async function login(app: ReturnType<typeof buildApp>, email: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (res.status !== 200) throw new Error(`login de prueba fallo: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

async function harness(steps: ScriptStep[], over: { limiter?: DataChatRateLimiter; completion?: DataChatDeps["completion"]; omitReader?: boolean } = {}): Promise<Harness> {
  const ctx = await buildDespachosTestContext(buildApp);
  const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
  const engine = ctx.deps.engine as InMemoryTenancyEngine;
  const password = "correcto-caballo-batería";

  // Segundo cliente (property) del MISMO despacho + un contador cuya membership esta acotada al PRIMERO.
  const propertyB = randomUUID();
  engine.seedProperty({ id: propertyB, organizationId: ctx.organizationId });
  ctx.despachosRepo.seedDespachosProperty({ id: propertyB, organizationId: ctx.organizationId, name: "Taller Mecánico Peninsular" });
  const uno = randomUUID();
  coreRepo.addStaff({ id: uno, email: "contador-uno@despacho-de-prueba.mx", fullName: "Contador Uno", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addMembership({ userId: uno, organizationId: ctx.organizationId, platformRole: "member", verticalRole: "contador", propertyIds: [ctx.propertyId] });
  engine.seedMembership({ userId: uno, organizationId: ctx.organizationId, platformRole: "member", verticalRole: "contador", propertyIds: [ctx.propertyId] });

  // Admin de OTRO despacho.
  const otraOrg = randomUUID();
  const otraProp = randomUUID();
  coreRepo.addOrganization({ id: otraOrg, slug: "otro-despacho", name: "Otro Despacho", vertical: "despachos" });
  engine.seedProperty({ id: otraProp, organizationId: otraOrg });
  const ajeno = randomUUID();
  coreRepo.addStaff({ id: ajeno, email: "admin@otro-despacho.mx", fullName: "Admin Ajeno", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addMembership({ userId: ajeno, organizationId: otraOrg, platformRole: "owner", verticalRole: "admin", propertyIds: null });
  engine.seedMembership({ userId: ajeno, organizationId: otraOrg, platformRole: "owner", verticalRole: "admin", propertyIds: null });

  const reader = new ScopedReader(
    [
      { propertyId: ctx.propertyId, name: "Abarrotes La Esquina SA de CV" },
      { propertyId: propertyB, name: "Taller Mecánico Peninsular" },
    ],
    { [ctx.propertyId]: 1000, [propertyB]: 250 },
  );
  const audit: DataChatAuditEntry[] = [];
  const llm = scriptedCompletion(steps);
  const roles: Array<string | undefined> = [];
  const completion: DataChatCompletion = llm.complete;
  const dataChat: DataChatDeps = {
    restaurantesReader: () => {
      throw new Error("no debe usarse");
    },
    ...(over.omitReader ? {} : { despachosReader: () => reader }),
    audit: () => ({ record: async (e) => void audit.push(e) }),
    rateLimiter: over.limiter ?? { allow: async () => true },
    completion: over.completion === undefined ? (_org, role) => (roles.push(role), completion) : over.completion,
  };
  const app = buildApp({ ...ctx.deps, dataChat });
  return {
    ctx,
    reader,
    audit,
    llm,
    roles,
    app,
    propertyB,
    contadorUno: { id: uno, token: await login(app, "contador-uno@despacho-de-prueba.mx", password) },
    otraOrgAdmin: { id: ajeno, token: await login(app, "admin@otro-despacho.mx", password) },
  };
}

const CARTERA: ScriptStep = { toolCalls: [{ name: "cartera_por_cliente", argumentsJson: "{}" }] };
const post = (token: string, body: unknown) => authedJson(token, body);
const url = (h: Harness, suffix = "") => `/despachos/${h.ctx.propertyId}/chat-datos${suffix}`;

describe("auth y roles", () => {
  it("401 sin token", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hola" }) });
    expect(res.status).toBe(401);
  });

  it.each(["admin", "contador", "auditor", "readonly"] as const)("el rol %s (VER_DASHBOARD_ROLES) puede preguntar", async (role) => {
    const h = await harness([CARTERA, { text: "ok" }]);
    const res = await h.app.request(url(h), post(h.ctx.staff[role].token, { question: "cartera" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("ok");
  });

  it("staff de OTRO despacho -> 403 (cross-tenant) y el LLM no se invoca", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), post(h.otraOrgAdmin.token, { question: "cartera" }));
    expect(res.status).toBe(403);
    expect(h.llm.requests).toHaveLength(0);
  });

  it("usa el rol del gateway despachos:data_chat (tope mensual por organizacion y kill-switch propios)", async () => {
    const h = await harness([CARTERA, { text: "ok" }]);
    await h.app.request(url(h), post(h.ctx.staff.admin.token, { question: "cartera" }));
    expect(h.roles).toEqual([DESPACHOS_DATA_CHAT_ROLE, "despachos:data_chat_retry"]);
    expect(DESPACHOS_DATA_CHAT_ROLE).toBe("despachos:data_chat");
  });
});

describe("alcance del servidor", () => {
  it("admin: todos los clientes (propertyIds null), organizacion y zona del servidor, tabla + fuente", async () => {
    const h = await harness([CARTERA, { text: "Tu cartera pendiente es de $1,250.00 MXN." }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.admin.token, { question: "¿cuánto me deben?" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("ok");
    expect(body.blocks[0]!.rows).toHaveLength(2);
    expect(body.sources[0]).toMatchObject({ scopeLabel: "todos tus clientes" });
    expect(h.reader.windows[0]).toMatchObject({ propertyIds: null, organizationId: h.ctx.organizationId });
    expect(h.llm.requests[0]!.system).toContain("America/Merida");
  });

  it("contador con membership de UN cliente: solo ve ese, aunque el modelo pida al otro por nombre", async () => {
    const h = await harness([CARTERA, { text: "ok" }]);
    const res = await h.app.request(url(h), post(h.contadorUno.token, { question: "cartera" }));
    const body = (await res.json()) as DataChatAnswer;
    expect(h.reader.windows[0]!.propertyIds).toEqual([h.ctx.propertyId]);
    expect(body.blocks[0]!.rows).toHaveLength(1);
    expect(body.blocks[0]!.rows[0]).toMatchObject({ cliente: "Abarrotes La Esquina SA de CV" });
    expect(h.llm.requests[0]!.system).toContain("Abarrotes");
    expect(h.llm.requests[0]!.system).not.toContain("Taller");

    const h2 = await harness([{ toolCalls: [{ name: "cartera_por_cliente", argumentsJson: '{"cliente":"Taller"}' }] }, { text: "El taller debe $250.00 MXN" }]);
    const res2 = await h2.app.request(url(h2), post(h2.contadorUno.token, { question: "cartera del taller" }));
    const body2 = (await res2.json()) as DataChatAnswer;
    expect(body2.status).toBe("clarify");
    expect(JSON.stringify(body2)).not.toMatch(/250/);
    expect(h2.reader.windows).toHaveLength(0);
  });

  it("la zona horaria sale de la configuracion del cliente (property_config) y no del cuerpo", async () => {
    const h = await harness([CARTERA, { text: "ok" }]);
    await h.ctx.despachosRepo.upsertPropertyConfigZonaHoraria(h.ctx.propertyId, h.ctx.organizationId, "America/Tijuana");
    await h.app.request(url(h), post(h.ctx.staff.admin.token, { question: "cartera" }));
    expect(h.llm.requests[0]!.system).toContain("America/Tijuana");
  });

  it("la identidad del cuerpo NO cuenta: organizationId/propertyIds/userId/cliente en el body -> 400", async () => {
    const h = await harness([{ text: "x" }]);
    for (const extra of [{ organizationId: randomUUID() }, { propertyIds: [h.propertyB] }, { userId: "otro" }, { cliente: "Taller" }, { sql: "select 1" }]) {
      const res = await h.app.request(url(h), post(h.contadorUno.token, { question: "cartera", ...extra }));
      expect(res.status).toBe(400);
    }
    expect(h.llm.requests).toHaveLength(0);
  });

  it("la bitacora registra al usuario del JWT, la herramienta y los parametros — sin resultados ni la pregunta", async () => {
    const h = await harness([CARTERA, { text: "ok" }]);
    await h.app.request(url(h), post(h.ctx.staff.admin.token, { question: "cuánto me deben mis clientes secretos" }));
    expect(h.audit[0]).toMatchObject({ organizationId: h.ctx.organizationId, userId: h.ctx.staff.admin.id, vertical: "despachos", tool: "cartera_por_cliente", outcome: "ok" });
    // Se excluyen los campos generados al azar (UUID de organizacion/usuario) y las duraciones/costos: una cifra aleatoria
    // podria contener "1000" o "250" sin que se haya filtrado ningun resultado.
    const deterministico = h.audit.map(({ organizationId: _org, userId: _usr, durationMs: _ms, costMicroUsd: _costo, ...resto }) => resto);
    expect(JSON.stringify(deterministico)).not.toMatch(/1000|250|secretos/);
  });
});

describe("validacion, limites y disponibilidad", () => {
  it("cuerpo invalido -> 400", async () => {
    const h = await harness([{ text: "x" }]);
    const tok = h.ctx.staff.admin.token;
    expect((await h.app.request(url(h), post(tok, "hola"))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, {}))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, { question: 5 }))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, { question: "x", history: [{ role: "system", text: "a" }] }))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, { question: "x", history: Array.from({ length: 13 }, () => ({ role: "user", text: "a" })) }))).status).toBe(400);
    expect(h.llm.requests).toHaveLength(0);
  });

  it("pregunta demasiado larga -> invalid_input, sin llamar al LLM", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.admin.token, { question: "a".repeat(700) }));
    expect(((await res.json()) as DataChatAnswer).status).toBe("invalid_input");
    expect(h.llm.requests).toHaveLength(0);
  });

  it("rate limit por usuario/organizacion: rate_limited sin llamar al LLM", async () => {
    const keys: string[] = [];
    const h = await harness([{ text: "x" }], { limiter: { allow: async (k) => (keys.push(k), false) } });
    const res = await h.app.request(url(h), post(h.ctx.staff.admin.token, { question: "cartera" }));
    expect(((await res.json()) as DataChatAnswer).status).toBe("rate_limited");
    expect(keys[0]).toContain(h.ctx.organizationId);
    expect(keys[0]).toContain(h.ctx.staff.admin.id);
    expect(h.llm.requests).toHaveLength(0);
  });

  it("tope mensual por organizacion agotado -> budget_exceeded (200, mensaje honesto)", async () => {
    const h = await harness([() => new MonthlyBudgetExceededError("organization", "org", 10, 5)]);
    const res = await h.app.request(url(h), post(h.ctx.staff.admin.token, { question: "cartera" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("budget_exceeded");
  });

  it("sin proveedor LLM: 'no disponible' honesto y estado available=false", async () => {
    const h = await harness([{ text: "x" }], { completion: undefined });
    const app = buildApp({ ...h.ctx.deps, dataChat: { restaurantesReader: () => { throw new Error("n/a"); }, despachosReader: () => h.reader, audit: () => ({ record: async () => {} }), rateLimiter: { allow: async () => true }, completion: undefined } });
    const res = await app.request(url(h), post(h.ctx.staff.admin.token, { question: "cartera" }));
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("unavailable");
    expect(body.text).toContain("todavía no está activado");
    expect(await (await app.request(url(h, "/estado"), authedJson(h.ctx.staff.admin.token))).json()).toMatchObject({ available: false });
  });

  it("estado available=true con proveedor y lector; false si falta el lector", async () => {
    const h = await harness([{ text: "x" }]);
    expect(await (await h.app.request(url(h, "/estado"), authedJson(h.ctx.staff.admin.token))).json()).toMatchObject({ available: true });
    const sinLector = await harness([{ text: "x" }], { omitReader: true });
    expect(await (await sinLector.app.request(url(sinLector, "/estado"), authedJson(sinLector.ctx.staff.admin.token))).json()).toMatchObject({ available: false });
    const res = await sinLector.app.request(url(sinLector), post(sinLector.ctx.staff.admin.token, { question: "cartera" }));
    expect(((await res.json()) as DataChatAnswer).status).toBe("unavailable");
  });

  it("estado: 401 sin token y 403 para staff de otro despacho", async () => {
    const h = await harness([{ text: "x" }]);
    expect((await h.app.request(url(h, "/estado"))).status).toBe(401);
    expect((await h.app.request(url(h, "/estado"), authedJson(h.otraOrgAdmin.token))).status).toBe(403);
  });

  it("sin deps.dataChat en absoluto (despliegue viejo/test): 'no disponible', nunca 500", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/chat-datos`, post(ctx.staff.admin.token, { question: "cartera" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("unavailable");
  });

  it("base sin migrar (el lector lanza DataChatUnavailableError): respuesta 200 honesta 'unavailable', nunca 500, y se registra en la bitacora", async () => {
    const h = await harness([CARTERA, { text: "x" }]);
    h.reader.failWith = new DataChatUnavailableError("cobranza");
    const res = await h.app.request(url(h), post(h.ctx.staff.admin.token, { question: "cartera" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DataChatAnswer;
    expect(body.blocks).toHaveLength(0);
    expect(body.text).toMatch(/todavía no está disponible/);
    expect(h.audit[0]).toMatchObject({ tool: "cartera_por_cliente", outcome: "unavailable" });
  });
});
