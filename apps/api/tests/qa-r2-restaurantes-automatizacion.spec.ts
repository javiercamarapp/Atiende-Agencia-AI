// QA adversarial R2 -- lente AUTOMATIZACION de restaurantes (tick del autopiloto dentro de promover-programados, agotados,
// pedido grande, avance desde el POS, latido). Reporte: ~/atiende-loop/work/qa/restaurantes/ronda-2-automatizacion.md.
//
// Los `describe` "ROJO hasta el fix" reproducen un defecto real y FALLAN hoy; los de "cobertura" pasan y fijan lo que hoy
// esta bien. Solo dobles: repos en memoria, adaptador falso de SoftRestaurant, motor fake; nunca red ni base real.
// La semantica SQL (dia de negocio de agotados_reponer, abiertos de la saturacion, recoger sin hora) la prueba
// scripts/verify-qa-r2-restaurantes-automatizacion contra Postgres efimero.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryAutopilotoRepository, InMemoryRestaurantesRepository, avanzarDesdePos, escalarSolicitudesVencidas } from "@atiende/domain-restaurantes";
import type { AutopilotoServicioDeps, PedidoMemoria } from "@atiende/domain-restaurantes";
import { FakeSoftRestaurantAdapter, InMemoryComandaOutboxStore, type SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
import type { InMemorySaludRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV, buildTestDeps, jsonRequestInit } from "./fixtures.ts";
import { authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

const SECRET = { "x-atiende-internal-secret": TEST_ENV.internalSecret };
const TOOL_SECRET_HEADERS = { "x-atiende-tool-secret": "test-voice-tool-secret" };
// Horario real de Los Taquitos de PM: 12:00 a 01:00 todos los dias (el turno cruza la medianoche).
const HORARIO_PM = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }];

async function latido(deps: AppDeps, cron: string) {
  const salud = deps.saludRepo as InMemorySaludRepository;
  const superId = randomUUID();
  salud.addPlatformSuperadmin(superId);
  return (await salud.listCronHeartbeatsForSuperadmin(superId)).find((h) => h.cronName === cron) ?? null;
}

async function contextoAutopiloto() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  ctx.restaurantesRepo.seedWhatsAppChannel(ctx.organizationId, "PNID-QA-R2");
  const auto = new InMemoryAutopilotoRepository();
  const store = new InMemoryComandaOutboxStore({ disponible: true });
  store.ponerModo(ctx.organizationId, "sombra");
  const deps: AppDeps = {
    ...ctx.deps,
    autopilotoRepo: () => auto,
    softRestaurantStore: () => store,
    softRestaurantPort: new FakeSoftRestaurantAdapter() as unknown as SoftRestaurantPort,
  };
  return { ctx, auto, store, deps, app: buildApp(deps) };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R2-automatizacion-01 (ROJO hasta el fix): el pedido grande del agente no entra al flujo de aprobacion con un clic", () => {
  // DoD de restaurantes (PLAN-MAESTRO, paridad §4 A5): el pedido grande queda `por_aprobar` con su solicitud y, al aprobar con un clic, el sistema
  // sigue solo (cocina + aviso al cliente). Hoy `crear_pedido` (voz y WhatsApp, registry.ts::retenerPedidoGrande) NO crea el pedido: deja un
  // callback `escalada:pedido_grande` y una persona tiene que llamar al cliente y volver a capturarlo. El autopiloto (050) ya tiene
  // `solicitud_pedido_grande_retener` + `solicitud_resolver`, pero nadie los invoca (catalogo: `restaurantes.aprobacion.pedido_grande` "pendiente").
  it("100 Coca-Cola ($4,500) por voz en la org de PM: queda un pedido por_aprobar con su solicitud (no un callback para recapturar)", async () => {
    const { deps, restaurantesRepo, organizationId, products } = await buildTestDeps();
    const auto = new InMemoryAutopilotoRepository();
    await restaurantesRepo.upsertWhatsAppAgentConfig(organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: "Los Taquitos de PM", toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
    const app = buildApp({ ...deps, autopilotoRepo: () => auto });
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit(
        { branch_slug: "fco-montejo", customer_name: "Evento", customer_phone: "9991230001", customer_address: "Calle 20 #300, Mérida", items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 100 }], payment_method: "efectivo" },
        TOOL_SECRET_HEADERS,
      ),
    );
    expect(res.status).toBe(200);
    const pedidos = (await restaurantesRepo.listOrders(organizationId, { propertyIds: null, limit: 10 })).orders;
    expect(pedidos.map((o) => o.status), "no se creo ningun pedido: solo un callback para que una persona lo vuelva a capturar").toEqual(["por_aprobar"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R2-automatizacion-02 (ROJO hasta el fix): 'agotado hasta manana' usa el dia CALENDARIO, no el dia de negocio", () => {
  // PM abre 12:00-01:00. A las 00:30 del DOMINGO todavia corre el turno del SABADO. "Agotado hasta manana" debe reponerse para el turno siguiente
  // (domingo 12:00), pero la ruta calcula hasta = fecha calendario local + 1 = LUNES: el producto se pierde el domingo entero.
  // El reverso (marcado a las 23:30 y repuesto a las 00:10, con el turno abierto) lo reproduce el verify SQL S1.
  it("marcado a las 00:30 del domingo (turno del sabado): se repone el domingo, no el lunes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T06:30:00Z")); // 00:30 del domingo 11-oct en Merida (UTC-6)
    const t = await contextoAutopiloto();
    await t.ctx.restaurantesRepo.upsertBranchZonaHoraria(t.ctx.propertyIdA, "America/Merida");
    await t.ctx.restaurantesRepo.upsertBranchPolicy(t.ctx.organizationId, t.ctx.propertyIdA, { horario: HORARIO_PM, pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null });
    const productId = randomUUID();
    t.auto.agotados.push({ organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, productId, disponible: true, agotadoHasta: null });
    const res = await t.app.request(`/v1/restaurantes/${t.ctx.propertyIdA}/admin/autopiloto/agotado`, authedJson(t.ctx.staff.owner.token, { productId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agotadoHasta: string };
    expect(body.agotadoHasta, "el producto queda agotado TODO el domingo: se marco en el turno del sabado").toBe("2026-10-11");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R2-automatizacion-06 (ROJO hasta el fix): un paso del autopiloto que falla en cada tick deja el latido 'ok'", () => {
  // barrerAutopilotoTick cuenta `errores` por paso (escalar, estados, pos, handoffs, agotados) y la ruta los devuelve en el JSON, pero
  // promover-programados solo lanza CronPartialFailureError por comandas. Si un paso falla siempre (timeout de sentencia, bloqueo,
  // regresion SQL), ninguna aprobacion se escala, ningun entregado se completa y /superadmin/salud muestra el cron sano.
  it("el paso 'estados' falla con un error SQL real: la corrida no queda registrada como sana", async () => {
    const t = await contextoAutopiloto();
    t.auto.candidatosEstados = async () => {
      throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    };
    const r = (await (await t.app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET })).json()) as { autopiloto: { errores: number } };
    expect(r.autopiloto.errores).toBe(1);
    const hb = await latido(t.deps, "/internal/restaurantes/promover-programados");
    expect(hb?.lastStatus, "el autopiloto fallo y el panel de salud dice 'ok'").not.toBe("ok");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R2-automatizacion-07 (ROJO hasta el fix): el avance desde el POS no tiene tope de tiempo por consulta", () => {
  // avanzarDesdePos llama port.obtenerEstadoComanda en serie (hasta 50 comandas) DENTRO de la transaccion del paso y sin timeout; crearComanda
  // si tiene `conTimeout` (4 s). Con el adaptador real (solo falta la credencial) un POS lento cuelga el tick: la funcion de Vercel muere a los
  // 30 s (maxDuration), la transaccion del paso se revierte y la siguiente corrida vuelve a tomar las MISMAS comandas (order by actualizado_en):
  // ningun pedido avanza nunca. Aqui el POS no responde: el paso debe rendirse y seguir.
  it("un POS que no responde no cuelga el tick: el paso termina en menos de 10 s", async () => {
    const auto = new InMemoryAutopilotoRepository();
    const orgId = randomUUID();
    const propertyId = randomUUID();
    const p: PedidoMemoria = {
      id: randomUUID(), organizationId: orgId, propertyId, status: "pending", total: 200, clienteNombre: "Ana", telefono: "9995550101", canal: "domicilio", numero: 5,
      renglones: [{ nombre: "Tacos", cantidad: 4 }], comanda: { estado: "confirmada", folio: "F-5" },
    } as PedidoMemoria;
    auto.pedidos.set(p.id, p);
    const port = { esReal: true, obtenerEstadoComanda: () => new Promise(() => {}) } as unknown as SoftRestaurantPort;
    const deps = { auto, repo: new InMemoryRestaurantesRepository(), db: {} as TenantDbSession } as AutopilotoServicioDeps;
    const resultado = await Promise.race([
      avanzarDesdePos(deps, port, () => ({ id: "sr-1" }) as never).then(() => "termino"),
      new Promise<string>((r) => setTimeout(() => r("colgado"), 10_000)),
    ]);
    expect(resultado, "el tick queda colgado esperando al POS (en Vercel: muere por maxDuration y revierte el paso)").toBe("termino");
  }, 15_000);
});

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R2-automatizacion-10 (ROJO hasta el fix): una escalada cuya notificacion falla se pierde para siempre", () => {
  // solicitudes_por_escalar marca `escalada_at` en la MISMA consulta que la devuelve; luego emitirNotificacion traga su error (estado "error")
  // y escalarSolicitudesVencidas cuenta la solicitud como escalada. La transaccion del paso confirma la marca: el owner nunca recibe la alerta
  // critica de "aprobacion sin respuesta" y ninguna corrida posterior la vuelve a intentar.
  it("si la campana falla en el 1er tick, el 2o tick vuelve a intentar avisar al owner", async () => {
    const auto = new InMemoryAutopilotoRepository();
    const orgId = randomUUID();
    const propertyId = randomUUID();
    const p = { id: randomUUID(), organizationId: orgId, propertyId, status: "pending", total: 4500, clienteNombre: "Ev", telefono: "9995550199", canal: "domicilio", numero: 9, renglones: [] } as unknown as PedidoMemoria;
    auto.pedidos.set(p.id, p);
    await auto.retenerPedidoGrande(orgId, p.id, { total: 4500 });
    (auto as unknown as { solicitudes: { solicitadaAt: Date }[] }).solicitudes.forEach((s) => (s.solicitadaAt = new Date(Date.now() - 30 * 60_000)));
    let intentos = 0;
    let falla = true;
    const db = {
      async exec() {},
      async query(sql: string) {
        if (sql.includes("core.emit_notification")) {
          intentos++;
          if (falla) throw Object.assign(new Error("could not obtain lock on row"), { code: "55P03" });
          return { rows: [{ emit_notification: 1 }] };
        }
        throw new Error(`consulta inesperada: ${sql}`);
      },
    } as unknown as TenantDbSession;
    const deps = { auto, repo: new InMemoryRestaurantesRepository(), db } as AutopilotoServicioDeps;
    await escalarSolicitudesVencidas(deps, new Date());
    falla = false;
    await escalarSolicitudesVencidas(deps, new Date());
    expect(intentos, "la alerta critica fallo una vez y nunca se reintento").toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("cobertura (pasa hoy): idempotencia y aislamiento del tick del autopiloto", () => {
  it("dos ticks SIMULTANEOS no completan dos veces el mismo entregado ni duplican el aviso al cliente", async () => {
    const t = await contextoAutopiloto();
    const o = makeOrder({ organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, status: "entregado", total: 100, customerPhone: "9995550123" });
    t.ctx.restaurantesRepo.seedOrder(o);
    const mem = { id: o.id, organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, status: "entregado", total: 100, clienteNombre: "A", telefono: "9995550123", canal: "domicilio", numero: 1, renglones: [], entregadoAt: new Date(Date.now() - 8 * 3_600_000) } as unknown as PedidoMemoria;
    t.auto.pedidos.set(o.id, mem);
    const [a, b] = await Promise.all([
      Promise.resolve(t.app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET })).then((r: Response) => r.json() as Promise<{ autopiloto: { estadosAplicados: number } }>),
      Promise.resolve(t.app.request("/internal/restaurantes/promover-programados", { method: "GET", headers: SECRET })).then((r: Response) => r.json() as Promise<{ autopiloto: { estadosAplicados: number } }>),
    ]);
    expect(a.autopiloto.estadosAplicados + b.autopiloto.estadosAplicados).toBe(1);
    expect(t.auto.eventos.filter((e) => e.orderId === o.id && e.hacia === "completado")).toHaveLength(1);
  });

  it("un paso que falla no frena a los demas: con 'estados' roto, el handoff vencido igual se devuelve", async () => {
    const t = await contextoAutopiloto();
    t.auto.candidatosEstados = async () => {
      throw Object.assign(new Error("boom"), { code: "57014" });
    };
    t.auto.handoffs.push({ id: "h-qa", organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, conversationId: randomUUID(), telefono: "9995550188", estado: "tomada", tomadaAt: new Date(Date.now() - 40 * 60_000), ultimaHumanaAt: null, ultimoClienteAt: new Date(Date.now() - 5 * 60_000) });
    const r = (await (await t.app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET })).json()) as { autopiloto: { handoffsDevueltos: number; errores: number } };
    expect(r.autopiloto).toMatchObject({ handoffsDevueltos: 1, errores: 1 });
  });
});
