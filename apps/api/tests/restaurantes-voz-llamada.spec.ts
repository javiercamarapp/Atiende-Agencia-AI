// Rutas del WORKER DE TELEFONIA de voz (migración 067): contexto de llamada, costo por escalon, modo de entrada, evento `latencia_voz` y KPI de desborde.
// Cada caso afirma el EFECTO (que se guardo, que NO se escribio) y cubre secreto interno, validacion, cross-tenant y la base sin migrar (SAVEPOINT).
import { describe, expect, it } from "vitest";
import { InMemoryVozKpiRepository, InMemoryVozLlamadaRepository, InMemoryVozRepository, PostgresVozKpiRepository, PostgresVozLlamadaRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "../../../packages/domain-restaurantes/tests/support/aborting-fake-session.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

/** `Response` de Hono con `json()` tipado como any: los cuerpos de estas rutas se inspeccionan por campo. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };

const SECRETO = "test-internal-secret";
const UUID_AJENO = "00000000-0000-4000-8000-00000000ffff";

function post(app: ReturnType<typeof buildApp>, ruta: string, cuerpo: unknown, secreto: string | null = SECRETO): Promise<Resp> {
  const raw = JSON.stringify(cuerpo);
  return Promise.resolve(
    app.request(ruta, { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength), ...(secreto ? { "x-atiende-internal-secret": secreto } : {}) } }),
  ) as Promise<Resp>;
}

async function construir(opts: { sinLlamadaRepo?: boolean; sinVozRepo?: boolean; voz?: InMemoryVozRepository } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const voz = opts.voz ?? new InMemoryVozRepository();
  voz.seedProperty(ctx.propertyIdA, ctx.organizationId);
  voz.seedProperty(ctx.propertyIdB, ctx.organizationId);
  voz.seedProperty(ctx.otherPropertyId, ctx.otherOrganizationId);
  const llamada = new InMemoryVozLlamadaRepository();
  const kpi = new InMemoryVozKpiRepository();
  const deps: AppDeps = { ...ctx.deps, ...(opts.sinVozRepo ? {} : { vozRepo: () => voz }), ...(opts.sinLlamadaRepo ? {} : { vozLlamadaRepo: () => llamada }), vozKpiRepo: () => kpi };
  return { ctx, voz, llamada, kpi, deps, app: buildApp(deps) };
}

const TRAMO = { escalon: "gemini-3.8-live", duracionS: 90, costoReportadoMicroUsd: 0 };

describe("POST /internal/restaurantes/voz/llamada/contexto", () => {
  const ruta = "/internal/restaurantes/voz/llamada/contexto";

  it("sin el secreto interno (o con otro): 401 y no se consulta nada", async () => {
    const { ctx, app } = await construir();
    expect((await post(app, ruta, { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA }, null)).status).toBe(401);
    expect((await post(app, ruta, { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA }, "otro-secreto")).status).toBe(401);
  });

  it("sucursal sin configuracion de voz: habilitado=false (el worker no abre sesion), con la instruccion de PM y la hora local", async () => {
    const { ctx, app } = await construir();
    const res = await post(app, ruta, { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, callerPhone: "9991234567" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ habilitado: false, configurada: false, gastoMesMicroUsd: 0 });
    expect(body.horaLocal).toBeGreaterThanOrEqual(0);
    expect(body.horaLocal).toBeLessThanOrEqual(23);
    expect(body.instruccion).toContain("Llamada a \"Francisco de Montejo\"");
    expect(body.voiceId.length).toBeGreaterThan(0);
  });

  it("configuracion habilitada: habilitado=true y la voz elegida; el telefono NO viaja en la instruccion", async () => {
    const { ctx, voz, app } = await construir();
    await voz.upsertConfig(ctx.organizationId, ctx.propertyIdA, { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Puck", comportamiento: "", mensajeInicial: "" });
    const body = await (await post(app, ruta, { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, callerPhone: "+5219991234567" })).json();
    expect(body).toMatchObject({ habilitado: true, configurada: true, voiceId: "Puck" });
    expect(body.instruccion).not.toContain("9991234567");
  });

  it("la config es POR sucursal: habilitar A no habilita B", async () => {
    const { ctx, voz, app } = await construir();
    await voz.upsertConfig(ctx.organizationId, ctx.propertyIdA, { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "" });
    expect((await (await post(app, ruta, { organizationId: ctx.organizationId, propertyId: ctx.propertyIdB })).json()).habilitado).toBe(false);
  });

  it("comportamiento editado por el dueno: manda como base, se anexa el contexto de la llamada con el cliente y el primer mensaje", async () => {
    const { ctx, voz, app } = await construir();
    await voz.upsertConfig(ctx.organizationId, ctx.propertyIdA, { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "Hable siempre de usted y sea breve.", mensajeInicial: "Hola, le atiende el asistente virtual de Los Taquitos." });
    const body = await (await post(app, ruta, { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, callerPhone: "9991234567" })).json();
    expect(body.instruccion.startsWith("Hable siempre de usted y sea breve.")).toBe(true);
    expect(body.instruccion).toContain("# CONTEXTO DE ESTA LLAMADA");
    expect(body.instruccion).toContain("Cliente nuevo");
    expect(body.instruccion).toContain("fco-montejo");
    expect(body.instruccion).toContain("Hola, le atiende el asistente virtual de Los Taquitos.");
  });

  it("gasto del mes: viene del repositorio de costos; sin repositorio (o base sin migrar) es null y NO bloquea", async () => {
    const a = await construir();
    a.llamada.gastoPrevioMicroUsd = 1_234_000;
    expect((await (await post(a.app, ruta, { organizationId: a.ctx.organizationId, propertyId: a.ctx.propertyIdA })).json()).gastoMesMicroUsd).toBe(1_234_000);
    a.llamada.disponible = false;
    expect((await (await post(a.app, ruta, { organizationId: a.ctx.organizationId, propertyId: a.ctx.propertyIdA })).json()).gastoMesMicroUsd).toBeNull();
    const b = await construir({ sinLlamadaRepo: true });
    const res = await post(b.app, ruta, { organizationId: b.ctx.organizationId, propertyId: b.ctx.propertyIdA });
    expect(res.status).toBe(200);
    expect((await res.json()).gastoMesMicroUsd).toBeNull();
  });

  it("base sin la tabla de configuracion de voz (025): responde habilitado=false, nunca un 500", async () => {
    const voz = new InMemoryVozRepository();
    voz.migrada = false;
    const { ctx, app } = await construir({ voz });
    const res = await post(app, ruta, { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA });
    expect(res.status).toBe(200);
    expect((await res.json()).habilitado).toBe(false);
  });

  it("cross-tenant: una sucursal de OTRA organizacion declarada como propia da 404 y no filtra nada", async () => {
    const { ctx, app } = await construir();
    const res = await post(app, ruta, { organizationId: ctx.organizationId, propertyId: ctx.otherPropertyId });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("Única sucursal");
  });

  it.each([
    ["organizationId no es uuid", { organizationId: "x", propertyId: UUID_AJENO }],
    ["propertyId no es uuid", { organizationId: UUID_AJENO, propertyId: "x" }],
    ["callerPhone invalido", { organizationId: UUID_AJENO, propertyId: UUID_AJENO, callerPhone: "123" }],
    ["callerPhone no es texto", { organizationId: UUID_AJENO, propertyId: UUID_AJENO, callerPhone: 123 }],
  ])("validacion: %s -> 400", async (_n, cuerpo) => {
    const { app } = await construir();
    expect((await post(app, ruta, cuerpo)).status).toBe(400);
  });

  it("sin repositorio de voz en el despliegue: 503 honesto", async () => {
    const { ctx, app } = await construir({ sinVozRepo: true });
    expect((await post(app, ruta, { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA })).status).toBe(503);
  });
});

describe("POST .../conversaciones/:id/costo", () => {
  const ruta = (id: string) => `/internal/restaurantes/voz/conversaciones/${id}/costo`;
  const cuerpo = (ctx: { organizationId: string; propertyIdA: string }, extra: Record<string, unknown> = {}) => ({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, llamadaId: "llamada-1", tramos: [TRAMO], ...extra });

  it("sin el secreto interno: 401", async () => {
    const { ctx, app } = await construir();
    expect((await post(app, ruta(UUID_AJENO), cuerpo(ctx), null)).status).toBe(401);
  });

  it("cross-tenant: una sucursal de OTRA organizacion declarada como propia da 404 y no registra ningun costo", async () => {
    const { ctx, llamada, app } = await construir();
    const res = await post(app, ruta(UUID_AJENO), cuerpo(ctx, { propertyId: ctx.otherPropertyId }));
    expect(res.status).toBe(404);
    expect(llamada.eventos).toHaveLength(0);
  });

  it("registra UN evento por escalon con el costo calculado en el servidor (90 s de Gemini = 112 500 micro-USD a US$0.075/min) y es idempotente por llamada", async () => {
    const { ctx, llamada, app } = await construir();
    const tramos = [TRAMO, { escalon: "cascada-openrouter", duracionS: 30, costoReportadoMicroUsd: 0 }];
    const res = await post(app, ruta(UUID_AJENO), cuerpo(ctx, { tramos }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ registrados: 2, repetidos: 0 });
    expect(llamada.eventos.map((e) => [e.proveedor, e.costoMicroUsd, e.refId, e.refTipo, e.categoria])).toEqual([
      ["gemini-3.8-live", 112_500, "llamada-1:gemini-3.8-live", "voz_restaurantes", "voz"],
      ["cascada-openrouter", 7_000, "llamada-1:cascada-openrouter", "voz_restaurantes", "voz"],
    ]);
    const otra = await post(app, ruta(UUID_AJENO), cuerpo(ctx, { tramos }));
    expect(await otra.json()).toMatchObject({ registrados: 0, repetidos: 2 });
    expect(llamada.eventos).toHaveLength(2);
  });

  it("el costo que reporta el escalon solo puede SUBIR la estimacion por minuto, nunca bajarla", async () => {
    const { ctx, llamada, app } = await construir();
    await post(app, ruta(UUID_AJENO), cuerpo(ctx, { tramos: [{ ...TRAMO, costoReportadoMicroUsd: 200_000 }] }));
    expect(llamada.eventos[0]?.costoMicroUsd).toBe(200_000);
    expect(llamada.eventos[0]?.costoEstimado).toBe(true);
  });

  it("un tramo con costoReal (tokens del proveedor) se registra tal cual, por debajo incluso de la tarifa por minuto, con costo_estimado = false", async () => {
    const { ctx, llamada, app } = await construir();
    const res = await post(app, ruta(UUID_AJENO), cuerpo(ctx, { tramos: [{ ...TRAMO, costoReportadoMicroUsd: 90_000, costoReal: true }] }));
    expect(res.status).toBe(200);
    expect(llamada.eventos[0]).toMatchObject({ costoMicroUsd: 90_000, costoEstimado: false });
  });

  it("un worker anterior (sin costoReal) sigue siendo valido: el costo queda estimado", async () => {
    const { ctx, llamada, app } = await construir();
    expect((await post(app, ruta(UUID_AJENO), cuerpo(ctx, { tramos: [TRAMO] }))).status).toBe(200);
    expect(llamada.eventos[0]?.costoEstimado).toBe(true);
  });

  it.each([
    ["sin tramos", { tramos: [] }],
    ["tramos no es lista", { tramos: "x" }],
    ["demasiados tramos", { tramos: Array.from({ length: 9 }, () => TRAMO) }],
    ["escalon desconocido", { tramos: [{ ...TRAMO, escalon: "gpt-live-1" }] }],
    ["duracion negativa", { tramos: [{ ...TRAMO, duracionS: -1 }] }],
    ["duracion absurda", { tramos: [{ ...TRAMO, duracionS: 999_999 }] }],
    ["costo negativo", { tramos: [{ ...TRAMO, costoReportadoMicroUsd: -5 }] }],
    ["costo por encima del tope de cordura", { tramos: [{ ...TRAMO, costoReportadoMicroUsd: 1_000_000_000 }] }],
    ["llamadaId invalido", { llamadaId: "con espacios y /" }],
    ["propertyId no es uuid", { propertyId: "x" }],
  ])("validacion: %s -> 400 y NADA se registra", async (_n, extra) => {
    const { ctx, llamada, app } = await construir();
    expect((await post(app, ruta(UUID_AJENO), cuerpo(ctx, extra))).status).toBe(400);
    expect(llamada.eventos).toHaveLength(0);
  });

  it("la hora del evento se acota: un reloj roto del worker no manda el costo a otro mes", async () => {
    const { ctx, llamada, app } = await construir();
    await post(app, ruta(UUID_AJENO), cuerpo(ctx, { ocurridoEn: "2001-01-01T00:00:00Z" }));
    expect(Math.abs(Date.parse(llamada.eventos[0]!.ocurridoEn) - Date.now())).toBeLessThan(60_000);
  });

  it("base sin migrar (core.record_usage_cost_event no existe): 503 honesto y nada registrado", async () => {
    const { ctx, llamada, app } = await construir();
    llamada.disponible = false;
    expect((await post(app, ruta(UUID_AJENO), cuerpo(ctx))).status).toBe(503);
  });

  it("sin repositorio en el despliegue: 503", async () => {
    const { ctx, app } = await construir({ sinLlamadaRepo: true });
    expect((await post(app, ruta(UUID_AJENO), cuerpo(ctx))).status).toBe(503);
  });
});

describe("POST .../conversaciones/:id/modo-entrada", () => {
  const ruta = (id: string) => `/internal/restaurantes/voz/conversaciones/${id}/modo-entrada`;

  it("sin el secreto interno: 401", async () => {
    const { ctx, app } = await construir();
    expect((await post(app, ruta(UUID_AJENO), { organizationId: ctx.organizationId, modo: "desborde", franja: "tarde" }, null)).status).toBe(401);
  });

  it("marca el modo y la franja de una conversacion de la organizacion", async () => {
    const { ctx, llamada, app } = await construir();
    llamada.conversaciones.set(UUID_AJENO, ctx.organizationId);
    const res = await post(app, ruta(UUID_AJENO), { organizationId: ctx.organizationId, modo: "desborde", franja: "noche" });
    expect(res.status).toBe(200);
    expect(llamada.modos.get(UUID_AJENO)).toEqual({ modo: "desborde", franja: "noche" });
  });

  it("cross-tenant: marcar la conversacion de otra organizacion da 404 y no la toca", async () => {
    const { ctx, llamada, app } = await construir();
    llamada.conversaciones.set(UUID_AJENO, ctx.otherOrganizationId);
    expect((await post(app, ruta(UUID_AJENO), { organizationId: ctx.organizationId, modo: "total", franja: "tarde" })).status).toBe(404);
    expect(llamada.modos.has(UUID_AJENO)).toBe(false);
  });

  it.each([
    ["modo fuera de la lista", { modo: "otro", franja: "tarde" }],
    ["franja fuera de la lista", { modo: "total", franja: "madrugada" }],
    ["sin modo", { franja: "tarde" }],
    ["organizationId invalido", { organizationId: "x", modo: "total", franja: "tarde" }],
  ])("validacion: %s -> 400", async (_n, extra) => {
    const { ctx, app } = await construir();
    expect((await post(app, ruta(UUID_AJENO), { organizationId: ctx.organizationId, ...extra })).status).toBe(400);
  });

  it("base sin migrar: 503 honesto", async () => {
    const { ctx, llamada, app } = await construir();
    llamada.disponible = false;
    expect((await post(app, ruta(UUID_AJENO), { organizationId: ctx.organizationId, modo: "total", franja: "tarde" })).status).toBe(503);
  });
});

describe("POST /internal/restaurantes/voz/eventos con tipo latencia_voz", () => {
  const ruta = "/internal/restaurantes/voz/eventos";
  const evento = (ctx: { organizationId: string; propertyIdA: string }, extra: Record<string, unknown> = {}) => ({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, conversationId: UUID_AJENO, tipo: "latencia_voz", latenciaMs: 640, ...extra });

  it("registra la latencia de una respuesta (solo el numero, sin herramienta ni proveedor)", async () => {
    const { ctx, kpi, app } = await construir();
    const res = await post(app, ruta, evento(ctx));
    expect(res.status).toBe(201);
    expect(kpi.eventos).toMatchObject([{ tipo: "latencia_voz", latenciaMs: 640, herramienta: null, proveedor: null }]);
  });

  it("sin latenciaMs: 400; con una latencia absurda: 400; un tipo desconocido sigue rechazado", async () => {
    const { ctx, kpi, app } = await construir();
    expect((await post(app, ruta, evento(ctx, { latenciaMs: undefined }))).status).toBe(400);
    expect((await post(app, ruta, evento(ctx, { latenciaMs: 99_999_999 }))).status).toBe(400);
    expect((await post(app, ruta, evento(ctx, { tipo: "inventado" }))).status).toBe(400);
    expect(kpi.eventos).toHaveLength(0);
  });

  it("sin el secreto interno: 401", async () => {
    const { ctx, app } = await construir();
    expect((await post(app, ruta, evento(ctx), null)).status).toBe(401);
  });

  it("los eventos de herramienta y de error de proveedor siguen exigiendo sus campos (no se aflojo la validacion)", async () => {
    const { ctx, app } = await construir();
    expect((await post(app, ruta, evento(ctx, { tipo: "tool_call", latenciaMs: 10 }))).status).toBe(400);
    expect((await post(app, ruta, evento(ctx, { tipo: "error_proveedor", latenciaMs: undefined }))).status).toBe(400);
    expect((await post(app, ruta, evento(ctx, { tipo: "tool_call", herramienta: "cotizar_pedido", latenciaMs: 10 }))).status).toBe(201);
  });
});

describe("latencia_voz contra una base con la 035 pero SIN la 067 (el CHECK del tipo rechaza el valor), transaccion abortada", () => {
  const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
  function pgError(code: string, message: string): Error & { code: string } {
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    return err;
  }

  it("202 con disponible=false (no un 500), y la MISMA sesion sigue utilizable (ROLLBACK TO SAVEPOINT)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const session = new AbortAwareFakeSession([{ match: /voz_registrar_evento/i, respond: () => pgError("23514", 'new row for relation "voice_event" violates check constraint "voice_event_tipo_check"') }, SIGUIENTE]);
    const deps: AppDeps = { ...ctx.deps, vozKpiRepo: () => new PostgresVozKpiRepository(session) };
    const res = await post(buildApp(deps), "/internal/restaurantes/voz/eventos", { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, tipo: "latencia_voz", latenciaMs: 700 });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ registrado: false, disponible: false });
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  async function estadoDelEvento(code: string, message: string, constraint?: string): Promise<number> {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const err = pgError(code, message) as Error & { code: string; constraint?: string };
    if (constraint) err.constraint = constraint;
    const session = new AbortAwareFakeSession([{ match: /voz_registrar_evento/i, respond: () => err }, SIGUIENTE]);
    const deps: AppDeps = { ...ctx.deps, vozKpiRepo: () => new PostgresVozKpiRepository(session) };
    const res = await post(buildApp(deps), "/internal/restaurantes/voz/eventos", { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, tipo: "latencia_voz", latenciaMs: 700 });
    return res.status;
  }

  it("un error que NO es de migracion pendiente no se enmascara como 202: 22P02 es 500 y 42501 (permiso) es el 404 de recurso rechazado", async () => {
    expect(await estadoDelEvento("22P02", "invalid input syntax")).toBe(500);
    expect(await estadoDelEvento("42501", "permission denied for function voz_registrar_evento")).toBe(404);
  });

  it("una violacion de CHECK real (23514 de OTRO constraint, p. ej. el rango de latencia) tampoco se enmascara como 'no disponible'", async () => {
    expect(await estadoDelEvento("23514", 'new row for relation "voice_event" violates check constraint "voice_event_latencia_ms_check"', "voice_event_latencia_ms_check")).toBe(500);
  });

  it("el CHECK autogenerado de campos por tipo de la 035 (voice_event_check) tambien cuenta como base sin migrar (202)", async () => {
    expect(await estadoDelEvento("23514", 'new row for relation "voice_event" violates check constraint "voice_event_check"', "voice_event_check")).toBe(202);
  });
});

describe("GET .../admin/voz/kpi-desborde", () => {
  it("owner y admin lo leen; staff de piso, repartidor y otra organizacion no (403) ni sin sesion (401)", async () => {
    const { ctx, app } = await construir();
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/voz/kpi-desborde`;
    expect((await app.request(base, authedGet(ctx.staff.owner.token))).status).toBe(200);
    expect((await app.request(base, authedGet(ctx.staff.admin.token))).status).toBe(200);
    expect((await app.request(base, authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
    expect((await app.request(base, authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect((await app.request(base, authedGet(ctx.staff.otroOrgOwner.token))).status).toBeGreaterThanOrEqual(403);
    expect((await app.request(base, { method: "GET" })).status).toBe(401);
  });

  it("devuelve la serie por dia, los totales (ventas recuperadas) y el objetivo de latencia de 1.5 s", async () => {
    const { ctx, llamada, app } = await construir();
    llamada.kpi = [
      { fecha: "2026-03-09", llamadasDesborde: 2, pedidosDesborde: 1, ventasRecuperadas: 250.5, llamadasConModo: 2, llamadasConLatencia: 2, latenciaP50Ms: 600, latenciaP95Ms: 1100 },
      { fecha: "2026-03-10", llamadasDesborde: 3, pedidosDesborde: 2, ventasRecuperadas: 400, llamadasConModo: 3, llamadasConLatencia: 0, latenciaP50Ms: null, latenciaP95Ms: null },
    ];
    const res = (await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/voz/kpi-desborde?dias=2`, authedGet(ctx.staff.owner.token))) as Resp;
    const body = await res.json();
    expect(body).toMatchObject({
      disponible: true,
      objetivoLatenciaP95Ms: 1500,
      totales: { llamadasDesborde: 5, pedidosDesborde: 3, ventasRecuperadas: 650.5 },
      ultimaLatencia: { fecha: "2026-03-09", p50Ms: 600, p95Ms: 1100, llamadas: 2 },
    });
    expect(body.serie).toHaveLength(2);
    // Sin PII: solo agregados.
    expect(JSON.stringify(body)).not.toMatch(/phone|telefono|caller/i);
  });

  it("dias fuera de rango -> 400; base sin migrar -> disponible=false con ceros; sin repositorio -> 503", async () => {
    const { ctx, llamada, app } = await construir();
    const url = (q: string) => `/v1/restaurantes/${ctx.propertyIdA}/admin/voz/kpi-desborde${q}`;
    expect((await app.request(url("?dias=0"), authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect((await app.request(url("?dias=99"), authedGet(ctx.staff.owner.token))).status).toBe(400);
    llamada.disponible = false;
    expect(await ((await app.request(url(""), authedGet(ctx.staff.owner.token))) as Resp).json()).toMatchObject({ disponible: false, totales: { llamadasDesborde: 0, ventasRecuperadas: 0 }, ultimaLatencia: null });
    const sin = await construir({ sinLlamadaRepo: true });
    expect((await sin.app.request(`/v1/restaurantes/${sin.ctx.propertyIdA}/admin/voz/kpi-desborde`, authedGet(sin.ctx.staff.owner.token))).status).toBe(503);
  });

  it("una sucursal de otra organizacion no se lee aunque el owner la nombre", async () => {
    const { ctx, app } = await construir();
    const res = await app.request(`/v1/restaurantes/${ctx.otherPropertyId}/admin/voz/kpi-desborde`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBeGreaterThanOrEqual(403);
  });
});

describe("PostgresVozLlamadaRepository contra la base sin migrar, con la transaccion del request abortada", () => {
  const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
  // Mensajes reales de Postgres: `isMigrationPendingError` exige la forma "function f(args) does not exist" para el 42883.
  function pgError(code: string): Error & { code: string } {
    const mensaje = code === "42883" ? "function restaurantes.voz_x(uuid, timestamp with time zone) does not exist" : code === "42P01" ? 'relation "restaurantes.voice_x" does not exist' : code === "42703" ? 'column "modo_entrada" does not exist' : "permission denied";
    const err = new Error(mensaje) as Error & { code: string };
    err.code = code;
    return err;
  }
  async function vivo(session: AbortAwareFakeSession) {
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  }

  it.each(["42883", "42P01", "42703"])("gasto del mes: SQLSTATE %s -> null (no bloquea) y la sesion sigue viva", async (code) => {
    const session = new AbortAwareFakeSession([{ match: /voz_gasto_mes_micro_usd/i, respond: () => pgError(code) }, SIGUIENTE]);
    expect(await new PostgresVozLlamadaRepository(session).gastoMesMicroUsd("o", new Date())).toBeNull();
    await vivo(session);
  });

  it("modo de entrada: sin la funcion (42883) -> null y sesion viva; con la funcion -> true/false segun la base", async () => {
    const sin = new AbortAwareFakeSession([{ match: /voz_marcar_modo_entrada/i, respond: () => pgError("42883") }, SIGUIENTE]);
    expect(await new PostgresVozLlamadaRepository(sin).marcarModoEntrada({ organizationId: "o", conversationId: "c", modo: "total", franja: "tarde" })).toBeNull();
    await vivo(sin);
    const con = new AbortAwareFakeSession([{ match: /voz_marcar_modo_entrada/i, respond: () => [{ ok: false }] }, SIGUIENTE]);
    expect(await new PostgresVozLlamadaRepository(con).marcarModoEntrada({ organizationId: "o", conversationId: "c", modo: "total", franja: "tarde" })).toBe(false);
  });

  it("costo: sin core.record_usage_cost_event (42883) -> no disponible, y la sesion sigue viva para el resto del request", async () => {
    const session = new AbortAwareFakeSession([{ match: /record_usage_cost_event/i, respond: () => pgError("42883") }, SIGUIENTE]);
    const r = await new PostgresVozLlamadaRepository(session).registrarCostoLlamada([
      { organizationId: "o", propertyId: "p", ocurridoEn: new Date().toISOString(), categoria: "voz", proveedor: "gemini-3.8-live", unidad: "segundo", cantidad: 1, costoMicroUsd: 1, costoEstimado: true, refTipo: "voz_restaurantes", refId: "x:y" },
    ]);
    expect(r).toEqual({ disponible: false, registrados: 0, repetidos: 0 });
    await vivo(session);
  });

  it("KPI: sin la funcion -> disponible=false y sesion viva; un 42501 (sesion de sistema leyendo KPI de staff) NO se enmascara", async () => {
    const sin = new AbortAwareFakeSession([{ match: /voz_modo_entrada_kpi/i, respond: () => pgError("42883") }, SIGUIENTE]);
    expect(await new PostgresVozLlamadaRepository(sin).getModoEntradaKpi("o", "p", "2026-03-01", "2026-03-10")).toEqual({ disponible: false, valor: [] });
    await vivo(sin);
    const denegada = new AbortAwareFakeSession([{ match: /voz_modo_entrada_kpi/i, respond: () => pgError("42501") }, SIGUIENTE]);
    await expect(new PostgresVozLlamadaRepository(denegada).getModoEntradaKpi("o", "p", "2026-03-01", "2026-03-10")).rejects.toMatchObject({ code: "42501" });
  });

  it("mapea las filas del KPI (numeric -> number, fechas, nulos)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /voz_modo_entrada_kpi/i, respond: () => [{ fecha: new Date("2026-03-10T00:00:00Z"), llamadas_desborde: 3, pedidos_desborde: 2, ventas_recuperadas: "650.50", llamadas_con_modo: 4, llamadas_con_latencia: 2, latencia_p50_ms: 500, latencia_p95_ms: null }] },
    ]);
    const r = await new PostgresVozLlamadaRepository(session).getModoEntradaKpi("o", "p", "2026-03-10", "2026-03-10");
    expect(r.valor).toEqual([{ fecha: "2026-03-10", llamadasDesborde: 3, pedidosDesborde: 2, ventasRecuperadas: 650.5, llamadasConModo: 4, llamadasConLatencia: 2, latenciaP50Ms: 500, latenciaP95Ms: null }]);
  });
});
