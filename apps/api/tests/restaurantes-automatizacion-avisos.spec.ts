// Avisos in-app del lote QA R1 automatizacion (restaurantes): -06 (entra a cocina), -07 (entra atrasado) y -11 (WhatsApp muerto).
// Todo con dobles (repos en memoria, FakeWhatsAppGraphClient); el espia solo observa `emitirNotificacion`.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryRestaurantesRepository, avisarProgramadosPromovidos, esPromocionAtrasada } from "@atiende/domain-restaurantes";
import { FakeSoftRestaurantAdapter, InMemoryComandaOutboxStore, type SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
import { FakeWhatsAppGraphClient, WhatsAppConfigError, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { dispatchWhatsAppVertical } from "../src/routes/internal/whatsapp-dispatch.ts";
import { TEST_ENV } from "./fixtures.ts";
import { buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

const emitidas: { evento: string; entidadId?: string | null; organizationId: string | null; clave: string }[] = [];
vi.mock("@atiende/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@atiende/db")>();
  return {
    ...real,
    emitirNotificacion: async (...args: Parameters<typeof real.emitirNotificacion>) => {
      const input = args[1] as { evento: string; entidadId?: string | null; organizationId: string | null; clave: string };
      emitidas.push({ evento: input.evento, entidadId: input.entidadId ?? null, organizationId: input.organizationId, clave: input.clave });
      return real.emitirNotificacion(...args);
    },
  };
});

const SECRET = { "x-atiende-internal-secret": TEST_ENV.internalSecret };
const haceMin = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("QA-restaurantes-R1-automatizacion-07: un programado vencido hace horas entra a cocina marcado como atrasado", () => {
  it("el cron avisa 'atrasado' (6 h) y 'entra a cocina' (a tiempo), uno por pedido y con la clave del pedido", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const store = new InMemoryComandaOutboxStore({ disponible: true });
    store.ponerModo(ctx.organizationId, "apagado");
    const port = new FakeSoftRestaurantAdapter() as unknown as SoftRestaurantPort;
    const tarde = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "programado", total: 100, programadoPara: haceMin(360), promovidoAt: null });
    const aTiempo = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "programado", total: 100, programadoPara: new Date(Date.now() + 10 * 60_000).toISOString(), promovidoAt: null });
    ctx.restaurantesRepo.seedOrder(tarde);
    ctx.restaurantesRepo.seedOrder(aTiempo);
    emitidas.length = 0;
    const app = buildApp({ ...ctx.deps, softRestaurantStore: () => store, softRestaurantPort: port });
    const r = (await (await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET })).json()) as { promoted: number; atrasadosCocina: number };
    expect(r.promoted).toBe(2);
    expect(r.atrasadosCocina).toBe(1);
    expect(emitidas.filter((e) => e.entidadId === tarde.id).map((e) => e.evento)).toEqual(["restaurantes.pedido.programado_atrasado"]);
    expect(emitidas.filter((e) => e.entidadId === aTiempo.id).map((e) => e.evento)).toEqual(["restaurantes.pedido.programado_en_cocina"]);
  });

  it("esPromocionAtrasada: umbral de 1 hora sobre la hora pedida", () => {
    const base = Date.parse("2026-10-03T20:00:00Z");
    const ord = (promovidoMin: number) => ({ programadoPara: new Date(base).toISOString(), promovidoAt: new Date(base + promovidoMin * 60_000).toISOString() });
    expect(esPromocionAtrasada(ord(-30))).toBe(false);
    expect(esPromocionAtrasada(ord(60))).toBe(false);
    expect(esPromocionAtrasada(ord(61))).toBe(true);
    expect(esPromocionAtrasada({ programadoPara: null, promovidoAt: null })).toBe(false);
  });

  it("no avisa de un pedido que no esta en cocina (programado o cancelado)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const o = (status: "programado" | "cancelado") => makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status, programadoPara: haceMin(5), promovidoAt: null });
    emitidas.length = 0;
    const r = await ctx.deps.engine.withAppSession({ userId: null }, (db) => avisarProgramadosPromovidos(ctx.deps.restaurantesRepo(db), db, [o("programado"), o("cancelado")]));
    expect(r).toEqual({ intentados: 0, bandeja: 0, errores: 0 });
    expect(emitidas).toHaveLength(0);
  });
});

describe("QA-restaurantes-R1-automatizacion-11: un WhatsApp que queda 'dead' avisa al staff", () => {
  function montar(graph: FakeWhatsAppGraphClient) {
    const repo = new InMemoryRestaurantesRepository();
    const orgId = randomUUID();
    repo.seedOrganization({ id: orgId, slug: "qa-wa11", name: "QA WA 11" });
    const db = {
      async exec() {},
      async query() {
        throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      },
    } as unknown as TenantDbSession;
    const engine = { async withAppSession<T>(_c: unknown, fn: (d: TenantDbSession) => Promise<T>): Promise<T> { return fn(db); } };
    const deps = { env: TEST_ENV, engine, whatsAppDispatcher: new WhatsAppOutboundDispatcher({ graphClient: graph }), restaurantesRepo: () => repo } as unknown as AppDeps;
    return { repo, orgId, deps };
  }

  it("un rechazo NO reintentable pasa a dead y emite restaurantes.whatsapp.mensaje_muerto con la clave del mensaje", async () => {
    const graph = new FakeWhatsAppGraphClient({ onSend: () => new WhatsAppConfigError("numero remitente invalido") });
    const { repo, orgId, deps } = montar(graph);
    await repo.enqueueMessagingOutbox(orgId, "whatsapp", "order.status", "qa-dead-1", { to: "5219990000001", phone_number_id: "123", body: "tu pedido va en camino", transaccional: true });
    emitidas.length = 0;
    const r = await dispatchWhatsAppVertical(deps, "restaurantes", 25);
    expect(r).toMatchObject({ dead: 1 });
    const fila = repo.getOutbox()[0]!;
    expect(fila.status).toBe("dead");
    expect(emitidas).toEqual([expect.objectContaining({ evento: "restaurantes.whatsapp.mensaje_muerto", organizationId: orgId, clave: expect.any(String) })]);
  });

  it("un envio exitoso no emite aviso", async () => {
    const { repo, orgId, deps } = montar(new FakeWhatsAppGraphClient());
    await repo.enqueueMessagingOutbox(orgId, "whatsapp", "order.status", "qa-ok-1", { to: "5219990000001", phone_number_id: "123", body: "hola", transaccional: true });
    emitidas.length = 0;
    await dispatchWhatsAppVertical(deps, "restaurantes", 25);
    expect(emitidas).toHaveLength(0);
  });
});
