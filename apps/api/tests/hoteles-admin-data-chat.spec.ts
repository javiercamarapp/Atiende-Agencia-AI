// POST/GET /hoteles/:propertyId/chat-datos — "Chatea con tus datos" de HOTELES.
// HTTP real vía app.request: auth, roles (solo owner/gm), aislamiento cross-tenant, alcance por membership (gm de
// un hotel), validación de cuerpo, rate limit, tope de presupuesto, zona horaria del hotel y bitácora. El LLM es
// un guion (`scriptedCompletion`): ningún test toca la red ni gasta.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scriptedCompletion, type DataChatAnswer, type DataChatCompletion, type DataChatAuditEntry, type DataChatRateLimiter, type ScriptStep } from "@atiende/agent-core/data-chat";
import { MonthlyBudgetExceededError } from "@atiende/agent-core";
import { InMemoryCoreRepository, InMemoryTenancyEngine, hashPassword } from "@atiende/db";
import { ZONA_HORARIA_NEGOCIO_DEFAULT } from "@atiende/core-tenancy";
import type { HotelesDataChatReader, HotelesDataChatWindow } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import type { DataChatDeps } from "../src/data-chat/deps.ts";
import { authedJson, buildHotelesTestContext, type HotelesTestContext } from "./hoteles-fixtures.ts";

const HOTEL_B_NAME = "Hotel Playa";

/** Lector en memoria que respeta el alcance igual que la base real: solo suma ocupación de los hoteles pedidos. */
class ScopedReader implements HotelesDataChatReader {
  readonly windows: HotelesDataChatWindow[] = [];
  constructor(
    private readonly hotels: readonly { propertyId: string; name: string }[],
    private readonly nights: Readonly<Record<string, number>>,
  ) {}
  async listVisibleHotels(_org: string, ids: readonly string[] | null) {
    return (ids === null ? this.hotels : this.hotels.filter((h) => ids.includes(h.propertyId))).map((h) => ({ ...h, slug: h.name }));
  }
  async occupancy(w: HotelesDataChatWindow) {
    this.windows.push(w);
    const ids = w.propertyIds ?? this.hotels.map((h) => h.propertyId);
    const occupied = ids.reduce((n, id) => n + (this.nights[id] ?? 0), 0);
    return occupied === 0 ? [] : [{ bucket: "2026-09-29", availableNights: ids.length * 20, occupiedNights: occupied, roomRevenue: occupied * 1000 }];
  }
  async revenue() { return []; }
  async arrivalsDepartures() { return []; }
  async cancellations() { return []; }
  async openTickets() { return []; }
  async housekeepingPending() { return []; }
}

interface Harness {
  readonly ctx: HotelesTestContext;
  readonly reader: ScopedReader;
  readonly audit: DataChatAuditEntry[];
  readonly llmRequests: ReturnType<typeof scriptedCompletion>["requests"];
  readonly app: ReturnType<typeof buildApp>;
  readonly propertyB: string;
  readonly staff: { readonly otroOrgOwner: string; readonly gmSoloHotelA: string };
}

async function signIn(app: ReturnType<typeof buildApp>, email: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  return ((await res.json()) as { token: string }).token;
}

async function harness(steps: ScriptStep[], over: { limiter?: DataChatRateLimiter; completion?: DataChatDeps["hotelesCompletion"]; reader?: boolean } = {}): Promise<Harness> {
  const ctx = await buildHotelesTestContext(buildApp);
  const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
  const engine = ctx.deps.engine as InMemoryTenancyEngine;
  // Segundo hotel de la MISMA organización y una organización ajena con su dueño.
  const propertyB = randomUUID();
  engine.seedProperty({ id: propertyB, organizationId: ctx.organizationId });
  const otherOrg = randomUUID();
  coreRepo.addOrganization({ id: otherOrg, slug: "hotel-ajeno", name: "Hotel Ajeno", vertical: "hoteles" });
  engine.seedProperty({ id: randomUUID(), organizationId: otherOrg });
  const password = "correcto-caballo-batería";
  async function seed(label: string, organizationId: string, platformRole: "owner" | "admin", verticalRole: string, propertyIds: string[] | null) {
    const id = randomUUID();
    coreRepo.addStaff({ id, email: `${label}@hotel-ajeno.mx`, fullName: label, passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addMembership({ userId: id, organizationId, platformRole, verticalRole, propertyIds });
    engine.seedMembership({ userId: id, organizationId, platformRole, verticalRole, propertyIds });
    return `${label}@hotel-ajeno.mx`;
  }
  const otroEmail = await seed("owner-ajeno", otherOrg, "owner", "owner", null);
  const gmEmail = await seed("gm-hotel-a", ctx.organizationId, "admin", "gm", [ctx.propertyId]);
  const reader = new ScopedReader(
    [
      { propertyId: ctx.propertyId, name: "Hotel Centro" },
      { propertyId: propertyB, name: HOTEL_B_NAME },
    ],
    { [ctx.propertyId]: 5, [propertyB]: 9 },
  );
  const audit: DataChatAuditEntry[] = [];
  const llm = scriptedCompletion(steps);
  const completion: DataChatCompletion = llm.complete;
  const dataChat: DataChatDeps = {
    restaurantesReader: () => {
      throw new Error("no se usa en hoteles");
    },
    ...(over.reader === false ? {} : { hotelesReader: () => reader }),
    audit: () => ({ record: async (e) => void audit.push(e) }),
    rateLimiter: over.limiter ?? { allow: async () => true },
    completion: undefined,
    hotelesCompletion: "completion" in over ? over.completion : () => completion,
  };
  const app = buildApp({ ...ctx.deps, dataChat });
  return {
    ctx,
    reader,
    audit,
    llmRequests: llm.requests,
    app,
    propertyB,
    staff: { otroOrgOwner: await signIn(app, otroEmail, password), gmSoloHotelA: await signIn(app, gmEmail, password) },
  };
}

const OCC: ScriptStep = { toolCalls: [{ name: "ocupacion_adr_revpar", argumentsJson: '{"periodo":"ultimos_30_dias"}' }] };
const post = (token: string, body: unknown) => authedJson(token, body);
const authedGet = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });
const url = (h: Harness, suffix = "") => `/hoteles/${h.ctx.propertyId}/chat-datos${suffix}`;

describe("auth y roles (solo owner y gm)", () => {
  it("401 sin token", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hola" }) });
    expect(res.status).toBe(401);
  });

  it("recepción, reservaciones, F&B, housekeeping y contabilidad -> 403 y el LLM no se invoca", async () => {
    const h = await harness([{ text: "x" }]);
    for (const role of ["frontdesk", "reservations", "fnb", "housekeeping", "accountant"] as const) {
      const res = await h.app.request(url(h), post(h.ctx.staff[role].token, { question: "ocupación" }));
      expect(res.status, role).toBe(403);
      const estado = await h.app.request(url(h, "/estado"), authedGet(h.ctx.staff[role].token));
      expect(estado.status, `${role} estado`).toBe(403);
    }
    expect(h.llmRequests).toHaveLength(0);
  });

  it("owner y gm sí pasan", async () => {
    const h = await harness([OCC, { text: "ok" }, OCC, { text: "ok" }]);
    expect((await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "ocupación del mes" }))).status).toBe(200);
    expect((await h.app.request(url(h), post(h.ctx.staff.gm.token, { question: "ocupación del mes" }))).status).toBe(200);
  });

  it("staff de OTRA organización -> 403 (cross-tenant)", async () => {
    const h = await harness([{ text: "x" }]);
    const res = await h.app.request(url(h), post(h.staff.otroOrgOwner, { question: "ocupación" }));
    expect(res.status).toBe(403);
    expect(h.llmRequests).toHaveLength(0);
  });
});

describe("alcance del servidor", () => {
  it("owner: todos los hoteles (propertyIds null), organización y zona del servidor, y respuesta con tabla + fuente", async () => {
    const h = await harness([OCC, { text: "La ocupación fue de 35.0% (14 de 40 noches)." }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "¿cómo va la ocupación del último mes?" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("ok");
    expect(body.blocks[0]!.rows[0]).toMatchObject({ periodo: "2026-09-29", noches_ocupadas: 14, ocupacion: 35 });
    expect(body.sources[0]).toMatchObject({ scopeLabel: "todos tus hoteles", tool: "ocupacion_adr_revpar" });
    expect(h.reader.windows[0]).toMatchObject({ propertyIds: null, organizationId: h.ctx.organizationId, timezone: ZONA_HORARIA_NEGOCIO_DEFAULT });
    expect(h.llmRequests[0]!.system).toContain(ZONA_HORARIA_NEGOCIO_DEFAULT);
  });

  it("la zona horaria sale de la configuración del hotel (America/Cancun), no del reloj del servidor", async () => {
    const h = await harness([OCC, { text: "ok" }]);
    await h.ctx.hotelesRepo.upsertPropertyTimezone(h.ctx.propertyId, h.ctx.organizationId, "America/Cancun", h.ctx.staff.owner.id);
    await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "ocupación del último mes" }));
    expect(h.reader.windows[0]!.timezone).toBe("America/Cancun");
  });

  it("gm de UN hotel: SOLO ve ese, aunque el modelo pida el otro por nombre", async () => {
    const h = await harness([OCC, { text: "ok" }]);
    const res = await h.app.request(url(h), post(h.staff.gmSoloHotelA, { question: "ocupación del último mes" }));
    const body = (await res.json()) as DataChatAnswer;
    expect(h.reader.windows[0]!.propertyIds).toEqual([h.ctx.propertyId]);
    expect(body.blocks[0]!.rows[0]).toMatchObject({ noches_ocupadas: 5 });
    expect(h.llmRequests[0]!.system).toContain("Hotel Centro");
    expect(h.llmRequests[0]!.system).not.toContain(HOTEL_B_NAME);

    const h2 = await harness([{ toolCalls: [{ name: "ocupacion_adr_revpar", argumentsJson: `{"periodo":"hoy","hotel":"${HOTEL_B_NAME}"}` }] }, { text: "Playa tuvo 9 noches" }]);
    const res2 = await h2.app.request(url(h2), post(h2.staff.gmSoloHotelA, { question: "ocupación de Playa hoy" }));
    const body2 = (await res2.json()) as DataChatAnswer;
    expect(body2.status).toBe("clarify");
    expect(JSON.stringify(body2)).not.toMatch(/Playa|9 noches/);
    expect(h2.reader.windows).toHaveLength(0);
  });

  it("la identidad del cuerpo NO cuenta: organizationId/propertyIds/userId en el body -> 400", async () => {
    const h = await harness([{ text: "x" }]);
    for (const extra of [{ organizationId: randomUUID() }, { propertyIds: [h.propertyB] }, { userId: "otro" }]) {
      const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "ocupación", ...extra }));
      expect(res.status).toBe(400);
    }
    expect(h.llmRequests).toHaveLength(0);
  });

  it("la bitácora registra al usuario del JWT, la herramienta y los parámetros — sin resultados ni la pregunta", async () => {
    const h = await harness([OCC, { text: "ok" }]);
    await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "ocupación del último mes" }));
    expect(h.audit[0]).toMatchObject({ organizationId: h.ctx.organizationId, userId: h.ctx.staff.owner.id, vertical: "hoteles", tool: "ocupacion_adr_revpar", params: { periodo: "ultimos_30_dias" }, outcome: "ok" });
    expect(JSON.stringify(h.audit)).not.toMatch(/5000|ocupación del último mes/);
  });

  it("pregunta fuera de catálogo (reservas por canal): lo dice sin cifras inventadas", async () => {
    const h = await harness([{ text: "Booking trajo 40 reservas." }]);
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "¿cuántas reservas por canal?" }));
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("out_of_catalog");
    expect(body.text).not.toMatch(/Booking|40/);
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
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "ocupación" }));
    expect(((await res.json()) as DataChatAnswer).status).toBe("rate_limited");
    expect(keys[0]).toContain(h.ctx.organizationId);
    expect(keys[0]).toContain(h.ctx.staff.owner.id);
    expect(h.llmRequests).toHaveLength(0);
  });

  it("tope mensual por organización agotado -> budget_exceeded (200, mensaje honesto)", async () => {
    const h = await harness([() => new MonthlyBudgetExceededError("organization", "org", 10, 5)]);
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "ocupación" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("budget_exceeded");
  });

  it("sin proveedor LLM de hoteles: 'no disponible' honesto y estado available=false", async () => {
    const h = await harness([{ text: "x" }], { completion: undefined });
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "ocupación" }));
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("unavailable");
    expect(body.text).toContain("todavía no está activado");
    expect(await (await h.app.request(url(h, "/estado"), authedGet(h.ctx.staff.owner.token))).json()).toEqual({ available: false });
  });

  it("deploy sin lector de hoteles (dataChat viejo): 'no disponible', nunca 500", async () => {
    const h = await harness([{ text: "x" }], { reader: false });
    const res = await h.app.request(url(h), post(h.ctx.staff.owner.token, { question: "ocupación" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("unavailable");
    expect(await (await h.app.request(url(h, "/estado"), authedGet(h.ctx.staff.owner.token))).json()).toEqual({ available: false });
  });

  it("estado available=true con proveedor y lector", async () => {
    const h = await harness([{ text: "x" }]);
    expect(await (await h.app.request(url(h, "/estado"), authedGet(h.ctx.staff.owner.token))).json()).toEqual({ available: true });
  });

  it("sin deps.dataChat en absoluto: 'no disponible', nunca 500", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/chat-datos`, post(ctx.staff.owner.token, { question: "ocupación" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("unavailable");
  });
});
