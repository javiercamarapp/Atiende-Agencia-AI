// QA adversarial R2 -- lente AUTOMATIZACION de restaurantes (tick del autopiloto dentro de promover-programados, agotados,
// pedido grande, avance desde el POS, latido). Reporte: ~/atiende-loop/work/qa/restaurantes/ronda-2-automatizacion.md.
//
// Cada `describe` QA-restaurantes-R2-automatizacion-NN fija la correccion de ese defecto; los de "cobertura" fijan lo que ya estaba bien. Solo dobles: repos en memoria, adaptador falso de SoftRestaurant, motor fake; nunca red ni base real.
// La semantica SQL (dia de negocio de agotados_reponer, abiertos de la saturacion, recoger sin hora) la prueba
// scripts/verify-restaurantes-qa-r2-automatizacion-caos contra Postgres efimero.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryAutopilotoRepository, InMemoryCierreRepository, InMemoryRepartidorPerfilRepository, InMemoryRestaurantesRepository, avanzarDesdePos } from "@atiende/domain-restaurantes";
import type { AutopilotoServicioDeps, PedidoMemoria } from "@atiende/domain-restaurantes";
import { FakeSoftRestaurantAdapter, InMemoryComandaOutboxStore, type SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
import type { InMemorySaludRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { createPlatformSwitchGuard } from "../src/platform-switches.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

const SECRET = { "x-atiende-internal-secret": TEST_ENV.internalSecret };
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
describe("QA-restaurantes-R2-automatizacion-02: 'agotado hasta manana' usa el dia CALENDARIO, no el dia de negocio", () => {
  // PM abre 12:00-01:00. A las 00:30 del DOMINGO todavia corre el turno del SABADO. "Agotado hasta manana" debe reponerse para el turno siguiente
  // (domingo 12:00), pero la ruta calcula hasta = fecha calendario local + 1 = LUNES: el producto se pierde el domingo entero.
  // El reverso (marcado a las 23:30 y repuesto a las 00:10, con el turno abierto) lo reproduce el verify SQL S1.
  it("marcado a las 00:30 del domingo (turno del sabado): se repone el domingo, no el lunes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T06:30:00Z")); // 00:30 del domingo 11-oct en Merida (UTC-6)
    const t = await contextoAutopiloto();
    await t.ctx.restaurantesRepo.upsertBranchZonaHoraria(t.ctx.propertyIdA, "America/Merida");
    await t.ctx.restaurantesRepo.upsertBranchPolicy(t.ctx.organizationId, t.ctx.propertyIdA, { horario: HORARIO_PM, pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null });
    // La base lee el horario de branch_policy para el dia de negocio; el doble en memoria lo recibe aqui.
    t.auto.zonaPorSucursal.set(t.ctx.propertyIdA, "America/Merida");
    t.auto.horarioPorSucursal.set(t.ctx.propertyIdA, HORARIO_PM);
    const productId = randomUUID();
    t.auto.agotados.push({ organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, productId, disponible: true, agotadoHasta: null });
    const res = await t.app.request(`/v1/restaurantes/${t.ctx.propertyIdA}/admin/autopiloto/agotado`, authedJson(t.ctx.staff.owner.token, { productId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agotadoHasta: string };
    expect(body.agotadoHasta, "el producto queda agotado TODO el domingo: se marco en el turno del sabado").toBe("2026-10-11");
    // ...y el tick lo repone al terminar el turno (01:10), no antes (00:45) ni hasta el lunes.
    expect((await t.auto.reponerAgotados(new Date("2026-10-11T06:45:00Z"))).valor).toHaveLength(0);
    expect((await t.auto.reponerAgotados(new Date("2026-10-11T07:10:00Z"))).valor).toHaveLength(1);
  });

  it("sin horario que cruce la medianoche el dia de negocio es el calendario: marcado a las 00:30 queda hasta el lunes, como siempre", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T06:30:00Z"));
    const t = await contextoAutopiloto();
    await t.ctx.restaurantesRepo.upsertBranchZonaHoraria(t.ctx.propertyIdA, "America/Merida");
    await t.ctx.restaurantesRepo.upsertBranchPolicy(t.ctx.organizationId, t.ctx.propertyIdA, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "09:00", cierra: "22:00" }], pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null });
    t.auto.zonaPorSucursal.set(t.ctx.propertyIdA, "America/Merida");
    const productId = randomUUID();
    t.auto.agotados.push({ organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, productId, disponible: true, agotadoHasta: null });
    const res = await t.app.request(`/v1/restaurantes/${t.ctx.propertyIdA}/admin/autopiloto/agotado`, authedJson(t.ctx.staff.owner.token, { productId }));
    expect(((await res.json()) as { agotadoHasta: string }).agotadoHasta).toBe("2026-10-12");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R2-automatizacion-06: un paso del autopiloto que falla en cada tick deja el latido 'ok'", () => {
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
describe("QA-restaurantes-R2-automatizacion-07: el avance desde el POS no tiene tope de tiempo por consulta", () => {
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
describe("QA-restaurantes-R2-automatizacion-06 (bis): avisos operativos y avisos de cocina que fallan tambien marcan la corrida", () => {
  it("un paso del autopiloto que falla deja la corrida 'parcial' en la bitacora y devuelve la misma respuesta 200 (el cron no reintenta)", async () => {
    const t = await contextoAutopiloto();
    t.auto.candidatosEstados = async () => {
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    };
    const res = await t.app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, autopiloto: { errores: 1 } });
    expect((await latido(t.deps, "/internal/restaurantes/promover-programados"))?.lastError).toMatch(/1 paso\(s\) del autopiloto fallaron/);
  });

  it("sin fallos el latido queda 'ok' sin error", async () => {
    const t = await contextoAutopiloto();
    await t.app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET });
    expect(await latido(t.deps, "/internal/restaurantes/promover-programados")).toMatchObject({ lastStatus: "ok" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R2-automatizacion-09: las alertas de voz se evaluan solas en el tick de 5 min", () => {
  it("el tick evalua las alertas de voz del sistema (sin boton) y cuenta las nuevas; sin el puerto cableado no evalua nada", async () => {
    const t = await contextoAutopiloto();
    let evaluaciones = 0;
    const app = buildApp({ ...t.deps, vozAlertasSistema: async () => { evaluaciones += 1; return { disponible: true, nuevas: 2, emitidas: 2, errores: 0 }; } });
    const r = (await (await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET })).json()) as { autopiloto: { alertasVoz: number; errores: number } };
    expect(evaluaciones).toBe(1);
    expect(r.autopiloto).toMatchObject({ alertasVoz: 2, errores: 0 });
    const sinPuerto = (await (await t.app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET })).json()) as { autopiloto: { alertasVoz: number } };
    expect(sinPuerto.autopiloto.alertasVoz).toBe(0);
  });

  it("si la emision de alguna alerta de voz falla, la corrida queda parcial", async () => {
    const t = await contextoAutopiloto();
    const app = buildApp({ ...t.deps, vozAlertasSistema: async () => ({ disponible: true, nuevas: 1, emitidas: 0, errores: 1 }) });
    const r = (await (await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: SECRET })).json()) as { autopiloto: { errores: number } };
    expect(r.autopiloto.errores).toBe(1);
    expect((await latido(t.deps, "/internal/restaurantes/promover-programados"))?.lastStatus).toBe("error");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("QA-restaurantes-R2-automatizacion-12: los barridos cierres-dia y repartidor-licencias tienen latido, bitacora e interruptor", () => {
  it("cierres-dia: registra su latido (ok) y el kill switch por cron lo detiene sin generar nada", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const repo = new InMemoryCierreRepository({ calcular: () => null, sucursales: [{ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, zonaHoraria: "America/Mexico_City" }] });
    const deps: AppDeps = { ...ctx.deps, cierreRepo: () => repo };
    const guard = createPlatformSwitchGuard(async () => [{ scope: "cron", target: "/internal/restaurantes/cierres-dia" }]);
    const pausado = await buildApp({ ...deps, platformSwitchGuard: guard }).request("/internal/restaurantes/cierres-dia", { method: "POST", headers: SECRET });
    expect(await pausado.json()).toMatchObject({ ok: true, skipped: "kill_switch" });
    expect(repo.generaciones).toBe(0);
    const normal = await buildApp(deps).request("/internal/restaurantes/cierres-dia", { method: "POST", headers: SECRET });
    expect(normal.status).toBe(200);
    expect(await latido(deps, "/internal/restaurantes/cierres-dia")).toMatchObject({ lastStatus: "ok" });
  });

  it("repartidor-licencias: registra su latido y el kill switch por cron lo detiene", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const repo = new InMemoryRepartidorPerfilRepository({ licencias: [{ organizationId: ctx.organizationId, userId: ctx.staff.repartidor.id, diasRestantes: 12 }] });
    const deps: AppDeps = { ...ctx.deps, repartidorPerfilRepo: () => repo };
    const guard = createPlatformSwitchGuard(async () => [{ scope: "cron", target: "/internal/restaurantes/repartidor-licencias" }]);
    const pausado = await buildApp({ ...deps, platformSwitchGuard: guard }).request("/internal/restaurantes/repartidor-licencias", { method: "POST", headers: SECRET });
    expect(await pausado.json()).toMatchObject({ ok: true, skipped: "kill_switch" });
    const normal = await buildApp(deps).request("/internal/restaurantes/repartidor-licencias", { method: "POST", headers: SECRET });
    expect(await normal.json()).toMatchObject({ ok: true, revisadas: 1 });
    expect(await latido(deps, "/internal/restaurantes/repartidor-licencias")).toMatchObject({ lastStatus: "ok" });
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
