// CHAT-06 / CHAT-15 por HTTP real (hoteles): ruta directa sin modelo + cache, y fijados (alta, lista, compartir, borrar y
// re-ejecucion sin modelo con el alcance ACTUAL del usuario). El LLM es un guion que cuenta llamadas: ningun test toca la red.
// La RLS de los fijados (autor privado, compartidos solo si el autor es owner/admin, cross-tenant) la prueba
// scripts/verify-copiloto-cache-pins contra Postgres real; aqui se prueba lo que decide el servidor de la API.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryDataChatCacheStore, scriptedCompletion, type DataChatAnswer, type DataChatAuditEntry } from "@atiende/agent-core/data-chat";
import { InMemoryCoreRepository, InMemoryTenancyEngine, hashPassword } from "@atiende/db";
import type { HotelesDataChatReader, HotelesDataChatWindow } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildDataChatCache } from "../src/data-chat/cache.ts";
import type { DataChatDeps } from "../src/data-chat/deps.ts";
import type { PinDto, PinOrigen, PinScope, PinsRepository, ResultadoEdicionPin } from "../src/data-chat/pins.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";

class Reader implements HotelesDataChatReader {
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

/** Fijados en memoria que registra con que alcance lo llamo la ruta (la autorizacion real es la RLS). */
class FakePins implements PinsRepository {
  readonly scopes: PinScope[] = [];
  readonly pins = new Map<string, PinDto>();
  readonly origins = new Map<string, PinOrigen>();
  editResult: ResultadoEdicionPin = "ok";
  async list(scope: PinScope) { this.scopes.push(scope); return { disponible: true, items: [...this.pins.values()] }; }
  async get(scope: PinScope, id: string) { this.scopes.push(scope); return this.pins.get(id) ?? null; }
  async origin(_s: PinScope, conversationId: string, seq: number, bloque: number) { return this.origins.get(`${conversationId}:${seq}:${bloque}`) ?? null; }
  async create(scope: PinScope, input: { origin: PinOrigen }) {
    this.scopes.push(scope);
    const id = randomUUID();
    this.pins.set(id, { id, titulo: input.origin.title, herramienta: input.origin.tool, args: input.origin.args, compartido: false, propio: true, creadoEn: new Date().toISOString() });
    return { ok: true as const, id };
  }
  async update(scope: PinScope, id: string) { this.scopes.push(scope); return this.pins.has(id) ? this.editResult : ("no_encontrado" as const); }
  async remove(_s: PinScope, id: string) { return this.pins.delete(id); }
}

async function signIn(app: ReturnType<typeof buildApp>, email: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  return ((await res.json()) as { token: string }).token;
}

async function harness(over: { completion?: boolean } = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
  const engine = ctx.deps.engine as InMemoryTenancyEngine;
  const propertyB = randomUUID();
  engine.seedProperty({ id: propertyB, organizationId: ctx.organizationId });
  const otherOrg = randomUUID();
  coreRepo.addOrganization({ id: otherOrg, slug: "hotel-ajeno", name: "Hotel Ajeno", vertical: "hoteles" });
  engine.seedProperty({ id: randomUUID(), organizationId: otherOrg });
  const password = "correcto-caballo-batería";
  async function seed(label: string, organizationId: string, platformRole: "owner" | "admin", verticalRole: string, propertyIds: string[] | null) {
    const id = randomUUID();
    const email = `${label}@hotel-ajeno.mx`;
    coreRepo.addStaff({ id, email, fullName: label, passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addMembership({ userId: id, organizationId, platformRole, verticalRole, propertyIds });
    engine.seedMembership({ userId: id, organizationId, platformRole, verticalRole, propertyIds });
    return { id, email };
  }
  const otro = await seed("owner-ajeno", otherOrg, "owner", "owner", null);
  const gmA = await seed("gm-hotel-a", ctx.organizationId, "admin", "gm", [ctx.propertyId]);
  const reader = new Reader([{ propertyId: ctx.propertyId, name: "Hotel Centro" }, { propertyId: propertyB, name: "Hotel Playa" }], { [ctx.propertyId]: 5, [propertyB]: 9 });
  const audit: DataChatAuditEntry[] = [];
  const llm = scriptedCompletion([{ text: "no deberia llamarse" }]);
  const store = new MemoryDataChatCacheStore();
  const pins = new FakePins();
  const cache = buildDataChatCache(store)!;
  const dataChat: DataChatDeps = {
    restaurantesReader: () => {
      throw new Error("no se usa en hoteles");
    },
    hotelesReader: () => reader,
    audit: () => ({ record: async (e) => void audit.push(e) }),
    rateLimiter: { allow: async () => true },
    completion: over.completion === false ? undefined : llm.complete ? () => llm.complete : undefined,
    cache,
    pins: () => pins,
  };
  const app = buildApp({ ...ctx.deps, dataChat });
  return { ctx, reader, audit, llm, store, pins, app, propertyB, otroOrg: await signIn(app, otro.email, password), gmA: await signIn(app, gmA.email, password), gmAId: gmA.id };
}

type H = Awaited<ReturnType<typeof harness>>;
const url = (h: H, suffix = "") => `/hoteles/${h.ctx.propertyId}/chat-datos${suffix}`;
const get = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });
const send = (method: string, token: string, body?: unknown): RequestInit => ({
  method,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const OCC = { tool: "ocupacion_adr_revpar", args: { periodo: "ultimos_7_dias" } };

describe("ruta directa por HTTP (chip sin modelo)", () => {
  it("un chip se responde con tabla y fuente SIN llamar al modelo, incluso sin proveedor de IA configurado", async () => {
    const h = await harness({ completion: false });
    const res = await h.app.request(url(h), authedJson(h.ctx.staff.owner.token, { ...OCC, label: "¿Cómo va la ocupación esta semana?" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DataChatAnswer;
    expect(body.status).toBe("ok");
    expect(body.blocks[0]!.rows[0]).toMatchObject({ noches_ocupadas: 14 });
    expect(body.sources[0]).toMatchObject({ tool: "ocupacion_adr_revpar", scopeLabel: "todos tus hoteles" });
    expect(h.audit[0]).toMatchObject({ tool: "ocupacion_adr_revpar", params: { periodo: "ultimos_7_dias" }, route: "directa" });
  });

  it("con proveedor de IA tampoco lo llama (0 llamadas guionadas)", async () => {
    const h = await harness();
    await h.app.request(url(h), authedJson(h.ctx.staff.owner.token, OCC));
    expect(h.llm.requests).toHaveLength(0);
  });

  it("la segunda consulta igual sale de la cache (el lector corre UNA vez) y la bitacora lo registra", async () => {
    const h = await harness();
    const a = (await (await h.app.request(url(h), authedJson(h.ctx.staff.owner.token, OCC))).json()) as DataChatAnswer;
    const b = (await (await h.app.request(url(h), authedJson(h.ctx.staff.owner.token, OCC))).json()) as DataChatAnswer;
    expect(h.reader.windows).toHaveLength(1);
    expect(b.blocks).toEqual(a.blocks);
    expect(h.store.hits).toBe(1);
    expect(h.audit.map((e) => e.route)).toEqual(["directa", "cache"]);
  });

  it("el rol y el alcance de sucursales NO comparten entrada de cache", async () => {
    const h = await harness();
    await h.app.request(url(h), authedJson(h.ctx.staff.owner.token, OCC));
    const res = await h.app.request(url(h), authedJson(h.gmA, OCC));
    const gm = (await res.json()) as DataChatAnswer;
    expect(h.reader.windows).toHaveLength(2);
    expect(gm.blocks[0]!.rows[0]).toMatchObject({ noches_ocupadas: 5 }); // gm de UN hotel: solo ese
    expect(h.reader.windows[1]!.propertyIds).toEqual([h.ctx.propertyId]);
  });

  it("herramienta inexistente o argumentos invalidos: respuesta honesta sin ejecutar nada ni llamar al modelo", async () => {
    const h = await harness();
    const noExiste = (await (await h.app.request(url(h), authedJson(h.ctx.staff.owner.token, { tool: "borrar_todo" }))).json()) as DataChatAnswer;
    expect(noExiste.status).toBe("invalid_input");
    const malArg = (await (await h.app.request(url(h), authedJson(h.ctx.staff.owner.token, { tool: "ocupacion_adr_revpar", args: { periodo: "el_ano_que_viene" } }))).json()) as DataChatAnswer;
    expect(malArg.status).toBe("clarify");
    // Un argumento que el esquema de la herramienta no declara (p. ej. un id de organizacion) se rechaza en el motor...
    const ajeno = (await (await h.app.request(url(h), authedJson(h.ctx.staff.owner.token, { tool: "ocupacion_adr_revpar", args: { organizacion: randomUUID() } }))).json()) as DataChatAnswer;
    expect(ajeno.status).toBe("clarify");
    // ...y las claves con forma de identificador de tenant ni siquiera pasan la validacion del cuerpo.
    expect((await h.app.request(url(h), authedJson(h.ctx.staff.owner.token, { tool: "ocupacion_adr_revpar", args: { organizationId: randomUUID() } }))).status).toBe(400);
    expect(h.reader.windows).toHaveLength(0);
    expect(h.llm.requests).toHaveLength(0);
  });

  it("`args` o `label` sin `tool` -> 400; roles sin acceso -> 403; otra organizacion -> 403", async () => {
    const h = await harness();
    expect((await h.app.request(url(h), authedJson(h.ctx.staff.owner.token, { question: "x", args: { periodo: "hoy" } }))).status).toBe(400);
    expect((await h.app.request(url(h), authedJson(h.ctx.staff.owner.token, { question: "x", label: "x" }))).status).toBe(400);
    expect((await h.app.request(url(h), authedJson(h.ctx.staff.frontdesk.token, OCC))).status).toBe(403);
    expect((await h.app.request(url(h), authedJson(h.otroOrg, OCC))).status).toBe(403);
    expect(h.reader.windows).toHaveLength(0);
  });
});

describe("fijados por HTTP", () => {
  const CONV = randomUUID();

  it("sin token 401; recepcion y otra organizacion 403 en TODAS las rutas de fijados", async () => {
    const h = await harness();
    const id = randomUUID();
    const rutas: [string, string, unknown?][] = [
      ["GET", "/pins"],
      ["POST", "/pins", { conversationId: CONV, seq: 2, bloque: 0 }],
      ["PATCH", `/pins/${id}`, { compartido: true }],
      ["DELETE", `/pins/${id}`],
      ["GET", `/pins/${id}/resultado`],
    ];
    for (const [method, path, body] of rutas) {
      expect((await h.app.request(url(h, path), { method })).status, `${method} ${path} sin token`).toBe(401);
      expect((await h.app.request(url(h, path), send(method, h.ctx.staff.frontdesk.token, body))).status, `${method} ${path} recepcion`).toBe(403);
      expect((await h.app.request(url(h, path), send(method, h.otroOrg, body))).status, `${method} ${path} otra org`).toBe(403);
    }
  });

  it("alta: la herramienta y los argumentos salen del mensaje guardado, no del cuerpo; el alcance es el del JWT", async () => {
    const h = await harness();
    h.pins.origins.set(`${CONV}:2:0`, { tool: "ocupacion_adr_revpar", args: { periodo: "ultimos_30_dias" }, title: "Ocupación" });
    const res = await h.app.request(url(h, "/pins"), send("POST", h.ctx.staff.owner.token, { conversationId: CONV, seq: 2, bloque: 0 }));
    expect(res.status).toBe(201);
    expect(h.pins.scopes[0]).toEqual({ organizationId: h.ctx.organizationId, userId: h.ctx.staff.owner.id, vertical: "hoteles" });
    const lista = (await (await h.app.request(url(h, "/pins"), get(h.ctx.staff.owner.token))).json()) as { disponible: boolean; pins: PinDto[] };
    expect(lista.pins).toHaveLength(1);
    expect(lista.pins[0]).toMatchObject({ titulo: "Ocupación", herramienta: "ocupacion_adr_revpar", args: { periodo: "ultimos_30_dias" } });
    // El cliente no puede inyectar herramienta, argumentos ni ids.
    for (const extra of [{ tool: "x" }, { args: { periodo: "hoy" } }, { organizationId: randomUUID() }, { userId: "otro" }]) {
      const mal = await h.app.request(url(h, "/pins"), send("POST", h.ctx.staff.owner.token, { conversationId: CONV, seq: 2, bloque: 0, ...extra }));
      expect(mal.status).toBe(400);
    }
  });

  it("alta de un mensaje inexistente o ajeno -> 404; de una herramienta que ya no esta en el catalogo -> 404", async () => {
    const h = await harness();
    expect((await h.app.request(url(h, "/pins"), send("POST", h.ctx.staff.owner.token, { conversationId: CONV, seq: 2, bloque: 0 }))).status).toBe(404);
    h.pins.origins.set(`${CONV}:2:0`, { tool: "herramienta_retirada", args: {}, title: "x" });
    expect((await h.app.request(url(h, "/pins"), send("POST", h.ctx.staff.owner.token, { conversationId: CONV, seq: 2, bloque: 0 }))).status).toBe(404);
    h.pins.origins.set(`${CONV}:3:0`, { tool: "ocupacion_adr_revpar", args: { periodo: "nunca" }, title: "x" });
    expect((await h.app.request(url(h, "/pins"), send("POST", h.ctx.staff.owner.token, { conversationId: CONV, seq: 3, bloque: 0 }))).status).toBe(404);
    expect(h.pins.pins.size).toBe(0);
  });

  it("re-ejecucion: SIN modelo, con cache, y con el alcance ACTUAL de quien abre el tablero", async () => {
    const h = await harness({ completion: false });
    const id = randomUUID();
    h.pins.pins.set(id, { id, titulo: "Ocupación", herramienta: "ocupacion_adr_revpar", args: { periodo: "ultimos_30_dias" }, compartido: true, propio: false, creadoEn: new Date().toISOString() });
    const owner = (await (await h.app.request(url(h, `/pins/${id}/resultado`), get(h.ctx.staff.owner.token))).json()) as DataChatAnswer & { titulo: string };
    expect(owner.status).toBe("ok");
    expect(owner.titulo).toBe("Ocupación");
    expect(owner.blocks[0]!.rows[0]).toMatchObject({ noches_ocupadas: 14 });
    // El gm de UN hotel abre el mismo fijado compartido: ve SOLO su hotel, no lo que vio el owner.
    const gm = (await (await h.app.request(url(h, `/pins/${id}/resultado`), get(h.gmA))).json()) as DataChatAnswer;
    expect(gm.blocks[0]!.rows[0]).toMatchObject({ noches_ocupadas: 5 });
    expect(JSON.stringify(gm)).not.toMatch(/14/);
    // Segunda apertura del owner: cache (el lector no corre otra vez).
    await h.app.request(url(h, `/pins/${id}/resultado`), get(h.ctx.staff.owner.token));
    expect(h.reader.windows).toHaveLength(2);
    expect(h.llm.requests).toHaveLength(0);
    expect(h.audit.map((e) => e.route)).toEqual(["directa", "directa", "cache"]);
  });

  it("un fijado cuya herramienta ya no existe se re-ejecuta como respuesta honesta, nunca un 500", async () => {
    const h = await harness();
    const id = randomUUID();
    h.pins.pins.set(id, { id, titulo: "Vieja", herramienta: "herramienta_retirada", args: {}, compartido: false, propio: true, creadoEn: new Date().toISOString() });
    const res = await h.app.request(url(h, `/pins/${id}/resultado`), get(h.ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).status).toBe("invalid_input");
  });

  it("compartir: sin permiso (autor no owner/admin) -> 403; ok -> 200; id mal formado o ajeno -> 404; cuerpo ajeno -> 400", async () => {
    const h = await harness();
    const id = randomUUID();
    h.pins.pins.set(id, { id, titulo: "x", herramienta: "ocupacion_adr_revpar", args: {}, compartido: false, propio: true, creadoEn: new Date().toISOString() });
    h.pins.editResult = "sin_permiso";
    expect((await h.app.request(url(h, `/pins/${id}`), send("PATCH", h.gmA, { compartido: true }))).status).toBe(403);
    h.pins.editResult = "ok";
    const ok = await h.app.request(url(h, `/pins/${id}`), send("PATCH", h.ctx.staff.owner.token, { compartido: true }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id, compartido: true });
    expect((await h.app.request(url(h, "/pins/no-es-uuid"), send("PATCH", h.ctx.staff.owner.token, { compartido: true }))).status).toBe(404);
    expect((await h.app.request(url(h, `/pins/${randomUUID()}`), send("PATCH", h.ctx.staff.owner.token, { compartido: true }))).status).toBe(404);
    expect((await h.app.request(url(h, `/pins/${id}`), send("PATCH", h.ctx.staff.owner.token, { author: "otro" }))).status).toBe(400);
  });

  it("borrar: 204 y despues 404", async () => {
    const h = await harness();
    const id = randomUUID();
    h.pins.pins.set(id, { id, titulo: "x", herramienta: "t", args: {}, compartido: false, propio: true, creadoEn: new Date().toISOString() });
    expect((await h.app.request(url(h, `/pins/${id}`), send("DELETE", h.ctx.staff.owner.token))).status).toBe(204);
    expect((await h.app.request(url(h, `/pins/${id}`), send("DELETE", h.ctx.staff.owner.token))).status).toBe(404);
  });
});
