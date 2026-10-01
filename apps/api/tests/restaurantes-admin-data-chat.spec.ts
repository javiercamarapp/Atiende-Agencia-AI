// POST /v1/restaurantes/:propertyId/admin/chat-datos — "Chatea con tus datos" (piloto restaurantes).
// HTTP real vía app.request: auth, roles, aislamiento cross-tenant, alcance por membership
// (gerente de sucursal), validación de cuerpo, rate limit, tope de presupuesto y bitácora. El LLM es
// un guion (`scriptedCompletion`): ningún test toca la red ni gasta.
import { describe, expect, it } from "vitest";
import {
  scriptedCompletion,
  type DataChatAuditEntry,
  type DataChatAnswer,
  type DataChatRateLimiter,
  type DataChatCompletion,
  type ScriptStep,
} from "@atiende/agent-core/data-chat";
import { MonthlyBudgetExceededError } from "@atiende/agent-core";
import type { RestaurantesDataChatReader, DataChatWindow, VisibleBranch } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { DataChatDeps } from "../src/data-chat/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext, type RestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

/** Lector en memoria que respeta el alcance igual que la base real: solo suma pedidos de las sucursales pedidas. */
class ScopedReader implements RestaurantesDataChatReader {
  readonly windows: DataChatWindow[] = [];
  constructor(
    private readonly branches: readonly VisibleBranch[],
    private readonly sales: Readonly<Record<string, number>>,
  ) {}
  async listVisibleBranches(_org: string, ids: readonly string[] | null) {
    return ids === null ? this.branches : this.branches.filter((b) => ids.includes(b.propertyId));
  }
  async salesByPeriod(w: DataChatWindow) {
    this.windows.push(w);
    const ids = w.propertyIds ?? this.branches.map((b) => b.propertyId);
    const revenue = ids.reduce((n, id) => n + (this.sales[id] ?? 0), 0);
    return revenue === 0 ? [] : [{ bucket: "2026-09-29", revenue, orders: ids.length }];
  }
  async salesByBranch() { return []; }
  async topProducts() { return []; }
  async orderStats() { return { orders: 0, revenue: 0, cancelled: 0 }; }
  async ordersByChannel() { return []; }
  async peakHours() { return []; }
  async recurringCustomers() { return { customers: 0, recurring: 0, newCustomers: 0 }; }
  async promotions() { return []; }
}

interface Harness {
  readonly ctx: RestaurantesKpiTestContext;
  readonly reader: ScopedReader;
  readonly audit: DataChatAuditEntry[];
  readonly llmRequests: ReturnType<typeof scriptedCompletion>["requests"];
  readonly app: ReturnType<typeof buildApp>;
}

async function harness(steps: ScriptStep[], over: { limiter?: DataChatRateLimiter; completion?: DataChatDeps["completion"] } = {}): Promise<Harness> {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const reader = new ScopedReader(
    [
      { propertyId: ctx.propertyIdA, name: "Francisco de Montejo", slug: "fco-montejo" },
      { propertyId: ctx.propertyIdB, name: "Centro", slug: "centro" },
    ],
    { [ctx.propertyIdA]: 100, [ctx.propertyIdB]: 250 },
  );
  const audit: DataChatAuditEntry[] = [];
  const llm = scriptedCompletion(steps);
  const completion: DataChatCompletion = llm.complete;
  const dataChat: DataChatDeps = {
    restaurantesReader: () => reader,
    audit: () => ({ record: async (e) => void audit.push(e) }),
    rateLimiter: over.limiter ?? { allow: async () => true },
    completion: over.completion === undefined ? () => completion : over.completion,
  };
  const app = buildApp({ ...ctx.deps, dataChat });
  return { ctx, reader, audit, llmRequests: llm.requests, app };
}

const SALES_TODAY: ScriptStep = { toolCalls: [{ name: "ventas_por_dia", argumentsJson: '{"periodo":"ultimos_30_dias"}' }] };
const post = (token: string, body: unknown) => authedJson(token, body, "POST");
const url = (h: Harness, suffix = "") => `/v1/restaurantes/${h.ctx.propertyIdA}/admin/chat-datos${suffix}`;

describe("auth y roles", () => {
  it("401 sin token", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hola" }) });
    expect(res.status).toBe(401);
  });

  it("repartidor (fuera de MANAGER_ROLES) -> 403 y el LLM no se invoca", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.repartidor.token, { question: "ventas" }));
    expect(res.status).toBe(403);
    expect(h.llmRequests).toHaveLength(0);
  });

  it("staff de OTRA organización -> 403 (cross-tenant)", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.otroOrgOwner.token, { question: "ventas" }));
    expect(res.status).toBe(403);
    expect(h.llmRequests).toHaveLength(0);
  });
});

describe("alcance del servidor", () => {
  it("owner: todas las sucursales (propertyIds null), organización y zona del servidor, y respuesta con tabla + fuente", async () => {
    const h = await harness([SALES_TODAY, { text: "Vendiste $350.00 MXN en 2 pedidos." }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "¿cuánto vendí el último mes?" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("ok");
    expect(body.blocks[0]!.rows).toEqual([{ periodo: "2026-09-29", ventas: 350, pedidos: 2 }]);
    expect(body.sources[0]).toMatchObject({ scopeLabel: "todas tus sucursales", source: "Pedidos de restaurantes (sin cancelados)" });
    expect(h.reader.windows[0]).toMatchObject({ propertyIds: null, organizationId: h.ctx.organizationId, timezone: "America/Merida" });
    expect(h.llmRequests[0]!.system).toContain("America/Merida");
  });

  it("gerente de la sucursal A: SOLO ve A ($100), aunque el modelo pida Centro por nombre", async () => {
    const h = await harness([SALES_TODAY, { text: "ok" }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.staffSucursalA.token, { question: "ventas del último mes" }));
    const body = (await res.json()) as DataChatAnswer;
    expect(h.reader.windows[0]!.propertyIds).toEqual([h.ctx.propertyIdA]);
    expect(body.blocks[0]!.rows[0]).toMatchObject({ ventas: 100 });
    expect(h.llmRequests[0]!.system).toContain("Francisco de Montejo");
    expect(h.llmRequests[0]!.system).not.toContain("Centro");

    const h2 = await harness([{ toolCalls: [{ name: "ventas_por_dia", argumentsJson: '{"periodo":"hoy","sucursal":"Centro"}' }] }, { text: "Centro vendió $250.00 MXN" }]);
    const res2 = await h2.app.request(url(h2), post(h2.ctx.staff.staffSucursalA.token, { question: "ventas de Centro hoy" }));
    const body2 = (await res2.json()) as DataChatAnswer;
    expect(body2.status).toBe("clarify");
    expect(JSON.stringify(body2)).not.toMatch(/250/);
    expect(h2.reader.windows).toHaveLength(0);
  });

  it("la identidad del cuerpo NO cuenta: organization_id/property_ids/userId en el body -> 400", async () => {
    const h = await harness([{ text: "x" }]);
    for (const extra of [{ organizationId: h.ctx.otherOrganizationId }, { propertyIds: [h.ctx.propertyIdB] }, { userId: "otro" }]) {
      const res = await h.app.request(url(h), post(h.ctx.staff.staffSucursalA.token, { question: "ventas", ...extra }));
      expect(res.status).toBe(400);
    }
    expect(h.llmRequests).toHaveLength(0);
  });

  it("la bitácora registra al usuario del JWT, la herramienta y los parámetros — sin resultados", async () => {
    const h = await harness([SALES_TODAY, { text: "Vendiste $350.00 MXN." }]);
    await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "ventas del último mes" }));
    expect(h.audit[0]).toMatchObject({ organizationId: h.ctx.organizationId, userId: h.ctx.staff.owner.id, vertical: "restaurantes", tool: "ventas_por_dia", params: { periodo: "ultimos_30_dias" }, outcome: "ok" });
    expect(JSON.stringify(h.audit)).not.toMatch(/350|ventas del último mes/);
  });
});

describe("validación, límites y disponibilidad", () => {
  it("cuerpo inválido -> 400", async () => {
    const h = await harness([{ text: "x" }]);
    const tok = h.ctx.staff.owner.token;
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
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "a".repeat(700) }));
    expect(((await res.json()) as DataChatAnswer).status).toBe("invalid_input");
    expect(h.llmRequests).toHaveLength(0);
  });

  it("rate limit por usuario/organización: responde rate_limited sin llamar al LLM", async () => {
    const keys: string[] = [];
    const h = await harness([{ text: "x" }], { limiter: { allow: async (k) => (keys.push(k), false) } });
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "ventas" }));
    expect(((await res.json()) as DataChatAnswer).status).toBe("rate_limited");
    expect(keys[0]).toContain(h.ctx.organizationId);
    expect(keys[0]).toContain(h.ctx.staff.owner.id);
    expect(h.llmRequests).toHaveLength(0);
  });

  it("tope mensual por organización agotado -> budget_exceeded (200, mensaje honesto)", async () => {
    const h = await harness([() => new MonthlyBudgetExceededError("organization", "org", 10, 5)]);
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "ventas" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("budget_exceeded");
  });

  it("sin proveedor LLM configurado: 'no disponible' honesto y estado available=false", async () => {
    const h = await harness([{ text: "x" }], { completion: undefined });
    // `completion: undefined` explícito debe significar "sin proveedor" -> se reconstruye sin pasar el default.
    const ctx = h.ctx;
    const app = buildApp({ ...ctx.deps, dataChat: { restaurantesReader: () => h.reader, audit: () => ({ record: async () => {} }), rateLimiter: { allow: async () => true }, completion: undefined } });
    const res = await app.request(url(h), post(ctx.staff.owner.token, { question: "ventas" }));
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("unavailable");
    expect(body.text).toContain("todavía no está activado");
    const estado = await app.request(url(h, "/estado"), authedGet(ctx.staff.owner.token));
    expect(await estado.json()).toEqual({ available: false });
  });

  it("estado available=true con proveedor y 403 para repartidor", async () => {
    const h = await harness([{ text: "x" }]);
    expect(await (await h.app.request(url(h, "/estado"), authedGet(h.ctx.staff.owner.token))).json()).toEqual({ available: true });
    expect((await h.app.request(url(h, "/estado"), authedGet(h.ctx.staff.repartidor.token))).status).toBe(403);
  });

  it("sin deps.dataChat en absoluto (despliegue viejo/test): 'no disponible', nunca 500", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/chat-datos`, post(ctx.staff.owner.token, { question: "ventas" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("unavailable");
  });
});
