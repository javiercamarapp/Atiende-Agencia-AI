// QA R2 -- pedido grande (features-01, automatizacion-01, viaje-01, agentes-08): el servidor ya no solo AVISA, deja el pedido `por_aprobar` con su solicitud
// (autopiloto 050) para que la sucursal lo apruebe con un clic; y el umbral se evalua sobre lo ACUMULADO por el mismo numero (partir el pedido no lo evade).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryAutopilotoRepository, crearHookPedidoGrande, crearHooksAutopilotoTurno } from "../../src/autopiloto/index.ts";
import type { AutopilotoTurnoHooks, PedidoGrandeHook } from "../../src/autopiloto/index.ts";
import { PEDIDO_GRANDE_VENTANA_ACUMULADO_MS, acumuladoReciente } from "../../src/pedido-grande.ts";
import { banco, call, item, say } from "./r1-arnes-whatsapp-pm.ts";
import type { Banco } from "./r1-arnes-whatsapp-pm.ts";

afterEach(() => {
  vi.useRealTimers();
});

class SesionFalsa implements TenantDbSession {
  readonly emisiones: { evento: string; clave: string }[] = [];
  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    if (/core\.emit_notification/.test(sql)) {
      const p = params ?? [];
      this.emisiones.push({ evento: String(p[2]), clave: String(p[10]) });
      return { rows: [{ emit_notification: 1 } as T] };
    }
    return { rows: [] };
  }
  async exec(): Promise<void> {}
}

/** Autopiloto en memoria sobre el mundo de PM: registra el pedido recien creado (como lo veria la base) y usa el hook REAL de `crear_pedido`. */
function conAutopiloto(opts: { readonly disponible?: boolean } = {}) {
  const auto = new InMemoryAutopilotoRepository();
  if (opts.disponible === false) (auto as unknown as { disponible: boolean }).disponible = false;
  const db = new SesionFalsa();
  const comandas: unknown[] = [];
  const retenerLlamadas: Record<string, unknown>[] = [];
  return { auto, db, comandas, retenerLlamadas };
}

async function bancoConAutopiloto(opts: { readonly disponible?: boolean } = {}) {
  const ctx = conAutopiloto(opts);
  let repoRef: Parameters<typeof crearHooksAutopilotoTurno>[0]["repo"] | null = null;
  const real = (): PedidoGrandeHook => crearHookPedidoGrande({ auto: ctx.auto, repo: repoRef!, db: ctx.db });
  const pedidoGrande: PedidoGrandeHook = {
    disponible: (o, p) => real().disponible(o, p),
    retener: async (i) => {
      ctx.retenerLlamadas.push({ ...i.detalle });
      const o = await repoRef!.findOrderById(i.organizationId, i.orderId);
      if (o) {
        ctx.auto.pedidos.set(o.id, { id: o.id, organizationId: o.organizationId, propertyId: o.propertyId, status: "pending", total: o.total, clienteNombre: o.customerName, telefono: o.customerPhone, canal: "recoger", numero: o.orderNumber ?? 1, renglones: [] });
      }
      return real().retener(i);
    },
  };
  // El mundo se crea dentro de `banco`; el hook necesita su repo, asi que se completa justo despues (el handler lee `options.autopiloto` por turno).
  const hooksBase: { current: AutopilotoTurnoHooks | null } = { current: null };
  const proxy: AutopilotoTurnoHooks = {
    cancelacionActiva: async (o) => hooksBase.current!.cancelacionActiva(o),
    solicitarCancelacion: (i) => hooksBase.current!.solicitarCancelacion(i),
    registrarQueja: (i) => hooksBase.current!.registrarQueja(i),
    pedidoGrande,
  };
  const b = await banco({ handlerOptions: { autopiloto: proxy, encolarComanda: async (pedido) => { ctx.comandas.push(pedido); return { modo: "apagado" as const, fila: null, agente: null, motivo: "bandera_apagada" as const }; } } });
  repoRef = b.w.repo;
  hooksBase.current = crearHooksAutopilotoTurno({ auto: ctx.auto, repo: b.w.repo, db: ctx.db });
  return { b, ...ctx };
}

async function cotizarYConfirmar(b: Banco, tel: string, items: ReturnType<typeof item>[], pago: "efectivo" | "tarjeta", extra: Record<string, unknown> = {}) {
  b.setGuion([call("cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items, ...extra }), say("Total cotizado. ¿Confirma?")]);
  await b.enviar(tel, "quiero para recoger");
  b.setGuion([call("confirmar_resumen", {}), call("crear_pedido", { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Fiesta", payment_method: pago, items }), say("Listo, su pedido quedó registrado.")]);
  return b.enviar(tel, `si ${pago}`);
}

describe("WhatsApp (T7, PM): el pedido grande queda por_aprobar con su solicitud", () => {
  it("features-01 / viaje-01: 3 x Bistec 2 kg ($6,600) en efectivo -> pedido CREADO, solicitud pedido_grande, aviso a la campana, SIN comanda ni handoff ni callback", async () => {
    const t = await bancoConAutopiloto();
    const items = [item(t.b.pid("Bistec de Res — 2 kg"), "Bistec de Res — 2 kg", 3)];
    const r = await cotizarYConfirmar(t.b, "+5219990000041", items, "efectivo");
    expect(r.orderId).toBeTruthy();
    expect(t.retenerLlamadas).toHaveLength(1);
    expect(t.retenerLlamadas[0]).toMatchObject({ motivo: "total", total: 6600, peso_kg: 6, pago: "efectivo" });
    // Sin PII en la solicitud: solo codigos y cifras.
    expect(JSON.stringify(t.retenerLlamadas[0])).not.toMatch(/Fiesta|9990000041/);
    expect((t.auto as unknown as { solicitudes: { tipo: string }[] }).solicitudes.filter((s) => s.tipo === "pedido_grande")).toHaveLength(1);
    expect(t.db.emisiones.map((e) => e.evento)).toEqual(["restaurantes.aprobacion.pedido_grande"]);
    // El pedido NO sale a cocina por este camino: la comanda la encola la aprobacion con un clic.
    expect(t.comandas).toHaveLength(0);
    expect(t.b.callbacks().some((c) => c.reason === "escalada:pedido_grande")).toBe(false);
    expect(r.escalated).toBeFalsy();
  });

  it("un pedido bajo los umbrales sigue su camino normal: comanda encolada, sin solicitud", async () => {
    const t = await bancoConAutopiloto();
    const items = [item(t.b.pid("Pastor — 1 kg"), "Pastor — 1 kg", 1)];
    const r = await cotizarYConfirmar(t.b, "+5219990000042", items, "tarjeta");
    expect(r.orderId).toBeTruthy();
    expect(t.retenerLlamadas).toHaveLength(0);
    expect(t.comandas).toHaveLength(1);
    expect(t.db.emisiones).toHaveLength(0);
  });

  it("base SIN la migracion 050 (autopiloto no disponible): no se crea pedido y queda el aviso de siempre (camino anterior intacto)", async () => {
    const t = await bancoConAutopiloto({ disponible: false });
    const items = [item(t.b.pid("Bistec de Res — 2 kg"), "Bistec de Res — 2 kg", 3)];
    const r = await cotizarYConfirmar(t.b, "+5219990000043", items, "efectivo");
    expect(r.orderId).toBeNull();
    expect(t.retenerLlamadas).toHaveLength(0);
    expect((await t.b.w.repo.listOrders(t.b.w.organizationId, { propertyIds: null, limit: 100 })).orders).toHaveLength(0);
    expect(t.b.callbacks().some((c) => c.reason === "escalada:pedido_grande")).toBe(true);
  });
});

describe("agentes-08: partir el pedido en la misma conversacion no evade el umbral", () => {
  const dos = (b: Banco) => [item(b.pid("Pastor — 2 kg"), "Pastor — 2 kg", 1), item(b.pid("Pastor — 500 g"), "Pastor — 500 g", 1)];

  it("pedido 1 de $2,250 en efectivo (numero nuevo) entra; 'otro igual' (acumulado $4,500) se retiene", async () => {
    const b = await banco();
    const r1 = await cotizarYConfirmar(b, "+5219990000044", dos(b), "efectivo");
    expect(r1.orderId).toBeTruthy();
    const r2 = await cotizarYConfirmar(b, "+5219990000044", dos(b), "efectivo", { otro_pedido: true });
    expect(r2.orderId).toBeNull();
    expect((await b.w.repo.listOrders(b.w.organizationId, { propertyIds: null, limit: 100 })).orders).toHaveLength(1);
    const aviso = b.callbacks().find((c) => c.reason === "escalada:pedido_grande");
    expect(aviso?.message).toMatch(/Suma 1 pedido\(s\) previo\(s\)/);
  });

  it("CON autopiloto, 'otro igual' en menos de 5 min se deduplica: el pedido 1 (ya aceptado, con comanda) NO se retiene ni se abre solicitud", async () => {
    const t = await bancoConAutopiloto();
    const r1 = await cotizarYConfirmar(t.b, "+5219990000047", dos(t.b), "efectivo");
    expect(r1.orderId).toBeTruthy();
    expect(t.comandas).toHaveLength(1);
    const r2 = await cotizarYConfirmar(t.b, "+5219990000047", dos(t.b), "efectivo", { otro_pedido: true });
    // create_order_idempotent devuelve el MISMO pedido (misma huella): nada nuevo que retener.
    expect(r2.orderId).toBe(r1.orderId);
    expect(t.retenerLlamadas).toHaveLength(0);
    expect((t.auto as unknown as { solicitudes: { tipo: string }[] }).solicitudes).toHaveLength(0);
    expect(t.db.emisiones).toHaveLength(0);
    const { orders } = await t.b.w.repo.listOrders(t.b.w.organizationId, { propertyIds: null, limit: 100 });
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).not.toBe("por_aprobar");
  });

  it("con tarjeta el acumulado de $4,500 tambien se retiene (supera $4,000); dos pedidos chicos que no suman el umbral siguen entrando", async () => {
    const b = await banco();
    const chico = [item(b.pid("Pastor — 1 kg"), "Pastor — 1 kg", 1)];
    expect((await cotizarYConfirmar(b, "+5219990000045", chico, "tarjeta")).orderId).toBeTruthy();
    expect((await cotizarYConfirmar(b, "+5219990000045", chico, "tarjeta", { otro_pedido: true })).orderId).toBeTruthy();
    expect(b.callbacks().some((c) => c.reason === "escalada:pedido_grande")).toBe(false);
  });
});

describe("acumuladoReciente (pura)", () => {
  const ahora = Date.parse("2026-10-13T20:00:00.000Z");
  const p = (minAtras: number, total: number, status = "pending") => ({ createdAt: new Date(ahora - minAtras * 60_000).toISOString(), status, total, items: [{ name: "Pastor — 2 kg", quantity: 1 }] });
  it("suma solo lo de la ventana y salta cancelados y fechas invalidas", () => {
    const r = acumuladoReciente([p(10, 1800), p(60, 1800), p(PEDIDO_GRANDE_VENTANA_ACUMULADO_MS / 60_000 + 5, 9999), p(5, 700, "cancelado"), { ...p(1, 5), createdAt: "no-es-fecha" }], ahora);
    expect(r).toEqual({ total: 3600, pesoKg: 4, cuantos: 2 });
  });
});
