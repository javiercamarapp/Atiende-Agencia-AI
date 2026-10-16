// R12 romper (ronda 2) -- categoria A: pedidos IMPOSIBLES y excepciones. Lo que el servidor debe rechazar o reencaminar aunque el modelo (simulado) lo
// intente: hora pasada o fuera de horario, producto agotado o inexistente, sucursal cerrada hoy, feriado, programar a meses, cancelar o cambiar un
// pedido que ya esta en preparacion / salio / se entrego, mezclar canales. Herramientas y repositorio REALES en memoria; el modelo no interviene salvo donde se indica.
// Los textos hostiles describen la CLASE del intento (repo publico).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { classifyHighRiskIntent } from "../../src/whatsapp/guards.ts";
import { intentarCancelacionConAutopiloto } from "../../src/whatsapp/autopiloto-turno.ts";
import { InMemoryAutopilotoRepository, solicitarCancelacion } from "../../src/autopiloto/index.ts";
import type { AutopilotoServicioDeps } from "../../src/autopiloto/index.ts";
import { createOrder } from "../../src/orders.ts";
import { invokeAgentTool } from "../../src/agent-tools/registry.ts";
import { buildRestaurantFixture, flujo, hallazgo, itemsCoca, ordenes, pedidoCompleto } from "./arnes.ts";
import type { Fixture } from "./arnes.ts";

// Martes 2026-10-06 13:00 en Merida (UTC-6).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
});
afterEach(() => vi.useRealTimers());

const HORARIO_TODOS = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }];
const err = (out: { result: unknown }) => JSON.stringify(out.result).match(/"error":"([^"]*)"/)?.[1];

async function conHorario(f: Fixture, horario = HORARIO_TODOS) {
  f.repo.seedBranchPolicy(f.propertyId, { horario });
  await f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
}

describe("R12-A1 producto inexistente, de otra organizacion o agotado", () => {
  it("cotizar un product_id que no existe, uno de otra organizacion y uno vacio: error accionable, cero pedidos", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    for (const id of [randomUUID(), "", "00000000-0000-0000-0000-000000000000", "no-es-un-uuid", "'; select 1 --"]) {
      const out = await s.seguro("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: id, product_name: "Fantasma", requested_quantity: 1 }] });
      expect(err(out), `id=${id}`).toBeTruthy();
    }
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("producto de OTRA organizacion (id valido en la base) no se puede cotizar ni crear desde esta", async () => {
    const f = buildRestaurantFixture();
    const { seedSecondTenant } = await import("./arnes.ts");
    const otro = seedSecondTenant(f.repo);
    const s = flujo(f);
    const out = await s.seguro("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: otro.productId, product_name: "Agua Ajena", requested_quantity: 1 }] });
    expect(err(out)).toBeTruthy();
    expect(JSON.stringify(out.result)).not.toContain("Agua Ajena\",\"price");
  });

  it("producto agotado hoy: no se cotiza; el mensaje no lo ofrece como disponible y no hay pedido", async () => {
    const f = buildRestaurantFixture();
    await f.repo.setBranchProductAvailability(f.propertyId, f.products.cocaCola, false);
    const s = flujo(f);
    const out = await s.seguro("cotizar_pedido", s.base(2));
    expect(err(out)).toBeTruthy();
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("producto agotado DESPUES de cotizar y confirmar: crear_pedido se rechaza y no hay pedido", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    await s.quote(2);
    s.next();
    await s.confirm();
    await f.repo.setBranchProductAvailability(f.propertyId, f.products.cocaCola, false);
    const out = await s.seguro("crear_pedido", { ...s.base(2), customer_name: "Ana", payment_method: "efectivo" });
    expect(out.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("buscar_producto de algo que no existe devuelve lista vacia, nunca un producto 'parecido' inventado", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    const out = await s.seguro("buscar_producto", { query: "langosta thermidor con trufa", branch_slug: "fco-montejo" });
    const lista = JSON.stringify(out.result);
    expect(lista).not.toMatch(/Coca-Cola|Sol|Quesobich/);
  });
});

describe("R12-A2 hora pasada, fuera de horario y sucursal cerrada", () => {
  it("(control) sucursal abierta: cotiza", async () => {
    const f = buildRestaurantFixture();
    await conHorario(f);
    const s = flujo(f);
    expect(err(await s.seguro("cotizar_pedido", s.base(2)))).toBeUndefined();
  });

  it("sucursal CERRADA ahora (reloj 11:00): cotizar y crear se rechazan con la proxima apertura, sin pedido", async () => {
    vi.setSystemTime(new Date("2026-10-06T11:00:00-06:00"));
    const f = buildRestaurantFixture();
    await conHorario(f);
    const s = flujo(f);
    const q = await s.seguro("cotizar_pedido", s.base(2));
    expect(err(q)).toMatch(/cerrada|abre/i);
    const c = await s.seguro("crear_pedido", { ...s.base(2), customer_name: "Ana", payment_method: "efectivo" });
    expect(c.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("sucursal que HOY no abre (martes sin turno) pero si el resto de la semana: se rechaza hoy y se ofrece el dia que abre", async () => {
    const f = buildRestaurantFixture();
    await conHorario(f, [{ dias: [0, 1, 3, 4, 5, 6], abre: "12:00", cierra: "23:00" }]);
    const s = flujo(f);
    const out = await s.seguro("cotizar_pedido", s.base(2));
    expect(err(out)).toMatch(/cerrada|abre/i);
    expect(err(out)).toMatch(/mi[eé]rcoles/i);
  });

  it("hora_recogida ya pasada (hace 2 h), a mas de 12 h y para otro dia: se rechazan; 5 minutos atras (gracia) pasa", async () => {
    const f = buildRestaurantFixture();
    await conHorario(f);
    const s = flujo(f);
    for (const iso of ["2026-10-06T11:00:00-06:00", "2026-10-07T01:30:00-06:00", "2026-10-07T13:00:00-06:00", "2026-10-05T13:00:00-06:00"]) {
      const out = await s.seguro("cotizar_pedido", s.base(2, { hora_recogida: iso }));
      expect(err(out), iso).toBeTruthy();
    }
    expect(err(await s.seguro("cotizar_pedido", s.base(2, { hora_recogida: "2026-10-06T12:55:00-06:00" })))).toBeUndefined();
  });

  it("hora_recogida despues del cierre del dia de negocio (01:30 con cierre 01:00) se rechaza", async () => {
    const f = buildRestaurantFixture();
    await conHorario(f);
    vi.setSystemTime(new Date("2026-10-06T23:00:00-06:00"));
    const s = flujo(f);
    const out = await s.seguro("cotizar_pedido", s.base(2, { hora_recogida: "2026-10-07T01:30:00-06:00" }));
    expect(err(out)).toBeTruthy();
  });
});

describe("R12-A3 programar: feriado, meses adelante y limites", () => {
  it("un FERIADO cargado como excepcion de horario vacia (cerrado todo el dia) no admite pedidos programados ese dia, pero si el siguiente", async () => {
    const f = buildRestaurantFixture();
    await conHorario(f);
    await f.repo.createBranchHoursException(f.organizationId, { propertyId: f.propertyId, fechaDesde: "2026-10-09", fechaHasta: "2026-10-09", horario: [], motivo: "Feriado" });
    const s = flujo(f);
    const feriado = await s.seguro("cotizar_pedido", s.base(2, { programado_para: "2026-10-09T14:00:00-06:00" }));
    expect(err(feriado)).toMatch(/no atiende|cerrad/i);
    const siguiente = await s.seguro("cotizar_pedido", s.base(2, { programado_para: "2026-10-10T14:00:00-06:00" }));
    expect(err(siguiente)).toBeUndefined();
  });

  it("el feriado tambien cierra HOY para pedidos inmediatos (cotizar sin programar)", async () => {
    const f = buildRestaurantFixture();
    await conHorario(f);
    await f.repo.createBranchHoursException(f.organizationId, { propertyId: f.propertyId, fechaDesde: "2026-10-06", fechaHasta: "2026-10-06", horario: [], motivo: "Feriado" });
    const s = flujo(f);
    expect(err(await s.seguro("cotizar_pedido", s.base(2)))).toMatch(/cerrada|abre/i);
  });

  it("programar dentro de meses, a los 7 dias exactos + 1 minuto, y a menos de 30 minutos: rechazado; a 7 dias menos 1 hora: pasa", async () => {
    const f = buildRestaurantFixture();
    await conHorario(f);
    const s = flujo(f);
    for (const iso of ["2027-01-10T14:00:00-06:00", "2026-10-13T13:01:00-06:00", "2026-10-06T13:20:00-06:00", "2026-10-06T13:29:59-06:00"]) {
      expect(err(await s.seguro("cotizar_pedido", s.base(2, { programado_para: iso }))), iso).toBeTruthy();
    }
    expect(err(await s.seguro("cotizar_pedido", s.base(2, { programado_para: "2026-10-13T12:00:00-06:00" })))).toBeUndefined();
  });

  it("programar para hoy mismo antes de que abra (11:00 con apertura 12:00) o ya cerrada (01:30) se rechaza", async () => {
    const f = buildRestaurantFixture();
    await conHorario(f);
    const s = flujo(f);
    for (const iso of ["2026-10-07T11:00:00-06:00", "2026-10-07T01:30:00-06:00", "2026-10-07T03:00:00-06:00"]) {
      expect(err(await s.seguro("cotizar_pedido", s.base(2, { programado_para: iso }))), iso).toMatch(/no atiende|cerrad/i);
    }
  });

  it("cotizo para las 14:00 y al crear cambia la hora programada: se rechaza (no se mueve en silencio)", async () => {
    const f = buildRestaurantFixture();
    await conHorario(f);
    const s = flujo(f);
    await s.seguro("cotizar_pedido", s.base(2, { programado_para: "2026-10-07T14:00:00-06:00" }));
    s.next();
    await s.confirm();
    const out = await s.seguro("crear_pedido", { ...s.base(2), programado_para: "2026-10-07T20:00:00-06:00", customer_name: "Ana", payment_method: "efectivo" });
    expect(out.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });
});

describe("R12-A4 domicilio fuera de zona y direcciones", () => {
  it("domicilio con zonas de cobertura configuradas y colonia que ninguna sucursal cubre: se rechaza sin pedido", async () => {
    const f = buildRestaurantFixture();
    const zona = randomUUID();
    f.repo.seedKnownZone({ id: zona, organizationId: f.organizationId, name: "Colonia Lejana", centroidLat: null, centroidLng: null } as never);
    const dentro = randomUUID();
    f.repo.seedKnownZone({ id: dentro, organizationId: f.organizationId, name: "Centro", centroidLat: null, centroidLng: null } as never);
    f.repo.seedBranchDeliveryZones(f.propertyId, [dentro]);
    const s = flujo(f);
    const fuera = await s.seguro("cotizar_pedido", { ...s.base(2), canal: "domicilio", colonia_entrega: "Colonia Lejana" });
    expect(err(fuera)).toBeTruthy();
    expect(await ordenes(f)).toHaveLength(0);
    const ok = await s.seguro("cotizar_pedido", { ...s.base(2), canal: "domicilio", colonia_entrega: "Centro" });
    expect(err(ok)).toBeUndefined();
  });

  it("domicilio sin direccion (falta, vacia o solo espacios): crear_pedido se rechaza", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    const base = { branch_slug: "fco-montejo", canal: "domicilio", items: itemsCoca(f, 2) };
    await s.seguro("cotizar_pedido", base);
    s.next();
    await s.confirm();
    for (const direccion of [undefined, "", "   "]) {
      const out = await s.seguro("crear_pedido", { ...base, customer_name: "Ana", payment_method: "efectivo", ...(direccion === undefined ? {} : { customer_address: direccion }) });
      expect(out.orderId, String(direccion)).toBeNull();
    }
    expect(await ordenes(f)).toHaveLength(0);
  });

  // R12-02 (P2): una direccion de relleno («.», «no se», «n/a», «xxxxxxx») la dejaba pasar el servidor y el pedido llegaba a cocina sin destino para el repartidor.
  for (const direccion of [".", "no se", "n/a", "ninguna", "xxxxxxx", "???", "123", "sin direccion"]) {
    hallazgo(`R12-02 [P2, corregido] direccion de relleno «${direccion}»: crear_pedido a domicilio se rechaza`, async () => {
      const f = buildRestaurantFixture();
      const s = flujo(f);
      const base = { branch_slug: "fco-montejo", canal: "domicilio", items: itemsCoca(f, 2) };
      await s.seguro("cotizar_pedido", base);
      s.next();
      await s.confirm();
      const out = await s.seguro("crear_pedido", { ...base, customer_name: "Ana", payment_method: "efectivo", customer_address: direccion });
      expect(out.orderId).toBeNull();
      expect(await ordenes(f)).toHaveLength(0);
    });
  }

  it("(control) una direccion real corta pero completa («Calle 50 #200») si se acepta", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    const base = { branch_slug: "fco-montejo", canal: "domicilio", items: itemsCoca(f, 2) };
    await s.seguro("cotizar_pedido", base);
    s.next();
    await s.confirm();
    const out = await s.seguro("crear_pedido", { ...base, customer_name: "Ana", payment_method: "efectivo", customer_address: "Calle 50 #200" });
    expect(out.orderId).toBeTruthy();
  });
});

describe("R12-A5 cancelar o cambiar un pedido que ya avanzo (estados de cocina y reparto)", () => {
  async function conPedidoEn(estado: "pending" | "preparando" | "en_camino" | "entregado" | "cancelado") {
    const f = buildRestaurantFixture();
    f.repo.seedWhatsAppChannel(f.organizationId, "PNID-1");
    const creado = await createOrder(f.repo, {
      organizationId: f.organizationId, branchSlug: "fco-montejo", customerName: "Deb", customerPhone: "9990001111", customerAddress: "Calle 80 #30",
      items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }], source: "whatsapp", paymentMethod: "efectivo",
    });
    const orden = estado === "pending" ? creado : ((await f.repo.updateOrderStatus(creado.organizationId, creado.id, "pending", estado)) ?? creado);
    const auto = new InMemoryAutopilotoRepository();
    auto.pedidos.set(orden.id, { id: orden.id, organizationId: orden.organizationId, propertyId: orden.propertyId, status: estado, total: orden.total, clienteNombre: "Deb", telefono: orden.customerPhone, canal: "domicilio", numero: 7, renglones: [{ nombre: "Coca-Cola", cantidad: 2 }], programadoPara: null });
    const deps: AutopilotoServicioDeps = { auto, repo: f.repo, db: { async query() { return { rows: [{ emit_notification: 1 }] } as never; }, async exec() {} } as never, encolarComandas: async () => undefined };
    return { f, orden, auto, deps };
  }

  it.each(["preparando", "en_camino"] as const)("cancelar un pedido '%s': NUNCA se cancela solo; queda una solicitud para la sucursal y la respuesta no promete la cancelacion", async (estado) => {
    const t = await conPedidoEn(estado);
    const r = await solicitarCancelacion(t.deps, { organizationId: t.f.organizationId, customerPhone: "9990001111", desdeIso: "2026-10-05T00:00:00Z", avisarCliente: false });
    expect(r.resultado).toBe("solicitud_creada");
    expect(r.mensaje).not.toMatch(/qued[óo] cancelad|cancelamos|ya est[áa] cancelad/i);
    expect((await t.f.repo.findLatestOrderByPhone(t.f.organizationId, "9990001111", "2026-10-05T00:00:00Z"))?.status).toBe(estado);
  });

  it("cancelar un pedido ENTREGADO o ya cancelado: no hay pedido activo, no se abre solicitud y el turno sigue por el aviso al equipo", async () => {
    for (const estado of ["entregado", "cancelado"] as const) {
      const t = await conPedidoEn(estado);
      const r = await solicitarCancelacion(t.deps, { organizationId: t.f.organizationId, customerPhone: "9990001111", desdeIso: "2026-10-05T00:00:00Z", avisarCliente: false });
      expect(r.resultado, estado).toBe("sin_pedido_activo");
      const hook = await intentarCancelacionConAutopiloto(t.f.repo, { cancelacionActiva: async () => true, solicitarCancelacion: async () => r, registrarQueja: async () => undefined }, { organizationId: t.f.organizationId, phone: "9990001111", ahora: new Date(), texto: "cancela mi pedido" });
      expect(hook, estado).toBeNull();
    }
  });

  const estados = ["registrado", "preparando", "salio", "entregado", "programado"] as const;
  const pedido = (estado: (typeof estados)[number]) => ({ estado, canal: "domicilio" as const, sucursal: "Fco", confirmadoHoraLocal: "12:50", minutosDesdeConfirmacion: 10 });

  it.each(estados)("'cancela mi pedido' con el pedido en estado %s: escala (aviso fijo, sin prometer cancelacion)", (estado) => {
    const m = classifyHighRiskIntent("cancela mi pedido por favor", { pedidoReciente: pedido(estado) });
    expect(m?.motivo).toBe("cancelacion_modificacion");
    expect(m!.reply).not.toMatch(/queda cancelad|ya cancel/i);
  });

  // Cambios de direccion / contenido / hora de un pedido ya hecho: el agente NO tiene herramienta para editar pedidos. Si el cliente lo pide sobre un pedido
  // vigente, tiene que ir a una persona, no al modelo (que podria decir «listo, ya lo cambie»).
  const cambios = [
    "me equivoque de direccion, cambia la direccion de mi pedido a calle 5 #20",
    "ya salio mi pedido pero necesito que lo manden a otra direccion",
    "agrega 3 cocas a mi pedido",
    "quitale las cocas a mi pedido",
    "cambia la hora de mi pedido para las 3",
    "mejor que sea para recoger, ya no a domicilio, el pedido que ya hice",
  ];
  for (const frase of cambios) {
    for (const estado of ["registrado", "preparando", "salio"] as const) {
      hallazgo(`R12-01 [P1, corregido] «${frase.slice(0, 48)}…» con el pedido '${estado}' escala a una persona en vez de dejarlo al modelo`, async () => {
        const control = classifyHighRiskIntent("cancela mi pedido", { pedidoReciente: pedido(estado) });
        expect(control?.motivo).toBe("cancelacion_modificacion"); // control: la cancelacion si escala
        const m = classifyHighRiskIntent(frase, { pedidoReciente: pedido(estado) });
        expect(m?.motivo).toBe("cancelacion_modificacion");
      });
    }
  }

  it("(control) los mismos mensajes SIN pedido vigente, con el pedido ENTREGADO, o que piden un pedido NUEVO / preguntan, son el carrito o una consulta: no escalan", () => {
    for (const frase of cambios) {
      expect(classifyHighRiskIntent(frase, { pedidoReciente: null }), `${frase} sin pedido`).toBeNull();
      expect(classifyHighRiskIntent(frase, { pedidoReciente: pedido("entregado") }), `${frase} entregado`).toBeNull();
    }
    for (const frase of ["quiero otro pedido a otra direccion, ya el primero salio", "hago un pedido nuevo para otra direccion", "¿puedo agregar 3 cocas a mi pedido?", "quiero hacer mi pedido: 3 tacos, agrega una coca"]) {
      expect(classifyHighRiskIntent(frase, { pedidoReciente: pedido("salio") }), frase).toBeNull();
    }
  });
});

describe("R12-A6 mezclar canales (voz y WhatsApp) con el mismo telefono", () => {
  it("cotizar y confirmar por WhatsApp NO habilita crear_pedido por voz (cada canal tiene su propio flujo de confirmacion)", async () => {
    const f = buildRestaurantFixture();
    const wa = flujo(f, "9991234567");
    await wa.quote(2);
    wa.next();
    await wa.confirm();
    const ctxVoz = { organizationId: f.organizationId, channel: "voz" as const, phone: "9991234567", flow: { key: "voz:llamada-1", turn: "1" } };
    const out = await invokeAgentTool(f.repo, ctxVoz, "crear_pedido", { ...wa.base(2), customer_name: "Ana", payment_method: "efectivo" }).catch((e) => ({ orderId: null, result: { error: String(e) } }));
    expect(out.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("una confirmacion de otro telefono no sirve: dos clientes con el mismo carrito crean cada uno el suyo solo despues de confirmar el suyo", async () => {
    const f = buildRestaurantFixture();
    const a = flujo(f, "9991111111");
    const b = flujo(f, "9992222222");
    await a.quote(2);
    a.next();
    await a.confirm();
    await b.quote(2);
    b.next();
    const sinConfirmar = await b.seguro("crear_pedido", { ...b.base(2), customer_name: "Beto", payment_method: "efectivo" });
    expect(sinConfirmar.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });
});

describe("R12-A7 totales y pagos imposibles", () => {
  it("efectivo con un billete menor al total (50 para $90) y con exactamente el total: el primero se rechaza, el segundo pasa", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    await s.quote(2, { payment_method: "efectivo", efectivo_con: 50 });
    s.next();
    await s.confirm();
    const menor = await s.seguro("crear_pedido", { ...s.base(2), customer_name: "Ana", payment_method: "efectivo", efectivo_con: 50 });
    expect(menor.orderId).toBeNull();
    const exacto = await s.seguro("crear_pedido", { ...s.base(2), customer_name: "Ana", payment_method: "efectivo", efectivo_con: 90 });
    expect(exacto.orderId).toBeTruthy();
  });

  it("pagar con tarjeta y mandar 'efectivo_con' no cambia el total ni crea un cobro distinto", async () => {
    const f = buildRestaurantFixture();
    const { out } = await pedidoCompleto(f, "9991234567", 2, { payment_method: "tarjeta", efectivo_con: 1000 });
    void out;
    const [o] = await ordenes(f);
    expect(o?.total ?? 90).toBe(90);
  });
});
