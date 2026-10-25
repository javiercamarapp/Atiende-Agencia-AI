// Agregados por validar (099): repositorio en memoria + servicio con reloj controlado. Un solo abierto por pedido con fusion, aceptar aplica al pedido, rechazar
// exige motivo y deja la tarea de devolver llamada, doble clic = un efecto, alcance por sucursal, SLA derivado y barrido (10 y 20 min), base sin migrar.
// La semantica real de SQL (RLS, grants, trigger, concurrencia) la prueba scripts/verify-restaurantes-agregados contra Postgres.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { describe, expect, it } from "vitest";
import {
  InMemoryAgregadosRepository, SLA_AGREGADO, barrerAgregadosSla, calcularSla, cancelarAgregadoPorCliente, guionDevolverLlamada, listaProductos, registrarSolicitudAgregado, resolverAgregado,
  textoAgregadoAceptado, textoAgregadoNoAplicable, textoAgregadoRechazado, textoAgregadoSeguimiento, textoAgregadoVencido,
} from "../src/agregados/index.ts";
import type { AgregadosServicioDeps, PedidoAgregableMemoria } from "../src/agregados/index.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

class SesionFalsa implements TenantDbSession {
  readonly emisiones: { evento: string; clave: string }[] = [];
  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    if (/core\.emit_notification/.test(sql)) {
      const p = params ?? [];
      const clave = String(p[10]);
      if (this.emisiones.some((e) => e.clave === clave)) return { rows: [{ emit_notification: 0 } as T] };
      this.emisiones.push({ evento: String(p[2]), clave });
      return { rows: [{ emit_notification: 1 } as T] };
    }
    return { rows: [] };
  }
  async exec(): Promise<void> {}
}

const COCA = { id: "p-coca", name: "Coca-Cola", price: 30, quantity: 2 };
const TACO = { id: "p-taco", name: "Taco de pastor", price: 25, quantity: 4 };
const ACTOR = "00000000-0000-4000-8000-0000000000a1";

async function montar() {
  const fixture = buildRestaurantFixture();
  fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PNID-1");
  const propertyId = (await fixture.repo.findBranch(fixture.organizationId, { slug: "fco-montejo" }))!.propertyId;
  const otraSucursal = "00000000-0000-4000-8000-0000000000b2";
  let reloj = new Date("2026-10-24T18:00:00.000Z");
  const agregados = new InMemoryAgregadosRepository();
  agregados.ahora = () => reloj;
  const db = new SesionFalsa();
  const deps: AgregadosServicioDeps = { agregados, repo: fixture.repo, db };
  const pedido = (extra: Partial<PedidoAgregableMemoria> = {}): PedidoAgregableMemoria => {
    const p: PedidoAgregableMemoria = {
      id: `ord-${agregados.pedidos.size + 1}`, organizationId: fixture.organizationId, propertyId, sucursal: "Francisco de Montejo", orderNumber: 150, status: "preparando",
      items: [{ ...TACO }], total: 100, customerName: "Ana", customerPhone: "9990001111", createdAt: reloj.toISOString(), ...extra,
    };
    agregados.sembrarPedido(p);
    return p;
  };
  const nuevo = (p: PedidoAgregableMemoria, extra = {}) => ({ organizationId: p.organizationId, propertyId: p.propertyId, orderId: p.id, channel: "whatsapp" as const, items: [{ ...COCA }], ...extra });
  const outbox = (tipo?: string) => fixture.repo.getOutbox().filter((r) => !tipo || r.eventType === tipo);
  return { fixture, agregados, deps, db, pedido, nuevo, outbox, propertyId, otraSucursal, avanzar: (min: number) => { reloj = new Date(reloj.getTime() + min * 60_000); return reloj; }, ahora: () => reloj };
}

describe("calcularSla (estado derivado por el reloj)", () => {
  const t0 = "2026-10-24T18:00:00.000Z";
  const en = (min: number) => new Date(Date.parse(t0) + min * 60_000);
  it("en tiempo hasta 9:59, sin respuesta a los 10 y vencido a los 20", () => {
    expect(calcularSla("pendiente", t0, en(0))).toMatchObject({ nivel: "en_tiempo", segundosParaSiguienteUmbral: 600 });
    expect(calcularSla("pendiente", t0, new Date(Date.parse(t0) + 599_000))).toMatchObject({ nivel: "en_tiempo", segundosParaSiguienteUmbral: 1 });
    expect(calcularSla("pendiente", t0, en(10))).toMatchObject({ nivel: "sin_respuesta", segundosParaSiguienteUmbral: 600 });
    expect(calcularSla("pendiente", t0, en(20))).toMatchObject({ nivel: "vencido", segundosParaSiguienteUmbral: null });
    expect(SLA_AGREGADO).toEqual({ avisoMin: 10, vencimientoMin: 20 });
  });
  it("una solicitud ya resuelta no tiene SLA y un reloj atrasado no da negativos", () => {
    expect(calcularSla("aceptado", t0, en(60))).toMatchObject({ nivel: "en_tiempo", segundosParaSiguienteUmbral: null });
    expect(calcularSla("pendiente", t0, en(-5)).segundosEspera).toBe(0);
  });
});

describe("crear: uno abierto por pedido, fusion e idempotencia", () => {
  it("crea una solicitud pendiente con totales y avisa a la sucursal UNA vez; el pedido no cambia", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p, { sourceEventId: "wamid-1" }));
    expect(r.estado).toBe("creado");
    if (r.estado !== "creado") return;
    expect(r.agregado).toMatchObject({ estado: "pendiente", totalBefore: 100, totalAdded: 60, totalAfter: 160, version: 1, escalationLevel: 0, orderNumber: 150 });
    expect(t.db.emisiones.map((e) => e.evento)).toEqual(["restaurantes.pedido.agregado_pendiente"]);
    expect(t.agregados.pedidos.get(p.id)).toMatchObject({ total: 100, items: [TACO] });
  });

  it("el mismo evento no crea otra; pedir mas FUSIONA (version 2), suma renglones iguales y NO reinicia el cronometro", async () => {
    const t = await montar();
    const p = t.pedido();
    const a = await registrarSolicitudAgregado(t.deps, t.nuevo(p, { sourceEventId: "wamid-1" }));
    const repetido = await registrarSolicitudAgregado(t.deps, t.nuevo(p, { sourceEventId: "wamid-1" }));
    expect(repetido.estado).toBe("repetido");
    const pedidoEn = a.estado === "creado" ? a.agregado.requestedAt : "";
    t.avanzar(4);
    const f = await registrarSolicitudAgregado(t.deps, t.nuevo(p, { items: [{ ...COCA, quantity: 1 }, { id: "p-agua", name: "Agua", price: 20, quantity: 1 }], sourceEventId: "wamid-2" }));
    expect(f.estado).toBe("fusionado");
    if (f.estado !== "fusionado") return;
    expect(f.agregado.version).toBe(2);
    expect(f.agregado.itemsAdded.map((i) => `${i.quantity} ${i.name}`)).toEqual(["3 Coca-Cola", "1 Agua"]);
    expect(f.agregado).toMatchObject({ totalAdded: 110, totalAfter: 210, requestedAt: pedidoEn });
    expect(t.db.emisiones).toHaveLength(1); // la fusion no vuelve a sonar la campana
    expect((await t.agregados.listar(p.organizationId, { propertyIds: null, limite: 10 })).valor).toHaveLength(1);
  });

  it("un pedido que ya salio, se entrego o se cancelo no admite agregados; uno inexistente o de otra sucursal tampoco", async () => {
    const t = await montar();
    for (const status of ["en_camino", "entregado", "cancelado", "por_aprobar"] as const) {
      const r = await t.agregados.crear(t.nuevo(t.pedido({ status })));
      expect(r).toEqual({ estado: "pedido_no_agregable", orderStatus: status });
    }
    const p = t.pedido();
    expect((await t.agregados.crear({ ...t.nuevo(p), orderId: "no-existe" })).estado).toBe("pedido_no_encontrado");
    expect((await t.agregados.crear({ ...t.nuevo(p), propertyId: t.otraSucursal })).estado).toBe("pedido_no_encontrado");
  });
});

describe("decidir: aceptar aplica al pedido; rechazar deja tarea; doble clic = un efecto", () => {
  it("ACEPTAR agrega los renglones y el total al pedido, avisa al cliente con el nuevo total y deja bitacora; el segundo clic es ya_resuelto sin repetir nada", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    const ok = await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "aceptar" }, actorUserId: ACTOR, propertyIds: null });
    expect(ok.resultado.resultado).toBe("aplicado");
    expect(ok.efectos).toEqual(["aviso_cliente_aceptado"]);
    expect(t.agregados.pedidos.get(p.id)).toMatchObject({ total: 160 });
    expect(t.agregados.pedidos.get(p.id)?.items.map((i) => i.name)).toEqual(["Taco de pastor", "Coca-Cola"]);
    const msg = t.outbox("agregado.aceptado");
    expect(msg).toHaveLength(1);
    expect(JSON.stringify(msg[0])).toContain("ya agregamos 2 Coca-Cola a tu pedido #150");
    expect(JSON.stringify(msg[0])).toContain("$160");
    const otra = await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "aceptar" }, actorUserId: ACTOR, propertyIds: null });
    expect(otra.resultado.resultado).toBe("ya_resuelto");
    expect(otra.efectos).toEqual([]);
    expect(t.agregados.pedidos.get(p.id)?.total).toBe(160);
    expect(t.outbox("agregado.aceptado")).toHaveLength(1);
    expect(t.agregados.eventos.map((e) => e.tipoEvento)).toEqual(["creado", "aceptado", "cliente_avisado"]);
  });

  it("aceptar con el pedido ya en camino: queda no_aplicable, NO toca el pedido y el cliente recibe la oferta de pedido aparte", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    t.agregados.pedidos.get(p.id)!.status = "en_camino";
    const x = await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "aceptar" }, actorUserId: ACTOR, propertyIds: null });
    expect(x.resultado.resultado).toBe("no_aplicable");
    expect(t.agregados.pedidos.get(p.id)?.total).toBe(100);
    expect(JSON.stringify(t.outbox("agregado.no_aplicable"))).toContain("ya salió de la sucursal");
  });

  it("RECHAZAR con motivo: avisa con disculpa y oferta de pedido nuevo, crea UNA tarea de devolver llamada con guion y no dice «retraso»", async () => {
    const t = await montar();
    const p = t.pedido({ orderNumber: 77 });
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    const x = await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "rechazar", motivo: "producto_agotado", nota: "sin refrescos" }, actorUserId: ACTOR, propertyIds: null });
    expect(x.efectos).toEqual(["aviso_cliente_rechazado", "tarea_devolver_llamada"]);
    expect(x.resultado.resultado === "aplicado" && x.resultado.agregado).toMatchObject({ estado: "rechazado", rejectReason: "producto_agotado", decidedBy: ACTOR });
    expect(t.agregados.pedidos.get(p.id)?.total).toBe(100);
    const msg = JSON.stringify(t.outbox("agregado.rechazado"));
    expect(msg).toContain("una disculpa");
    expect(msg).toContain("pedido nuevo");
    expect(msg.toLowerCase()).not.toContain("retras");
    const cbs = t.fixture.repo.listCallbackRequests(p.organizationId);
    expect(cbs).toHaveLength(1);
    expect(cbs[0]).toMatchObject({ reason: "agregado_rechazado", customerPhone: "9990001111", propertyId: p.propertyId });
    expect(cbs[0]!.message).toContain("Guion sugerido");
    expect(cbs[0]!.message).toContain("ya no nos queda ese producto");
    // Reintentar no duplica la tarea ni el WhatsApp.
    await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "rechazar", motivo: "otro" }, actorUserId: ACTOR, propertyIds: null });
    expect(t.fixture.repo.listCallbackRequests(p.organizationId)).toHaveLength(1);
    expect(t.outbox("agregado.rechazado")).toHaveLength(1);
  });

  it("alcance por sucursal: quien no tiene la sucursal ve «no_encontrado» (nunca «prohibido») y no cambia nada", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    const fuera = await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "aceptar" }, actorUserId: ACTOR, propertyIds: [t.otraSucursal] });
    expect(fuera.resultado.resultado).toBe("no_encontrado");
    expect((await t.agregados.listar(p.organizationId, { propertyIds: [t.otraSucursal], limite: 10 })).valor).toEqual([]);
    expect((await t.agregados.listar("otra-org", { propertyIds: null, limite: 10 })).valor).toEqual([]);
    expect(t.agregados.pedidos.get(p.id)?.total).toBe(100);
  });

  it("el cliente se arrepiente: cancelado_por_cliente, y ya no se puede aceptar", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    expect((await cancelarAgregadoPorCliente(t.deps, p.organizationId, p.id))?.estado).toBe("cancelado_por_cliente");
    expect(await cancelarAgregadoPorCliente(t.deps, p.organizationId, p.id)).toBeNull();
    const x = await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "aceptar" }, actorUserId: ACTOR, propertyIds: null });
    expect(x.resultado.resultado).toBe("ya_resuelto");
    expect(t.agregados.pedidos.get(p.id)?.total).toBe(100);
  });
});

describe("decidir: carrera con la fusion (version esperada) y vencimiento al decidir", () => {
  it("el cliente pide mas (fusion, version 2) mientras la persona veia la version 1: aceptar con la 1 NO decide, no toca el pedido ni avisa al cliente", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    const f = await registrarSolicitudAgregado(t.deps, t.nuevo(p, { items: [{ ...TACO, quantity: 1 }] }));
    expect(f.estado).toBe("fusionado");
    const x = await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "aceptar" }, actorUserId: ACTOR, propertyIds: null, versionEsperada: 1 });
    expect(x.resultado.resultado).toBe("version_cambio");
    expect(x.efectos).toEqual([]);
    expect(t.agregados.pedidos.get(p.id)?.total).toBe(100);
    expect(t.outbox("agregado.aceptado")).toHaveLength(0);
    expect((await t.agregados.obtener(p.organizationId, r.agregado.id, null)).valor).toMatchObject({ estado: "pendiente", version: 2 });
    // Con la version vigente si se decide, y el pedido y el aviso salen con la solicitud COMPLETA (60 + 25).
    const ok = await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "aceptar" }, actorUserId: ACTOR, propertyIds: null, versionEsperada: 2 });
    expect(ok.resultado.resultado).toBe("aplicado");
    expect(t.agregados.pedidos.get(p.id)?.total).toBe(185);
    expect(JSON.stringify(t.outbox("agregado.aceptado")[0])).toContain("$185");
  });

  it("rechazar con una version vieja tampoco decide: sin aviso ni tarea de devolver llamada", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    const x = await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "rechazar", motivo: "otro", nota: "x" }, actorUserId: ACTOR, propertyIds: null, versionEsperada: 1 });
    expect(x.resultado.resultado).toBe("version_cambio");
    expect(t.outbox("agregado.rechazado")).toHaveLength(0);
    expect(t.fixture.repo.listCallbackRequests(p.organizationId)).toHaveLength(0);
  });

  it("a los 20+ min con status todavia «pendiente» (el tick no corrio): aceptar y rechazar NO deciden; se cierra como vencido con los efectos del tick, una sola vez", async () => {
    for (const decision of [{ tipo: "aceptar" as const }, { tipo: "rechazar" as const, motivo: "otro" as const, nota: "x" }]) {
      const t = await montar();
      const p = t.pedido();
      const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
      if (r.estado !== "creado") throw new Error("esperaba creado");
      t.avanzar(21);
      const x = await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision, actorUserId: ACTOR, propertyIds: null, versionEsperada: 1 });
      expect(x.resultado.resultado).toBe("vencido");
      expect((await t.agregados.obtener(p.organizationId, r.agregado.id, null)).valor).toMatchObject({ estado: "vencido", decidedBy: null, escalationLevel: 2 });
      expect(t.agregados.pedidos.get(p.id)?.total).toBe(100);
      expect(t.outbox("agregado.aceptado")).toHaveLength(0);
      expect(t.outbox("agregado.rechazado")).toHaveLength(0);
      expect(JSON.stringify(t.outbox("agregado.vencido"))).toContain("pedido aparte");
      expect(t.fixture.repo.listCallbackRequests(p.organizationId).map((c) => c.reason)).toEqual(["agregado_vencido"]);
      expect(t.db.emisiones.map((e) => e.evento)).toContain("restaurantes.pedido.agregado_sin_respuesta");
      // Un segundo intento y el tick posterior ya no repiten nada.
      const otra = await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision, actorUserId: ACTOR, propertyIds: null });
      expect(otra.resultado.resultado).toBe("ya_resuelto");
      await barrerAgregadosSla(t.deps, t.avanzar(5));
      expect(t.outbox("agregado.vencido")).toHaveLength(1);
    }
  });

  it("justo antes de los 20 min todavia se puede decidir", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    t.avanzar(19);
    expect((await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "aceptar" }, actorUserId: ACTOR, propertyIds: null, versionEsperada: 1 })).resultado.resultado).toBe("aplicado");
  });

  it("la bitacora de los efectos de una decision humana la firma quien decide (la RLS no deja a un usuario escribir como sistema)", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "rechazar", motivo: "otro", nota: "x" }, actorUserId: ACTOR, propertyIds: null });
    const deUsuario = t.agregados.eventos.filter((e) => ["cliente_avisado", "callback_creado", "rechazado"].includes(e.tipoEvento));
    expect(deUsuario.length).toBe(3);
    for (const e of deUsuario) expect(e.actor).toEqual({ tipo: "usuario", userId: ACTOR });
  });
});

describe("textoAgregadoNoAplicable: el motivo sigue el estado real del pedido", () => {
  it("cancelado no dice «ya salió»; en camino si; entregado dice entregado", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    const base = r.agregado;
    expect(textoAgregadoNoAplicable({ ...base, orderStatus: "cancelado" })).toContain("fue cancelado");
    expect(textoAgregadoNoAplicable({ ...base, orderStatus: "cancelado" })).not.toContain("salió");
    expect(textoAgregadoNoAplicable({ ...base, orderStatus: "en_camino" })).toContain("ya salió de la sucursal");
    expect(textoAgregadoNoAplicable({ ...base, orderStatus: "entregado" })).toContain("ya fue entregado");
  });
});

describe("SLA: barrido del tick de 5 minutos (sin cron nuevo)", () => {
  it("a los 10 min avisa al dueno y al cliente UNA vez (aunque el tick corra varias veces); no cierra nada", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    expect(await barrerAgregadosSla(t.deps, t.avanzar(9))).toMatchObject({ avisados: 0, vencidos: 0 });
    const a = await barrerAgregadosSla(t.deps, t.avanzar(2)); // minuto 11
    expect(a).toMatchObject({ disponible: true, avisados: 1, vencidos: 0, errores: 0 });
    await barrerAgregadosSla(t.deps, t.avanzar(5)); // minuto 16: ya estaba escalada nivel 1
    expect(t.outbox("agregado.seguimiento")).toHaveLength(1);
    expect(t.db.emisiones.filter((e) => e.evento === "restaurantes.pedido.agregado_sin_respuesta")).toHaveLength(1);
    expect((await t.agregados.obtener(p.organizationId, r.agregado.id, null)).valor).toMatchObject({ estado: "pendiente", escalationLevel: 1 });
    expect(JSON.stringify(t.outbox("agregado.seguimiento")).toLowerCase()).not.toContain("retras");
  });

  it("a los 20 min lo cierra como vencido SIN aceptar, ofrece pedido aparte o recoger y deja la tarea de devolver llamada; el pedido no cambia", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    const x = await barrerAgregadosSla(t.deps, t.avanzar(21));
    expect(x).toMatchObject({ avisados: 0, vencidos: 1 });
    expect((await t.agregados.obtener(p.organizationId, r.agregado.id, null)).valor).toMatchObject({ estado: "vencido", decidedBy: null, escalationLevel: 2 });
    expect(t.agregados.pedidos.get(p.id)?.total).toBe(100);
    expect(JSON.stringify(t.outbox("agregado.vencido"))).toContain("pedido aparte");
    expect(t.fixture.repo.listCallbackRequests(p.organizationId).map((c) => c.reason)).toEqual(["agregado_vencido"]);
    await barrerAgregadosSla(t.deps, t.avanzar(5));
    expect(t.outbox("agregado.vencido")).toHaveLength(1);
  });

  it("una solicitud resuelta antes del tick no se escala", async () => {
    const t = await montar();
    const p = t.pedido();
    const r = await registrarSolicitudAgregado(t.deps, t.nuevo(p));
    if (r.estado !== "creado") throw new Error("esperaba creado");
    await resolverAgregado(t.deps, { organizationId: p.organizationId, id: r.agregado.id, decision: { tipo: "aceptar" }, actorUserId: ACTOR, propertyIds: null });
    expect(await barrerAgregadosSla(t.deps, t.avanzar(30))).toMatchObject({ avisados: 0, vencidos: 0 });
  });
});

describe("base sin la migracion 099", () => {
  it("todo degrada a «no disponible» sin lanzar", async () => {
    const t = await montar();
    t.agregados.disponible = false;
    const p = t.pedido();
    expect(await registrarSolicitudAgregado(t.deps, t.nuevo(p))).toEqual({ estado: "no_disponible" });
    expect(await t.agregados.listar(p.organizationId, { propertyIds: null, limite: 5 })).toEqual({ disponible: false, valor: [] });
    expect((await resolverAgregado(t.deps, { organizationId: p.organizationId, id: "x", decision: { tipo: "aceptar" }, actorUserId: ACTOR, propertyIds: null })).resultado).toEqual({ resultado: "no_disponible" });
    expect(await barrerAgregadosSla(t.deps, t.ahora())).toEqual({ disponible: false, avisados: 0, vencidos: 0, errores: 0 });
  });
});

describe("textos al cliente", () => {
  const a = { customerName: "Ana", orderNumber: 150, itemsAdded: [{ id: "1", name: "Coca-Cola", price: 30, quantity: 2 }, { id: "2", name: "Agua", price: 20, quantity: 1 }], totalAfter: 180, totalAdded: 80, orderTotal: 100, sucursal: "Altabrisa" } as never;
  it("listaProductos y textos sin «retraso», sin dinero a devolver y sin minutos", () => {
    expect(listaProductos([{ name: "Coca-Cola", quantity: 2 }, { name: "Agua", quantity: 1 }, { name: "Taco", quantity: 3 }])).toBe("2 Coca-Cola, 1 Agua y 3 Taco");
    for (const txt of [textoAgregadoAceptado(a), textoAgregadoRechazado(a), textoAgregadoSeguimiento(a), textoAgregadoVencido(a), guionDevolverLlamada(a, "otro")]) {
      expect(txt.toLowerCase()).not.toMatch(/retras|reembols|devoluci|\d+\s*min/);
    }
  });
});
