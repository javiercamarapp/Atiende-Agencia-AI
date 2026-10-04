// QA restaurantes, ronda 1, lente CAOS (3-oct-2026): la LLAMADA de voz cuando el POS (SoftRestaurant) esta lento o caido.
// Regresiones de QA-restaurantes-R1-caos-13 (POS colgado: el servidor responde dentro del presupuesto de la tool) y caos-14 (reintento tras un
// crear_pedido incierto devuelve el pedido existente con su id).
// Se usa el ejecutor de tools REAL de la llamada (crearEjecutorTools + transporteHttp) contra la API real en memoria y la maquina
// de la llamada (CallStateMachine), con el adaptador FALSO del POS (sin red, sin base real). `it.fails` = defecto confirmado.
import { describe, expect, it } from "vitest";
import { CallStateMachine, LIMITES_POR_DEFECTO, crearEjecutorTools, transporteHttp } from "@atiende/domain-restaurantes";
import { FakeSoftRestaurantAdapter, InMemoryComandaOutboxStore, MapaProductoCodigo, crearResolverSucursalPos, type SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const ORG = "los-taquitos-de-pm";
const LEGACY = { "x-atiende-tool-secret": "test-voice-tool-secret" };

/** API con la bandera de SoftRestaurant ACTIVA y un POS que tarda `latenciaPosMs` en contestar (o nunca, con Infinity). */
async function setup(latenciaPosMs: number, opciones: { demoraRespuestaMs?: number; timeoutToolMs?: number } = {}) {
  const base = await buildTestDeps();
  const store = new InMemoryComandaOutboxStore();
  store.ponerModo(base.organizationId, "activo");
  const fake = new FakeSoftRestaurantAdapter();
  const lento = new Proxy(fake, {
    get: (t, p, r) => {
      if (p === "esReal") return true;
      if (p === "crearComanda") {
        return async (...args: unknown[]) => {
          if (Number.isFinite(latenciaPosMs)) await new Promise((ok) => setTimeout(ok, latenciaPosMs));
          else await new Promise(() => undefined);
          return (Reflect.get(t, p, r) as (...a: unknown[]) => Promise<unknown>).apply(t, args);
        };
      }
      return Reflect.get(t, p, r);
    },
  }) as unknown as SoftRestaurantPort;
  const deps: AppDeps = {
    ...base.deps,
    softRestaurantStore: () => store,
    softRestaurantPort: lento,
    softRestaurantMapeo: { resolverCodigos: new MapaProductoCodigo([{ productId: base.products.cocaCola!, codigo: "FAKE-003" }]), resolverSucursal: crearResolverSucursalPos({ [base.propertyId]: "T7" }) },
  };
  const app = buildApp(deps);
  const mint = await app.request(`/v1/restaurantes/${ORG}/voice/call-token`, jsonRequestInit({ call_id: `caos-${Date.now()}`, caller_phone: "9993334444", branch_slug: "fco-montejo" }, LEGACY));
  const callToken = ((await mint.json()) as { call_token: string }).call_token;
  const enVuelo: Promise<unknown>[] = [];
  let demoradoUnaVez = false; // solo el PRIMER POST /orders llega tarde; el reintento contesta a tiempo
  // El worker de voz habla HTTP con la API; aqui el "fetch" es la app en proceso. Un abort del ejecutor NO detiene al servidor
  // (como en produccion: la funcion sigue corriendo aunque el worker deje de esperar).
  const fetchFn = ((url: string, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    const p = Promise.resolve(app.request(url, { ...init, signal: undefined, headers: { ...(init?.headers as Record<string, string>), "content-length": String(new TextEncoder().encode(raw).byteLength) } }));
    enVuelo.push(p);
    // Red lenta entre la API y el worker: la respuesta llega despues de que el worker dejo de esperar, pero el servidor SI proceso la peticion.
    const demora = opciones.demoraRespuestaMs && url.endsWith("/orders") && !demoradoUnaVez;
    if (demora) demoradoUnaVez = true;
    return demora ? new Promise((ok, mal) => setTimeout(() => p.then(ok, mal), opciones.demoraRespuestaMs)) : p;
  }) as unknown as typeof fetch;
  const ejecutor = crearEjecutorTools({ transporte: transporteHttp({ baseUrl: "http://api.local", orgSlug: ORG, callToken, fetchFn }), timeoutMs: opciones.timeoutToolMs ?? LIMITES_POR_DEFECTO.toolTimeoutMs });
  const pedidos = async () => (await base.restaurantesRepo.listOrders(base.organizationId, { propertyIds: null, limit: 50 })).orders;
  const items = [{ product_id: base.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  const pedido = { branch_slug: "fco-montejo", customer_name: "Carla", payment_method: "efectivo", canal: "recoger", items };
  return { ...base, app, ejecutor, enVuelo, pedidos, items, pedido, fake };
}

async function cotizarYConfirmar(s: Awaited<ReturnType<typeof setup>>) {
  const q = await s.ejecutor.ejecutar("cotizar_pedido", { branch_slug: "fco-montejo", items: s.items, canal: "recoger" });
  expect(q.ok).toBe(true);
  const c = await s.ejecutor.ejecutar("confirmar_resumen", { quote_hash: (q.resultado as { quote_hash: string }).quote_hash });
  expect(c.ok).toBe(true);
}

describe("caos de voz: POS lento durante crear_pedido", () => {
  it("PASA: POS sano (5 ms) -> crear_pedido sale bien con id y la llamada cierra como pedido_creado", async () => {
    const s = await setup(5);
    await cotizarYConfirmar(s);
    const maquina = new CallStateMachine();
    maquina.recibir({ tipo: "conectada" });
    const r = await s.ejecutor.ejecutar("crear_pedido", s.pedido);
    maquina.recibir({ tipo: "tool_resultado", nombre: "crear_pedido", ok: r.ok, orderId: r.orderId, timeout: r.timeout });
    maquina.recibir({ tipo: "cliente_cuelga" });
    expect(r.ok).toBe(true);
    expect(maquina.resultado).toBe("pedido_creado");
  });

  // QA-restaurantes-R1-caos-13: con la bandera de SoftRestaurant en "activo", POST /orders de voz espera EN LINEA a la comanda del POS
  // (tope 4000 ms, outbox-service `timeoutInlineMs`) y antes manda el correo en linea. El ejecutor de la llamada corta cada tool a los
  // mismos 4000 ms (LIMITES_POR_DEFECTO.toolTimeoutMs). Resultado: con el POS lento o caido TODO pedido por telefono expira del lado de
  // la llamada como "incierto" aunque el pedido SI quedo creado; el agente le dice al cliente que "una persona verificara".
  it("QA-caos-13: POS colgado -> el servidor responde crear_pedido dentro del presupuesto de la tool de voz", async () => {
    const s = await setup(Number.POSITIVE_INFINITY);
    await cotizarYConfirmar(s);
    const t0 = Date.now();
    const res = await s.app.request(`/v1/restaurantes/${ORG}/orders`, jsonRequestInit(s.pedido, { "x-atiende-call-token": (await mintOtro(s)).token }));
    const ms = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(LIMITES_POR_DEFECTO.toolTimeoutMs);
  }, 15_000);

  // QA-restaurantes-R1-caos-14: tras un crear_pedido "incierto", el agente vuelve a intentar (o el cliente insiste) y el servidor contesta
  // 400 "ya quedo registrado" SIN el id del pedido: el ejecutor lo cuenta como error, la maquina nunca marca el objetivo y la llamada cierra
  // como "abandonado"/"escalado" con un pedido real ya en cocina (KPI de voz falso y callback innecesario). El storefront, en el mismo
  // caso, devuelve `ya_registrado` con el rastreo.
  it("QA-caos-14: crear_pedido incierto + reintento -> la llamada termina como pedido_creado con el id del pedido real", async () => {
    const s = await setup(5, { demoraRespuestaMs: 400, timeoutToolMs: 100 });
    await cotizarYConfirmar(s);
    const maquina = new CallStateMachine();
    maquina.recibir({ tipo: "conectada" });
    const r1 = await s.ejecutor.ejecutar("crear_pedido", s.pedido);
    maquina.recibir({ tipo: "tool_resultado", nombre: "crear_pedido", ok: r1.ok, orderId: r1.orderId, timeout: r1.timeout });
    expect(r1.timeout).toBe(true);
    await Promise.allSettled(s.enVuelo);
    const r2 = await s.ejecutor.ejecutar("crear_pedido", s.pedido);
    maquina.recibir({ tipo: "tool_resultado", nombre: "crear_pedido", ok: r2.ok, orderId: r2.orderId, timeout: r2.timeout });
    maquina.recibir({ tipo: "cliente_cuelga" });
    expect(await s.pedidos()).toHaveLength(1);
    expect(r2.timeout).toBe(false);
    expect(r2.orderId).toBe((await s.pedidos())[0]!.id);
    expect(maquina.resultado).toBe("pedido_creado");
  }, 20_000);

  it("PASA: crear_pedido incierto + reintento NUNCA crea un segundo pedido ni una segunda comanda", async () => {
    const s = await setup(5, { demoraRespuestaMs: 400, timeoutToolMs: 100 });
    await cotizarYConfirmar(s);
    const r1 = await s.ejecutor.ejecutar("crear_pedido", s.pedido);
    expect(r1.timeout).toBe(true);
    expect((r1.resultado as { incierto?: boolean }).incierto).toBe(true);
    await Promise.allSettled(s.enVuelo);
    await s.ejecutor.ejecutar("crear_pedido", s.pedido);
    await Promise.allSettled(s.enVuelo);
    expect(await s.pedidos()).toHaveLength(1);
    expect(s.fake.comandas.length).toBeLessThanOrEqual(1);
  }, 20_000);
});

/** POS que tarda mas que el tope en linea (4000 ms) pero termina: lo tipico de un POS sobrecargado en hora pico. */
const LEGACY_POS_LENTO_MS = 4_500;

async function mintOtro(s: Awaited<ReturnType<typeof setup>>): Promise<{ token: string }> {
  // Llamada nueva con su propia cotizacion y confirmacion, para medir solo el POST /orders directo (sin el ejecutor).
  const mint = await s.app.request(`/v1/restaurantes/${ORG}/voice/call-token`, jsonRequestInit({ call_id: `caos-directo-${Date.now()}`, caller_phone: "9995556666", branch_slug: "fco-montejo" }, LEGACY));
  const token = ((await mint.json()) as { call_token: string }).call_token;
  const h = { "x-atiende-call-token": token };
  const q = (await (await s.app.request(`/v1/restaurantes/${ORG}/orders/quote`, jsonRequestInit({ branch_slug: "fco-montejo", items: s.items, canal: "recoger" }, h))).json()) as { quote_hash: string };
  await s.app.request(`/v1/restaurantes/${ORG}/orders/confirm`, jsonRequestInit({ quote_hash: q.quote_hash }, h));
  return { token };
}
