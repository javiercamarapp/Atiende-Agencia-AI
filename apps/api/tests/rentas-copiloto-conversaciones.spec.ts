// CHAT-10 -- historial lateral del Copiloto de RENTAS, por HTTP real (app.request) sobre la ruta compartida de las verticales por
// propiedad (verticalDataChatRoutes + mountConversacionesRoutes). El repositorio es un doble EN MEMORIA que aplica el mismo
// alcance que la base (autor + organizacion + vertical): el aislamiento a nivel RLS lo prueba
// scripts/verify-copiloto-conversaciones/ contra Postgres real. Aqui se prueba lo propio de rentas: solo admin_gestora y contador
// entran (operadores y limpieza reciben 403 en CADA ruta), cada quien ve unicamente sus chats, otra organizacion no entra, y la
// vertical guardada es "rentas". El LLM es un guion (`scriptedCompletion`): ningun test toca la red ni gasta.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scriptedCompletion, type DataChatHistoryTurn, type ScriptStep } from "@atiende/agent-core/data-chat";
import { InMemoryCoreRepository, hashPassword } from "@atiende/db";
import type { RentasDataChatReader } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import type { DataChatDeps } from "../src/data-chat/deps.ts";
import type {
  ConversacionDetalleDto,
  ConversacionResumenDto,
  ConversacionScope,
  ConversacionesRepository,
  MensajeGuardadoDto,
  ResultadoGuardado,
  TurnoAGuardar,
} from "../src/data-chat/conversaciones.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

class Reader implements RentasDataChatReader {
  async listVisibleProperties(_org: string, ids: readonly string[] | null) {
    return (ids ?? []).map((id) => ({ propertyId: id, name: "Edificio Centro", slug: "centro" }));
  }
  async incomeByChannel() { return [{ channel: "Airbnb", bookings: 2, nights: 6, grossCents: 120_000, channelFeeCents: 0, netCents: 120_000, otherCurrency: 0 }]; }
  async occupancyByUnit() { return []; }
  async incomeByOwner() { return []; }
  async openConflicts() { return []; }
  async pendingTasks() { return []; }
  async ownerStatements() { return []; }
  async channelPayouts() { return []; }
}

interface Stored {
  id: string;
  scope: ConversacionScope;
  titulo: string;
  mensajes: MensajeGuardadoDto[];
}

/** Doble en memoria: mismo contrato y mismo alcance (autor + organizacion + vertical) que la implementacion Postgres. */
class MemoryRepo implements ConversacionesRepository {
  disponible = true;
  readonly scopes: ConversacionScope[] = [];
  constructor(readonly store: Stored[]) {}
  private mine(scope: ConversacionScope, id: string): Stored | undefined {
    return this.store.find((c) => c.id === id && c.scope.userId === scope.userId && c.scope.organizationId === scope.organizationId && c.scope.vertical === scope.vertical);
  }
  async list(scope: ConversacionScope): Promise<{ disponible: boolean; items: ConversacionResumenDto[] }> {
    if (!this.disponible) return { disponible: false, items: [] };
    return {
      disponible: true,
      items: this.store
        .filter((c) => c.scope.userId === scope.userId && c.scope.organizationId === scope.organizationId && c.scope.vertical === scope.vertical)
        .map((c) => ({ id: c.id, titulo: c.titulo, actualizadaEn: "2026-10-01T12:00:00.000Z", mensajes: c.mensajes.length })),
    };
  }
  async get(scope: ConversacionScope, id: string): Promise<ConversacionDetalleDto | null> {
    const c = this.mine(scope, id);
    return c ? { id: c.id, titulo: c.titulo, actualizadaEn: "2026-10-01T12:00:00.000Z", mensajes: c.mensajes } : null;
  }
  async loadHistory(scope: ConversacionScope, id: string, limit: number): Promise<DataChatHistoryTurn[] | null> {
    const c = this.mine(scope, id);
    return c ? c.mensajes.slice(-limit).map((m) => ({ role: m.role, text: m.text })) : null;
  }
  async rename(scope: ConversacionScope, id: string, titulo: string): Promise<boolean> {
    const c = this.mine(scope, id);
    if (!c) return false;
    c.titulo = titulo;
    return true;
  }
  async remove(scope: ConversacionScope, id: string): Promise<boolean> {
    const c = this.mine(scope, id);
    if (!c) return false;
    this.store.splice(this.store.indexOf(c), 1);
    return true;
  }
  async append(scope: ConversacionScope, t: TurnoAGuardar): Promise<ResultadoGuardado> {
    this.scopes.push(scope);
    let c = t.conversationId ? this.mine(scope, t.conversationId) : undefined;
    if (t.conversationId && !c) return { guardado: false, motivo: "conversacion_no_encontrada" };
    if (!c) {
      c = { id: randomUUID(), scope, titulo: t.userText.slice(0, 60), mensajes: [] };
      this.store.push(c);
    }
    const base = c.mensajes.length;
    c.mensajes.push({ id: `${c.id}:${base + 1}`, role: "user", text: t.userText, seq: base + 1 });
    c.mensajes.push({ id: `${c.id}:${base + 2}`, role: "assistant", text: t.assistantText, seq: base + 2, status: t.status, blocks: [...t.blocks], sources: [...t.sources] });
    return { guardado: true, conversationId: c.id, seq: base + 2 };
  }
}

async function harness(steps: ScriptStep[]) {
  const ctx = await buildRentasTestContext(buildApp);
  const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
  const otherOrg = randomUUID();
  coreRepo.addOrganization({ id: otherOrg, slug: "gestora-ajena", name: "Gestora Ajena", vertical: "rentas" });
  ctx.engine.seedProperty({ id: randomUUID(), organizationId: otherOrg });
  const password = "correcto-caballo-batería";
  const ajenoId = randomUUID();
  coreRepo.addStaff({ id: ajenoId, email: "admin-ajeno@gestora-ajena.mx", fullName: "admin-ajeno", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addMembership({ userId: ajenoId, organizationId: otherOrg, platformRole: "owner", verticalRole: "admin_gestora", propertyIds: null });
  ctx.engine.seedMembership({ userId: ajenoId, organizationId: otherOrg, platformRole: "owner", verticalRole: "admin_gestora", propertyIds: null });

  const store: Stored[] = [];
  const repo = new MemoryRepo(store);
  const llm = scriptedCompletion(steps);
  const dataChat: DataChatDeps = {
    restaurantesReader: () => {
      throw new Error("no se usa en rentas");
    },
    rentasReader: () => new Reader(),
    audit: () => ({ record: async () => undefined }),
    rateLimiter: { allow: async () => true },
    completion: () => llm.complete,
    conversaciones: () => repo,
  };
  const app = buildApp({ ...ctx.deps, dataChat });
  const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin-ajeno@gestora-ajena.mx", password }) });
  const otraOrgToken = ((await login.json()) as { token: string }).token;
  return { ctx, app, repo, store, llm, otraOrgToken, propertyId: ctx.propertyId, adminToken: ctx.staff.adminGestora.token, contadorToken: ctx.staff.contador.token };
}
type H = Awaited<ReturnType<typeof harness>>;

const chat = (h: H, suffix = "") => `/rentas/${h.propertyId}/chat-datos${suffix}`;
const INCOME: ScriptStep = { toolCalls: [{ name: "ingresos_por_canal", argumentsJson: '{"periodo":"mes_pasado"}' }] };
const TURN: ScriptStep[] = [INCOME, { text: "El mes pasado ingresaste $1,200.00 MXN por canal." }];
const get = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });
const send = (token: string, method: "PATCH" | "DELETE", body?: unknown): RequestInit => ({
  method,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const ROLES_SIN_ACCESO = ["operadorAccesoTotal", "operadorSoloCalendario", "limpieza"] as const;

describe("historial del Copiloto de rentas: persistencia por usuario y organizacion", () => {
  it("el turno se guarda con vertical 'rentas', la organizacion y el usuario del JWT (nunca del cuerpo)", async () => {
    const h = await harness(TURN);
    const res = await h.app.request(chat(h), authedJson(h.adminToken, { question: "¿cuánto ingresé por canal el mes pasado?", conversationId: "new" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { guardado?: boolean; conversationId?: string; seq?: number };
    expect(body).toMatchObject({ guardado: true, seq: 2, conversationId: h.store[0]!.id });
    expect(h.repo.scopes[0]).toEqual({ organizationId: h.ctx.organizationId, userId: h.ctx.staff.adminGestora.id, vertical: "rentas" });
  });

  it("cada usuario lista SOLO sus chats: el contador no ve ni abre, renombra o borra los de la admin_gestora (404, y siguen ahi)", async () => {
    const h = await harness([...TURN, ...TURN]);
    await h.app.request(chat(h), authedJson(h.adminToken, { question: "de la admin", conversationId: "new" }));
    await h.app.request(chat(h), authedJson(h.contadorToken, { question: "del contador", conversationId: "new" }));
    const lista = async (token: string) => ((await (await h.app.request(chat(h, "/conversaciones"), get(token))).json()) as { disponible: boolean; conversaciones: ConversacionResumenDto[] }).conversaciones.map((c) => c.titulo);
    expect(await lista(h.adminToken)).toEqual(["de la admin"]);
    expect(await lista(h.contadorToken)).toEqual(["del contador"]);

    const idAdmin = h.store.find((c) => c.titulo === "de la admin")!.id;
    expect((await h.app.request(chat(h, `/conversaciones/${idAdmin}`), get(h.contadorToken))).status).toBe(404);
    expect((await h.app.request(chat(h, `/conversaciones/${idAdmin}`), send(h.contadorToken, "PATCH", { titulo: "robada" }))).status).toBe(404);
    expect((await h.app.request(chat(h, `/conversaciones/${idAdmin}`), send(h.contadorToken, "DELETE"))).status).toBe(404);
    expect(h.store.find((c) => c.id === idAdmin)?.titulo).toBe("de la admin");
    expect((await h.app.request(chat(h, `/conversaciones/${idAdmin}`), get(h.adminToken))).status).toBe(200);
  });

  it("continuar con el id de un chat ajeno -> 404 y el modelo NO se invoca", async () => {
    const h = await harness(TURN);
    await h.app.request(chat(h), authedJson(h.adminToken, { question: "de la admin", conversationId: "new" }));
    const llamadasAntes = h.llm.requests.length;
    const res = await h.app.request(chat(h), authedJson(h.contadorToken, { question: "sigo el ajeno", conversationId: h.store[0]!.id }));
    expect(res.status).toBe(404);
    expect(h.llm.requests).toHaveLength(llamadasAntes);
  });

  it("base sin migrar: lista vacia con disponible:false (nunca 500)", async () => {
    const h = await harness(TURN);
    h.repo.disponible = false;
    const res = await h.app.request(chat(h, "/conversaciones"), get(h.adminToken));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disponible: false, conversaciones: [] });
  });
});

describe("historial del Copiloto de rentas: roles y organizaciones", () => {
  it("401 sin token en listar, abrir, renombrar y borrar", async () => {
    const h = await harness(TURN);
    const id = randomUUID();
    expect((await h.app.request(chat(h, "/conversaciones"))).status).toBe(401);
    expect((await h.app.request(chat(h, `/conversaciones/${id}`))).status).toBe(401);
    expect((await h.app.request(chat(h, `/conversaciones/${id}`), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ titulo: "x" }) })).status).toBe(401);
    expect((await h.app.request(chat(h, `/conversaciones/${id}`), { method: "DELETE" })).status).toBe(401);
  });

  it.each(ROLES_SIN_ACCESO)("%s (operador/limpieza) -> 403 en estado, POST, listar, abrir, renombrar y borrar; nada se guarda ni se invoca el modelo", async (rol) => {
    const h = await harness(TURN);
    const token = h.ctx.staff[rol].token;
    const id = randomUUID();
    expect((await h.app.request(chat(h, "/estado"), get(token))).status).toBe(403);
    expect((await h.app.request(chat(h), authedJson(token, { question: "ingresos", conversationId: "new" }))).status).toBe(403);
    expect((await h.app.request(chat(h, "/conversaciones"), get(token))).status).toBe(403);
    expect((await h.app.request(chat(h, `/conversaciones/${id}`), get(token))).status).toBe(403);
    expect((await h.app.request(chat(h, `/conversaciones/${id}`), send(token, "PATCH", { titulo: "x" }))).status).toBe(403);
    expect((await h.app.request(chat(h, `/conversaciones/${id}`), send(token, "DELETE"))).status).toBe(403);
    expect(h.store).toHaveLength(0);
    expect(h.llm.requests).toHaveLength(0);
  });

  it("un admin de OTRA organizacion -> 403 en la ruta de esta propiedad (cross-tenant), tambien en el historial", async () => {
    const h = await harness(TURN);
    await h.app.request(chat(h), authedJson(h.adminToken, { question: "de la admin", conversationId: "new" }));
    expect((await h.app.request(chat(h, "/conversaciones"), get(h.otraOrgToken))).status).toBe(403);
    expect((await h.app.request(chat(h, `/conversaciones/${h.store[0]!.id}`), get(h.otraOrgToken))).status).toBe(403);
    expect((await h.app.request(chat(h, `/conversaciones/${h.store[0]!.id}`), send(h.otraOrgToken, "DELETE"))).status).toBe(403);
    expect(h.store).toHaveLength(1);
  });
});
