// QA adversarial R1 -- lente AUTOMATIZACION de restaurantes (crons /internal, outbox, promociones, purgas).
//
// Cada `describe` lleva el id estable del hallazgo (ver ~/atiende-loop/work/qa/restaurantes/ronda-1-automatizacion.md).
// Los que dicen "ROJO hasta el fix" reproducen un defecto real y deben FALLAR hoy; los de "cobertura" pasan
// y fijan comportamiento que hoy es correcto (kill switch, solapamiento, idempotencia).
// Todo con dobles: FakeWhatsAppGraphClient, repos en memoria, motor fake; nunca red ni base real.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryRestaurantesRepository } from "@atiende/domain-restaurantes";
import type { PurgeOutcome, RestaurantesRepository } from "@atiende/domain-restaurantes";
import { FakeSoftRestaurantAdapter, InMemoryComandaOutboxStore, type SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
import { FakeWhatsAppGraphClient, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import type { InMemorySaludRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { createPlatformSwitchGuard } from "../src/platform-switches.ts";
import { dispatchWhatsAppVertical } from "../src/routes/internal/whatsapp-dispatch.ts";
import { withHeartbeat } from "../src/salud/with-heartbeat.ts";
import { TEST_ENV } from "./fixtures.ts";
import { buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

// Espia (sin cambiar el comportamiento) del productor compartido de notificaciones in-app.
const emitidas: { evento: string; entidadId?: string | null }[] = [];
vi.mock("@atiende/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@atiende/db")>();
  return {
    ...real,
    emitirNotificacion: async (...args: Parameters<typeof real.emitirNotificacion>) => {
      const input = args[1] as { evento: string; entidadId?: string | null };
      emitidas.push({ evento: input.evento, entidadId: input.entidadId ?? null });
      return real.emitirNotificacion(...args);
    },
  };
});

const SECRET = { "x-atiende-internal-secret": TEST_ENV.internalSecret };
const enMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

async function contextoProgramados(modo: "apagado" | "sombra" | "activo" = "sombra") {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const store = new InMemoryComandaOutboxStore({ disponible: true });
  store.ponerModo(ctx.organizationId, modo);
  const fake = new FakeSoftRestaurantAdapter();
  const port = new Proxy(fake, { get: (t, p, r) => (p === "esReal" ? true : Reflect.get(t, p, r)) }) as unknown as SoftRestaurantPort;
  const programado = (propertyId: string, minutos: number) => {
    const o = makeOrder({ organizationId: ctx.organizationId, propertyId, status: "programado", total: 100, programadoPara: enMin(minutos), promovidoAt: null });
    ctx.restaurantesRepo.seedOrder(o);
    return o;
  };
  return { ctx, store, port, programado };
}

async function latido(deps: AppDeps, cron: string) {
  const salud = deps.saludRepo as InMemorySaludRepository;
  const superId = randomUUID();
  salud.addPlatformSuperadmin(superId);
  return (await salud.listCronHeartbeatsForSuperadmin(superId)).find((h) => h.cronName === cron) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R1-automatizacion-01 (ROJO hasta el fix): el cron de WhatsApp no aisla por mensaje", () => {
  // Produccion: `dispatchWhatsAppVertical` abre UNA transaccion (`withAppSession`) para TODO el lote de la vertical:
  // reclamar, mandar por Graph API y marcar `sent`. Si a mitad de lote la sesion de BD falla (statement timeout,
  // corte del pooler) o la funcion serverless muere por maxDuration, el ROLLBACK deshace los `markSent` de mensajes
  // que YA llegaron al cliente: la siguiente corrida los vuelve a reclamar y los manda OTRA VEZ.
  //
  // Motor fake con la semantica de Postgres que importa: foto del outbox al abrir la transaccion, ROLLBACK si el
  // callback lanza, y sesion ABORTADA (25P02) tras el primer error SQL.
  function montar(fallarEnMarkSentNumero: number | null) {
    const repo = new InMemoryRestaurantesRepository();
    const orgId = randomUUID();
    repo.seedOrganization({ id: orgId, slug: "qa-wa", name: "QA WA" });
    const graph = new FakeWhatsAppGraphClient();
    let markSentsGlobal = 0; // cuenta los markSent de TODAS las sesiones (el fix abre una sesion por mensaje)
    const outboxDe = (r: InMemoryRestaurantesRepository) => (r as unknown as { outbox: Map<string, Record<string, unknown>> }).outbox;
    const engine = {
      async withAppSession<T>(_ctx: unknown, fn: (db: TenantDbSession) => Promise<T>): Promise<T> {
        const foto = new Map([...outboxDe(repo)].map(([k, v]) => [k, structuredClone(v)]));
        let abortada = false;
        const sqlFalla = (code: string) => Object.assign(new Error(code === "25P02" ? "current transaction is aborted" : "canceling statement due to statement timeout"), { code });
        const db = {
          async exec() {
            if (abortada) throw sqlFalla("25P02");
          },
          async query() {
            if (abortada) throw sqlFalla("25P02");
            throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); // guards de supresion/cuota/plantillas: base sin migrar
          },
        } as unknown as TenantDbSession;
        const repoSesion = new Proxy(repo, {
          get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            if (typeof v !== "function") return v;
            return async (...args: unknown[]) => {
              if (abortada) throw sqlFalla("25P02");
              if (prop === "markMessagingOutboxSent" && fallarEnMarkSentNumero !== null && ++markSentsGlobal === fallarEnMarkSentNumero) {
                abortada = true;
                throw sqlFalla("57014");
              }
              return (v as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        });
        sesionRepo = repoSesion as unknown as RestaurantesRepository;
        try {
          return await fn(db);
        } catch (err) {
          outboxDe(repo).clear();
          for (const [k, v] of foto) outboxDe(repo).set(k, v);
          throw err;
        }
      },
    };
    let sesionRepo: RestaurantesRepository = repo;
    const deps = {
      env: TEST_ENV,
      engine,
      whatsAppDispatcher: new WhatsAppOutboundDispatcher({ graphClient: graph }),
      restaurantesRepo: () => sesionRepo,
    } as unknown as AppDeps;
    return { repo, orgId, graph, deps };
  }

  async function encolar(repo: InMemoryRestaurantesRepository, orgId: string, n: number) {
    for (let i = 1; i <= n; i++) {
      await repo.enqueueMessagingOutbox(orgId, "whatsapp", "order.status", `qa-${i}`, { to: `52199900000${i}`, phone_number_id: "123", body: `mensaje ${i}`, transaccional: true });
    }
  }

  it("(cobertura) sin fallas: 3 mensajes, 3 envios, todos `sent`", async () => {
    const { repo, orgId, graph, deps } = montar(null);
    await encolar(repo, orgId, 3);
    const r = await dispatchWhatsAppVertical(deps, "restaurantes", 25);
    expect(r).toMatchObject({ claimed: 3, sent: 3 });
    expect(graph.sent).toHaveLength(3);
    expect(repo.getOutbox().every((o) => o.status === "sent")).toBe(true);
  });

  it("un error de BD al marcar el 2.o mensaje NO debe provocar que el 1.o (ya entregado) se mande otra vez", async () => {
    const { repo, orgId, graph, deps } = montar(2);
    await encolar(repo, orgId, 3);
    const primera = await dispatchWhatsAppVertical(deps, "restaurantes", 25);
    expect(primera, "el fallo de sesion del 2.o mensaje se reporta (errores), sin tumbar lo ya cerrado").toMatchObject({ errores: 1, sent: 2 });
    await dispatchWhatsAppVertical(deps, "restaurantes", 25); // siguiente corrida del cron (*/5)
    const enviosDelPrimero = graph.sent.filter((m) => m.body === "mensaje 1").length;
    expect(enviosDelPrimero, "el cliente recibio el mismo WhatsApp mas de una vez").toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R1-automatizacion-02 (ROJO hasta el fix): promovido a cocina sin comanda POS para siempre", () => {
  it("si encolar la comanda falla UNA vez, la siguiente corrida del cron la reintenta (no queda pending sin comanda)", async () => {
    const { ctx, store, port, programado } = await contextoProgramados("sombra");
    const original = store.encolar.bind(store);
    let llamadas = 0;
    store.encolar = async (...args: Parameters<typeof original>) => {
      llamadas += 1;
      if (llamadas === 1) throw new Error("falla transitoria simulada (pooler)");
      return original(...args);
    };
    const p = programado(ctx.propertyIdA, 10);
    const app = buildApp({ ...ctx.deps, softRestaurantStore: () => store, softRestaurantPort: port });
    const r1 = (await (await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET })).json()) as { promoted: number; comandas: { errores: number } };
    expect(r1).toMatchObject({ promoted: 1, comandas: { errores: 1 } });
    await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET });
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, p.id))?.status).toBe("pending");
    expect(store.todas().map((f) => f.orderId), "el pedido ya esta en cocina y su comanda nunca llego al outbox del POS").toEqual([p.id]);
  });

  it("el latido del cron no queda 'ok' limpio cuando comandas.errores > 0 (debe verse en /superadmin/salud)", async () => {
    const { ctx, store, port, programado } = await contextoProgramados("sombra");
    store.encolar = async () => {
      throw new Error("falla simulada");
    };
    programado(ctx.propertyIdA, 10);
    const deps: AppDeps = { ...ctx.deps, softRestaurantStore: () => store, softRestaurantPort: port };
    const app = buildApp(deps);
    await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET });
    const hb = await latido(deps, "/internal/restaurantes/promover-programados");
    expect(hb?.lastStatus, "una corrida con comandas perdidas se reporta como sana").toBe("error");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R1-automatizacion-04 (ROJO hasta el fix): la purga corta su bucle con un conteo que no incluye llamadas sin caller_hash", () => {
  // Modelo FIEL a restaurantes.system_purge_expired_privacy_data (042): por lote toma hasta `limit` llamadas vencidas
  // con turnos O caller_hash, borra sus turnos y anula caller_hash; y `out_voice_calls_anonymized` cuenta las llamadas
  // PROCESADAS (antes, 030, solo las que TENIAN caller_hash: el cron cortaba el bucle con 0). Las previews del panel y los numeros ocultos no tienen caller_hash (voz-interno.ts).
  // El verify SQL S1 (scripts/verify-restaurantes-automatizacion-crons) prueba ese conteo contra Postgres real.
  class PurgaModelo {
    pendientes: number;
    constructor(llamadasVencidasSinHash: number) {
      this.pendientes = llamadasVencidasSinHash;
    }
    async purgeExpiredPrivacyData(limit: number): Promise<PurgeOutcome> {
      const lote = Math.min(limit, this.pendientes);
      this.pendientes -= lote;
      return { disponible: true, conversationsCleared: 0, voiceTurnsDeleted: lote * 6, voiceCallsAnonymized: lote }; // 042: cuenta las llamadas PROCESADAS (con o sin caller_hash)
    }
  }

  it("1,200 llamadas vencidas sin caller_hash: una corrida diaria (tope 10 lotes de 500) debe dejar 0 pendientes", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const modelo = new PurgaModelo(1200);
    const app = buildApp({ ...ctx.deps, privacidadRepo: () => modelo as never });
    const res = (await (await app.request("/internal/restaurantes/privacidad-retencion", { method: "POST", headers: SECRET })).json()) as { lotes: number };
    expect(modelo.pendientes, `la corrida hizo ${res.lotes} lote(s) y dejo transcripciones vencidas`).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R1-automatizacion-06 (ROJO hasta el fix): nadie avisa cuando un pedido programado ENTRA a cocina", () => {
  it("la promocion del cron emite una notificacion in-app por pedido promovido (clave = pedido)", async () => {
    const { ctx, store, port, programado } = await contextoProgramados("apagado");
    const p = programado(ctx.propertyIdA, 10);
    const app = buildApp({ ...ctx.deps, softRestaurantStore: () => store, softRestaurantPort: port });
    emitidas.length = 0;
    const r = (await (await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET })).json()) as { promoted: number };
    expect(r.promoted).toBe(1);
    const delPedido = emitidas.filter((e) => e.evento.startsWith("restaurantes.") && e.entidadId === p.id);
    expect(delPedido, "el unico aviso del pedido fue al crearlo (dias antes); al entrar a cocina no sale nada").not.toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R1-automatizacion-09 (ROJO hasta el fix): softrestaurant-dispatch sin adaptador real responde 503 cada 5 min con latido 'ok'", () => {
  it("una corrida que responde 503 no queda registrada como corrida sana en /superadmin/salud", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps); // sin adaptador real (estado actual de produccion: falta credencial de SoftRestaurant)
    const res = await app.request("/internal/restaurantes/softrestaurant-dispatch", { method: "POST", headers: SECRET });
    expect(res.status).toBe(503);
    const hb = await latido(ctx.deps, "/internal/restaurantes/softrestaurant-dispatch");
    expect(hb?.lastStatus === "ok" && hb.lastError === null, "el panel de salud dice 'ok' sin nota mientras Vercel registra un 503 cada 5 minutos").toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("cobertura (pasa hoy): kill switch, solapamiento e idempotencia del cron de promocion", () => {
  it("kill switch del cron: no promueve, responde 200 skipped y el latido dice 'pausado'", async () => {
    const { ctx, store, port, programado } = await contextoProgramados("sombra");
    const p = programado(ctx.propertyIdA, 10);
    const deps: AppDeps = {
      ...ctx.deps,
      softRestaurantStore: () => store,
      softRestaurantPort: port,
      platformSwitchGuard: createPlatformSwitchGuard(async () => [{ scope: "cron", target: "/internal/restaurantes/promover-programados" }]),
    };
    const app = buildApp(deps);
    const res = await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, skipped: "kill_switch" });
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, p.id))?.status).toBe("programado");
    expect(store.todas()).toHaveLength(0);
    expect((await latido(deps, "/internal/restaurantes/promover-programados"))?.lastError).toMatch(/pausado/);
  });

  it("kill switch GLOBAL de crons tambien detiene la promocion y la purga", async () => {
    const { ctx, store, port, programado } = await contextoProgramados("sombra");
    programado(ctx.propertyIdA, 10);
    let purgas = 0;
    const deps: AppDeps = {
      ...ctx.deps,
      softRestaurantStore: () => store,
      softRestaurantPort: port,
      privacidadRepo: () =>
        ({
          async purgeExpiredPrivacyData() {
            purgas += 1;
            return { disponible: true, conversationsCleared: 0, voiceTurnsDeleted: 0, voiceCallsAnonymized: 0 };
          },
        }) as never,
      platformSwitchGuard: createPlatformSwitchGuard(async () => [{ scope: "global", target: "crons" }]),
    };
    const app = buildApp(deps);
    expect(await (await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET })).json()).toMatchObject({ skipped: "kill_switch" });
    expect(await (await app.request("/internal/restaurantes/privacidad-retencion", { method: "POST", headers: SECRET })).json()).toMatchObject({ skipped: "kill_switch" });
    expect(purgas).toBe(0);
  });

  it("dos corridas SIMULTANEAS del cron + el panel abierto: cada pedido se promueve y se encola una sola vez", async () => {
    const { ctx, store, port, programado } = await contextoProgramados("sombra");
    const ids = [programado(ctx.propertyIdA, 5).id, programado(ctx.propertyIdA, 15).id, programado(ctx.propertyIdB, 25).id];
    programado(ctx.propertyIdA, 600); // lejano: no entra
    const app = buildApp({ ...ctx.deps, softRestaurantStore: () => store, softRestaurantPort: port });
    const [a, b] = await Promise.all([
      Promise.resolve(app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET })).then((r) => r.json() as Promise<{ promoted: number }>),
      Promise.resolve(app.request("/internal/restaurantes/promover-programados", { method: "GET", headers: { authorization: `Bearer ${TEST_ENV.internalSecret}` } })).then((r) => r.json() as Promise<{ promoted: number }>),
    ]);
    expect(a.promoted + b.promoted).toBe(3);
    expect(store.todas().map((f) => f.orderId).sort()).toEqual([...ids].sort());
  });

  it("sin secreto: 401 y no promueve", async () => {
    const { ctx, programado } = await contextoProgramados("sombra");
    const p = programado(ctx.propertyIdA, 5);
    const app = buildApp(ctx.deps);
    expect((await app.request("/internal/restaurantes/promover-programados", { method: "POST" })).status).toBe(401);
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, p.id))?.status).toBe("programado");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("withHeartbeat: solo un 503 con la marca explicita cuenta como 'no configurado'", () => {
  it("un 503 sin la marca no se registra como latido ok sin nota ni como corrida sana: se trata como cualquier otra respuesta", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = new Hono();
    app.post("/x", async () => withHeartbeat(ctx.deps, "/internal/x-sin-marca", async () => Response.json({ ok: false }, { status: 503 }))());
    const res = await app.request("/x", { method: "POST" });
    expect(res.status).toBe(503);
    expect((await latido(ctx.deps, "/internal/x-sin-marca"))?.lastError ?? null).toBeNull();
  });
});
