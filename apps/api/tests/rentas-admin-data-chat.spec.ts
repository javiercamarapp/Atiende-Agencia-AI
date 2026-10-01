// POST/GET /rentas/:propertyId/chat-datos — "Chatea con tus datos" de RENTAS.
// HTTP real vía app.request: auth, roles (solo admin_gestora y contador: lo financiero lo ve la RLS can_read_finanzas),
// aislamiento cross-tenant, alcance por membership (admin de una propiedad), validación de cuerpo, rate limit, tope de
// presupuesto, zona horaria de la propiedad y bitácora. El LLM es un guion (`scriptedCompletion`): ningún test toca la
// red ni gasta.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scriptedCompletion, type DataChatAnswer, type DataChatCompletion, type DataChatAuditEntry, type DataChatRateLimiter, type ScriptStep } from "@atiende/agent-core/data-chat";
import { MonthlyBudgetExceededError } from "@atiende/agent-core";
import { InMemoryCoreRepository, hashPassword } from "@atiende/db";
import type { RentasDataChatReader, RentasDataChatWindow } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import type { DataChatDeps } from "../src/data-chat/deps.ts";
import { authedJson, buildRentasTestContext, type RentasTestContext } from "./rentas-fixtures.ts";

const PROPERTY_B_NAME = "Casas de Playa";

/** Lector en memoria que respeta el alcance igual que la base real: solo suma ingresos de las propiedades pedidas. */
class ScopedReader implements RentasDataChatReader {
  readonly windows: RentasDataChatWindow[] = [];
  constructor(
    private readonly properties: readonly { propertyId: string; name: string }[],
    private readonly cents: Readonly<Record<string, number>>,
  ) {}
  async listVisibleProperties(_org: string, ids: readonly string[] | null) {
    return (ids === null ? this.properties : this.properties.filter((p) => ids.includes(p.propertyId))).map((p) => ({ ...p, slug: p.name }));
  }
  async incomeByChannel(w: RentasDataChatWindow) {
    this.windows.push(w);
    const ids = w.propertyIds ?? this.properties.map((p) => p.propertyId);
    const gross = ids.reduce((n, id) => n + (this.cents[id] ?? 0), 0);
    return gross === 0 ? [] : [{ channel: "Airbnb", bookings: ids.length, nights: 3, grossCents: gross, channelFeeCents: 0, netCents: gross, otherCurrency: 0 }];
  }
  async occupancyByUnit() { return []; }
  async incomeByOwner() { return []; }
  async openConflicts() { return []; }
  async pendingTasks() { return []; }
  async ownerStatements() { return []; }
  async channelPayouts() { return []; }
}

interface Harness {
  readonly ctx: RentasTestContext;
  readonly reader: ScopedReader;
  readonly audit: DataChatAuditEntry[];
  readonly llmRequests: ReturnType<typeof scriptedCompletion>["requests"];
  readonly app: ReturnType<typeof buildApp>;
  readonly propertyB: string;
  readonly staff: { readonly otroOrgAdmin: string; readonly adminSoloPropiedadA: string };
}

async function signIn(app: ReturnType<typeof buildApp>, email: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  return ((await res.json()) as { token: string }).token;
}

async function harness(steps: ScriptStep[], over: { limiter?: DataChatRateLimiter; completion?: DataChatDeps["completion"]; reader?: boolean } = {}): Promise<Harness> {
  const ctx = await buildRentasTestContext(buildApp);
  const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
  // Segunda propiedad de la MISMA organización y una organización ajena con su admin.
  const propertyB = randomUUID();
  ctx.engine.seedProperty({ id: propertyB, organizationId: ctx.organizationId });
  const otherOrg = randomUUID();
  coreRepo.addOrganization({ id: otherOrg, slug: "gestora-ajena", name: "Gestora Ajena", vertical: "rentas" });
  ctx.engine.seedProperty({ id: randomUUID(), organizationId: otherOrg });
  const password = "correcto-caballo-batería";
  async function seed(label: string, organizationId: string, platformRole: "owner" | "admin", propertyIds: string[] | null) {
    const id = randomUUID();
    const email = `${label}@gestora-ajena.mx`;
    coreRepo.addStaff({ id, email, fullName: label, passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addMembership({ userId: id, organizationId, platformRole, verticalRole: "admin_gestora", propertyIds });
    ctx.engine.seedMembership({ userId: id, organizationId, platformRole, verticalRole: "admin_gestora", propertyIds });
    return email;
  }
  const otroEmail = await seed("admin-ajeno", otherOrg, "owner", null);
  const adminEmail = await seed("admin-propiedad-a", ctx.organizationId, "admin", [ctx.propertyId]);
  const reader = new ScopedReader(
    [
      { propertyId: ctx.propertyId, name: "Edificio Centro" },
      { propertyId: propertyB, name: PROPERTY_B_NAME },
    ],
    { [ctx.propertyId]: 100_00, [propertyB]: 250_00 },
  );
  const audit: DataChatAuditEntry[] = [];
  const llm = scriptedCompletion(steps);
  const completion: DataChatCompletion = llm.complete;
  const dataChat: DataChatDeps = {
    restaurantesReader: () => {
      throw new Error("no se usa en rentas");
    },
    ...(over.reader === false ? {} : { rentasReader: () => reader }),
    audit: () => ({ record: async (e) => void audit.push(e) }),
    rateLimiter: over.limiter ?? { allow: async () => true },
    completion: "completion" in over ? over.completion : () => completion,
  };
  const app = buildApp({ ...ctx.deps, dataChat });
  return {
    ctx,
    reader,
    audit,
    llmRequests: llm.requests,
    app,
    propertyB,
    staff: { otroOrgAdmin: await signIn(app, otroEmail, password), adminSoloPropiedadA: await signIn(app, adminEmail, password) },
  };
}

const INCOME: ScriptStep = { toolCalls: [{ name: "ingresos_por_canal", argumentsJson: '{"periodo":"mes_pasado"}' }] };
const post = (token: string, body: unknown) => authedJson(token, body);
const authedGet = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });
const url = (h: Harness, suffix = "") => `/rentas/${h.ctx.propertyId}/chat-datos${suffix}`;

describe("auth y roles (solo admin_gestora y contador)", () => {
  it("401 sin token", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hola" }) });
    expect(res.status).toBe(401);
  });

  it("operadores y limpieza (sin acceso a finanzas) -> 403 y el LLM no se invoca", async () => {
    const h = await harness([{ text: "x" }]);
    for (const role of ["operadorAccesoTotal", "operadorSoloCalendario", "limpieza"] as const) {
      const res = await h.app.request(url(h), post(h.ctx.staff[role].token, { question: "ingresos" }));
      expect(res.status, role).toBe(403);
      const estado = await h.app.request(url(h, "/estado"), authedGet(h.ctx.staff[role].token));
      expect(estado.status, `${role} estado`).toBe(403);
    }
    expect(h.llmRequests).toHaveLength(0);
  });

  it("admin_gestora y contador sí pasan", async () => {
    const h = await harness([INCOME, { text: "ok" }, INCOME, { text: "ok" }]);
    expect((await h.app.request(url(h), post(h.ctx.staff.adminGestora.token, { question: "ingresos del mes pasado" }))).status).toBe(200);
    expect((await h.app.request(url(h), post(h.ctx.staff.contador.token, { question: "ingresos del mes pasado" }))).status).toBe(200);
  });

  it("staff de OTRA organización -> 403 (cross-tenant)", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), post(h.staff.otroOrgAdmin, { question: "ingresos" }));
    expect(res.status).toBe(403);
    expect(h.llmRequests).toHaveLength(0);
  });
});

describe("alcance del servidor", () => {
  it("admin: todas las propiedades (propertyIds null), organización y zona de la propiedad, y respuesta con tabla + fuente", async () => {
    const h = await harness([INCOME, { text: "Los ingresos brutos fueron $350.00 MXN." }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.adminGestora.token, { question: "¿cuánto ingresé el mes pasado?" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("ok");
    expect(body.blocks[0]!.rows[0]).toMatchObject({ canal: "Airbnb", reservas: 2, ingresos: 350 });
    expect(body.sources[0]).toMatchObject({ scopeLabel: "todas tus propiedades", tool: "ingresos_por_canal" });
    // la propiedad del fixture tiene zona America/Cancun sembrada (rentas.property_config.zona_horaria)
    expect(h.reader.windows[0]).toMatchObject({ propertyIds: null, organizationId: h.ctx.organizationId, timezone: "America/Cancun" });
    expect(h.llmRequests[0]!.system).toContain("America/Cancun");
  });

  it("admin de UNA propiedad: SOLO ve esa, aunque el modelo pida la otra por nombre", async () => {
    const h = await harness([INCOME, { text: "ok" }]);
    const res = await h.app.request(url(h), post(h.staff.adminSoloPropiedadA, { question: "ingresos del mes pasado" }));
    const body = (await res.json()) as DataChatAnswer;
    expect(h.reader.windows[0]!.propertyIds).toEqual([h.ctx.propertyId]);
    expect(body.blocks[0]!.rows[0]).toMatchObject({ ingresos: 100 });
    expect(h.llmRequests[0]!.system).toContain("Edificio Centro");
    expect(h.llmRequests[0]!.system).not.toContain(PROPERTY_B_NAME);

    const h2 = await harness([{ toolCalls: [{ name: "ingresos_por_canal", argumentsJson: `{"periodo":"mes_pasado","propiedad":"${PROPERTY_B_NAME}"}` }] }, { text: "Playa ingresó $250.00 MXN" }]);
    const res2 = await h2.app.request(url(h2), post(h2.staff.adminSoloPropiedadA, { question: "ingresos de Casas de Playa" }));
    const body2 = (await res2.json()) as DataChatAnswer;
    expect(body2.status).toBe("clarify");
    expect(JSON.stringify(body2)).not.toMatch(/Playa|250/);
    expect(h2.reader.windows).toHaveLength(0);
  });

  it("la identidad del cuerpo NO cuenta: organizationId/propertyIds/userId en el body -> 400", async () => {
    const h = await harness([{ text: "x" }]);
    for (const extra of [{ organizationId: randomUUID() }, { propertyIds: [h.propertyB] }, { userId: "otro" }]) {
      const res = await h.app.request(url(h), post(h.ctx.staff.adminGestora.token, { question: "ingresos", ...extra }));
      expect(res.status).toBe(400);
    }
    expect(h.llmRequests).toHaveLength(0);
  });

  it("la bitácora registra al usuario del JWT, la herramienta y los parámetros — sin resultados ni la pregunta", async () => {
    const h = await harness([INCOME, { text: "ok" }]);
    await h.app.request(url(h), post(h.ctx.staff.adminGestora.token, { question: "ingresos del mes pasado" }));
    expect(h.audit[0]).toMatchObject({ organizationId: h.ctx.organizationId, userId: h.ctx.staff.adminGestora.id, vertical: "rentas", tool: "ingresos_por_canal", params: { periodo: "mes_pasado" }, outcome: "ok" });
    expect(JSON.stringify(h.audit)).not.toMatch(/35000|ingresos del mes pasado/);
  });

  it("pregunta fuera de catálogo (datos del huésped): lo dice sin cifras ni datos inventados", async () => {
    const h = await harness([{ text: "El huésped es Juan Pérez, tel 9991234567." }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.adminGestora.token, { question: "¿quién se hospeda hoy?" }));
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("out_of_catalog");
    expect(body.text).not.toMatch(/Juan|9991234567/);
  });
});

describe("validación, límites y disponibilidad", () => {
  it("cuerpo inválido -> 400", async () => {
    const h = await harness([{ text: "x" }]);
    const tok = h.ctx.staff.adminGestora.token;
    expect((await h.app.request(url(h), post(tok, "hola"))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, {}))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, { question: 5 }))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, { question: "x", history: "no" }))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, { question: "x", history: [{ role: "system", text: "a" }] }))).status).toBe(400);
    expect((await h.app.request(url(h), post(tok, { question: "x", history: Array.from({ length: 13 }, () => ({ role: "user", text: "a" })) }))).status).toBe(400);
    expect((await h.app.request(url(h), { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: "{no json" })).status).toBe(400);
    expect(h.llmRequests).toHaveLength(0);
  });

  it("pregunta demasiado larga -> status invalid_input, sin llamar al LLM", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.adminGestora.token, { question: "a".repeat(700) }));
    expect(((await res.json()) as DataChatAnswer).status).toBe("invalid_input");
    expect(h.llmRequests).toHaveLength(0);
  });

  it("rate limit por usuario/organización: responde rate_limited sin llamar al LLM", async () => {
    const keys: string[] = [];
    const h = await harness([{ text: "x" }], { limiter: { allow: async (k) => (keys.push(k), false) } });
    const res = await h.app.request(url(h), post(h.ctx.staff.adminGestora.token, { question: "ingresos" }));
    expect(((await res.json()) as DataChatAnswer).status).toBe("rate_limited");
    expect(keys[0]).toContain(h.ctx.organizationId);
    expect(keys[0]).toContain(h.ctx.staff.adminGestora.id);
    expect(h.llmRequests).toHaveLength(0);
  });

  it("tope mensual por organización agotado -> budget_exceeded (200, mensaje honesto)", async () => {
    const h = await harness([() => new MonthlyBudgetExceededError("organization", "org", 10, 5)]);
    const res = await h.app.request(url(h), post(h.ctx.staff.adminGestora.token, { question: "ingresos" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("budget_exceeded");
  });

  it("sin proveedor LLM de rentas: 'no disponible' honesto y estado available=false", async () => {
    const h = await harness([{ text: "x" }], { completion: undefined });
    const res = await h.app.request(url(h), post(h.ctx.staff.adminGestora.token, { question: "ingresos" }));
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("unavailable");
    expect(body.text).toContain("todavía no está activado");
    expect(await (await h.app.request(url(h, "/estado"), authedGet(h.ctx.staff.adminGestora.token))).json()).toEqual({ available: false });
  });

  it("deploy sin lector de rentas (dataChat viejo): 'no disponible', nunca 500", async () => {
    const h = await harness([{ text: "x" }], { reader: false });
    const res = await h.app.request(url(h), post(h.ctx.staff.adminGestora.token, { question: "ingresos" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("unavailable");
    expect(await (await h.app.request(url(h, "/estado"), authedGet(h.ctx.staff.adminGestora.token))).json()).toEqual({ available: false });
  });

  it("estado available=true con proveedor y lector", async () => {
    const h = await harness([{ text: "x" }]);
    expect(await (await h.app.request(url(h, "/estado"), authedGet(h.ctx.staff.contador.token))).json()).toEqual({ available: true });
  });

  it("sin deps.dataChat en absoluto: 'no disponible', nunca 500", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/chat-datos`, post(ctx.staff.adminGestora.token, { question: "ingresos" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("unavailable");
  });
});
