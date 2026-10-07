// QA restaurantes, RONDA 2, lente EXCEPCIONES Y CAOS (main del 4-oct noche: #429 autopiloto, #435 comandas POS, #441 interruptor duro, #437 R-34).
// Cruces entre funciones nuevas que se rompen en el ciclo de punta a punta de PM (WhatsApp -> pedido -> cocina -> entrega -> cierre). Todo con dobles:
// repositorios en memoria, POS falso y reloj simulado; nada toca la base real ni manda mensajes.
// Cada `it.fails` es un defecto CONFIRMADO (QA-restaurantes-R2-caos-NN): al arreglarlo, el corrector cambia `it.fails` -> `it`.
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { prepararImportacionClientes } from "../src/clientes-importacion.ts";
import { AGENTE_APAGADO_TEXTO, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate } from "../src/index.ts";
import { InMemoryAutopilotoRepository } from "../src/autopiloto/in-memory-repository.ts";
import type { PedidoMemoria } from "../src/autopiloto/in-memory-repository.ts";
import { resolverSolicitudAprobacion } from "../src/autopiloto/servicio.ts";
import { estimarTiempo, pisoMinutosDeTexto } from "../src/autopiloto/tiempo-prometido.ts";
import { MapaProductoCodigo } from "../src/softrestaurant/catalog-map.ts";
import { FakeSoftRestaurantAdapter } from "../src/softrestaurant/fake-adapter.ts";
import { InMemoryComandaOutboxStore } from "../src/softrestaurant/outbox-memory-store.ts";
import { crearResolverSucursalPos, drenarComandas, encolarComandaParaPedido } from "../src/softrestaurant/outbox-service.ts";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { buildRestaurantFixture } from "./fixtures.ts";

const PHONE = "+5219991234567";
const STAFF = "00000000-0000-4000-8000-0000000000f1";

// ---------------------------------------------------------------------------------------------------------------------------------------
// R2-caos-01: interruptor duro (#441) + devolucion del handoff (#429 tick o boton "Devolver"): la conversacion queda huerfana
// ---------------------------------------------------------------------------------------------------------------------------------------
describe("R2-caos-01: agente de WhatsApp APAGADO y la toma se devuelve (tick de 15 min o boton)", () => {
  function setup() {
    const fixture = buildRestaurantFixture();
    const store = new InMemoryConversacionesRepository({ actorUserId: STAFF });
    const gate = new InMemoryHandoffAgentGate(store);
    let turnos = 0;
    const turnHandler: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        turnos += 1;
        return { reply: "Respuesta del agente", orderId: null, propertyId: null };
      },
    };
    const convId = "00000000-0000-4000-8000-0000000000c1";
    store.conversaciones.push({ canal: "whatsapp", id: convId, organizationId: fixture.organizationId, propertyId: fixture.propertyId, telefono: PHONE, mensajes: [], actividadAt: new Date().toISOString() });
    const enviar = (messageId: string, body: string) =>
      handleInboundWhatsAppMessage(fixture.repo, turnHandler, { organizationId: fixture.organizationId, messageId, phone: PHONE, body, phoneNumberId: "1", propertyId: fixture.propertyId, handoffGate: gate });
    return { fixture, store, enviar, convId, turnos: () => turnos };
  }

  // Pasos: agente apagado en la sucursal -> el cliente escribe (texto fijo + toma `agente_apagado`) -> una persona la TOMA y no alcanza a contestar
  // en 15 min -> el tick `handoffs_devolver_vencidos` la pasa a `devuelta` y manda "Gracias por esperar; le sigo atendiendo yo." (o la persona pulsa
  // "Devolver al agente"). El agente sigue APAGADO. El cliente vuelve a escribir.
  it.fails("QA-R2-caos-01: tras devolver la toma con el agente apagado, el siguiente mensaje del cliente vuelve a la bandeja (o recibe respuesta), no se pierde", async () => {
    const t = setup();
    await t.fixture.repo.fijarAgenteWhatsappActivo(t.fixture.organizationId, t.fixture.propertyId, STAFF, false);
    expect(await t.enviar("m1", "Quiero 3 ordenes de bistec")).toMatchObject({ reply: AGENTE_APAGADO_TEXTO });
    const handoffId = t.store.handoffs[0]!.id;
    await t.store.tomar(t.fixture.organizationId, t.fixture.propertyId, "whatsapp", t.convId);
    expect(await t.store.devolver(t.fixture.organizationId, t.fixture.propertyId, handoffId)).toBe(true);

    const despues = await t.enviar("m2", "¿Siguen ahí? necesito mi pedido");
    const abiertas = t.store.handoffs.filter((h) => h.estado === "pendiente" || h.estado === "tomada");
    // Esperado: o hay una toma ABIERTA (la conversacion sigue en la bandeja de una persona) o el cliente recibe alguna respuesta.
    // Actual: `{ ok: true, retryable: false }` sin respuesta, 0 tomas abiertas y 0 turnos del modelo: nadie atiende durante la ventana de 6 h del aviso.
    expect(abiertas.length > 0 || typeof (despues as { reply?: string }).reply === "string").toBe(true);
  });

  it("PASA: con el agente apagado y la toma ABIERTA, los mensajes siguientes no llaman al modelo ni repiten el aviso (comportamiento de #441)", async () => {
    const t = setup();
    await t.fixture.repo.fijarAgenteWhatsappActivo(t.fixture.organizationId, t.fixture.propertyId, STAFF, false);
    await t.enviar("m1", "Hola");
    expect(await t.enviar("m2", "¿Hola?")).toEqual({ ok: true, retryable: false });
    expect(t.turnos()).toBe(0);
    expect(t.store.handoffs.filter((h) => h.estado === "pendiente")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// R2-caos-02: cancelar con un clic desde "Por aprobar" (#429) no corta la comanda pendiente del POS (R-34 de #437 solo cubre el PATCH)
// ---------------------------------------------------------------------------------------------------------------------------------------
describe("R2-caos-02: cancelacion aprobada desde 'Por aprobar' con el POS caido", () => {
  const T0 = new Date("2026-10-05T18:00:00.000Z");
  const ORG_SISTEMA = null as unknown as TenantDbSession; // resolverSolicitudAprobacion no usa la sesion en este camino

  async function preparar() {
    const fx = buildRestaurantFixture();
    const order = await createOrder(fx.repo, {
      organizationId: fx.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Deb",
      customerPhone: "9990001111",
      customerAddress: "Calle 80 #30 x 5 y 7, Centro",
      paymentMethod: "efectivo",
      items: [{ productId: fx.products.cocaCola, requestedQuantity: 2 }],
      source: "web",
    });
    let reloj = T0;
    const ahora = () => reloj;
    const store = new InMemoryComandaOutboxStore({ ahora });
    store.ponerModo(fx.organizationId, "activo");
    const port = new FakeSoftRestaurantAdapter({ ahora });
    const mapa = new MapaProductoCodigo([{ productId: fx.products.cocaCola, codigo: "FAKE-003" }]);
    const politica = { maxIntentos: 3, baseMs: 30_000, maxMs: 900_000, leaseMs: 120_000 };
    const deps = { store, port, resolverCodigos: mapa, resolverSucursal: crearResolverSucursalPos({ [fx.propertyId]: "T2" }), ahora, politica };
    const auto = new InMemoryAutopilotoRepository();
    const mem: PedidoMemoria = {
      id: order.id, organizationId: fx.organizationId, propertyId: fx.propertyId, status: "pending", total: order.total, clienteNombre: "Deb", telefono: "9990001111",
      canal: "domicilio", numero: 1, renglones: [{ nombre: "Coca-Cola", cantidad: 2 }], comanda: { estado: "pendiente", folio: null },
    };
    auto.pedidos.set(order.id, mem);
    return {
      fx, order, store, port, deps, auto,
      avanzar: (ms: number) => (reloj = new Date(reloj.getTime() + ms)),
      drenar: () => drenarComandas({ port, abrirUnidad: async (fn) => fn({ store }), resolverCodigos: mapa, politica, ahora }, 10),
    };
  }

  // Pasos: pedido `pending`; el POS no contesta (timeout) -> comanda `fallida` en el outbox; el cliente pide cancelar por WhatsApp (pedido ya con
  // comanda => solicitud cancelar/mantener); el gerente pulsa "Cancelar" en "Por aprobar"; el POS vuelve y corre el despachador (cron de 5 min).
  it.fails("QA-R2-caos-02: la comanda del pedido cancelado con un clic NO llega a cocina cuando el POS vuelve", async () => {
    const t = await preparar();
    t.port.inyectarFalla("crearComanda", { tipo: "timeout" }, 1);
    await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(t.store.todas()[0]!.estado).toBe("fallida");

    const s = await t.auto.crearSolicitud(t.fx.organizationId, t.fx.propertyId, "cancelacion", t.order.id, { origen: "cliente", estado: "pending", motivo: "cliente_desistio" });
    const r = await resolverSolicitudAprobacion(
      { auto: t.auto, repo: t.fx.repo, db: ORG_SISTEMA, encolarComandas: async () => undefined },
      { organizationId: t.fx.organizationId, solicitudId: s.solicitudId!, decision: "cancelar", motivo: "cliente_desistio" },
    );
    expect(r?.resultado.estadoPedido).toBe("cancelado");

    t.avanzar(30 * 60_000);
    await t.drenar();
    // Esperado (igual que el PATCH de #437): 0 comandas en el POS. Actual: 1 (la cocina prepara un pedido cancelado).
    expect(t.port.comandas).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// R2-caos-03: barrido `listo_para_recoger -> no_recogido` cuenta desde la hora de recogida, no desde que el pedido quedo listo
// ---------------------------------------------------------------------------------------------------------------------------------------
describe("R2-caos-03: cocina retrasada y cliente que llega tarde contra el barrido de no_recogido", () => {
  function pedidoRecoger(auto: InMemoryAutopilotoRepository, horaRecogida: Date): PedidoMemoria {
    const p: PedidoMemoria = {
      id: "00000000-0000-4000-8000-00000000a001", organizationId: "00000000-0000-4000-8000-00000000000a", propertyId: "00000000-0000-4000-8000-00000000000b",
      status: "preparando", total: 328, clienteNombre: "Ana", telefono: "9991112233", canal: "recoger", numero: 50, renglones: [{ nombre: "Bistec", cantidad: 2 }], horaRecogida,
    };
    auto.pedidos.set(p.id, p);
    return p;
  }

  // Pasos: el cliente pidio para recoger a las 13:00 (hora local); la cocina va atrasada y marca "Listo" a las 14:05; el tick de 5 min corre a las 14:05.
  it.fails("QA-R2-caos-03: un pedido que se acaba de marcar listo NO se marca no_recogido en el siguiente tick", async () => {
    const auto = new InMemoryAutopilotoRepository();
    const p = pedidoRecoger(auto, new Date("2026-10-05T19:00:00.000Z")); // 13:00 en Merida
    const listoA = new Date("2026-10-05T20:05:00.000Z"); // 14:05: la cocina lo termina tarde
    p.status = "listo_para_recoger";
    const candidatos = (await auto.candidatosEstados(listoA, 200)).valor;
    // Actual: [{ hacia: "no_recogido" }] -> la campana avisa "no recogido" y el pedido sale de "Listos" mientras el cliente va en camino.
    expect(candidatos.filter((c) => c.orderId === p.id)).toEqual([]);
  });

  // Pasos: el cliente llega 70 min tarde (14:10) a un pedido ya marcado no_recogido. no_recogido solo puede volver a `preparando` (order-lifecycle);
  // el staff lo pasa a preparando -> listo para entregarlo, y el tick siguiente lo vuelve a tirar a no_recogido.
  it.fails("QA-R2-caos-03b: re-marcar listo un pedido no_recogido (cliente en mostrador) no lo regresa a no_recogido en el siguiente tick", async () => {
    const auto = new InMemoryAutopilotoRepository();
    const p = pedidoRecoger(auto, new Date("2026-10-05T19:00:00.000Z"));
    p.status = "no_recogido";
    // El staff: no_recogido -> preparando -> listo_para_recoger (unico camino que permite order-lifecycle para entregarlo).
    p.status = "listo_para_recoger";
    const tick = new Date("2026-10-05T20:12:00.000Z");
    const candidatos = (await auto.candidatosEstados(tick, 200)).valor;
    expect(candidatos.filter((c) => c.orderId === p.id && c.hacia === "no_recogido")).toEqual([]);
  });

  it("PASA: un pedido listo a tiempo que nadie recoge pasa a no_recogido a los 60 min de la hora de recogida", async () => {
    const auto = new InMemoryAutopilotoRepository();
    const p = pedidoRecoger(auto, new Date("2026-10-05T19:00:00.000Z"));
    p.status = "listo_para_recoger";
    expect((await auto.candidatosEstados(new Date("2026-10-05T19:59:00.000Z"), 200)).valor).toEqual([]);
    expect((await auto.candidatosEstados(new Date("2026-10-05T20:00:00.000Z"), 200)).valor.map((c) => c.hacia)).toEqual(["no_recogido"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// R2-caos-04: hora de recogida en el pasado (o del dia equivocado) aceptada sin validar
// ---------------------------------------------------------------------------------------------------------------------------------------
describe("R2-caos-04: hora_recogida fuera de rango", () => {
  async function crearRecoger(horaRecogida: string) {
    const fx = buildRestaurantFixture();
    return createOrder(fx.repo, {
      organizationId: fx.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Ana",
      customerPhone: "9991112233",
      paymentMethod: "efectivo",
      canal: "recoger",
      horaRecogida,
      items: [{ productId: fx.products.cocaCola, requestedQuantity: 1 }],
      source: "whatsapp",
    });
  }

  // Pasos: el modelo manda hora_recogida con la fecha de AYER (o con "Z" en vez de -06:00, que la corre 6 h hacia atras), como ya paso con fechas
  // en los chats reales. Combinado con R2-caos-03, el pedido se marca no_recogido en cuanto cocina lo termina.
  it.fails("QA-R2-caos-04: una hora de recogida de hace 3 horas se rechaza (o se corrige) en vez de guardarse tal cual", async () => {
    const hace3h = new Date(Date.now() - 3 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await expect(crearRecoger(hace3h)).rejects.toThrow();
  });

  it.fails("QA-R2-caos-04b: una hora de recogida de dentro de 9 dias se rechaza (no es 'hoy')", async () => {
    const en9dias = new Date(Date.now() + 9 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await expect(crearRecoger(en9dias)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// R2-caos-05: tiempo prometido aprendido por debajo del piso del dueno (texto en horas o numero de otro canal)
// ---------------------------------------------------------------------------------------------------------------------------------------
describe("R2-caos-05: piso del dueno al prometer tiempo (A-21/B-09: 'NUNCA promete menos que el piso del dueno')", () => {
  const SIN_SATURACION = { umbral1: null, umbral2: null, extraMinutos: 15 };
  const muestras35 = Array.from({ length: 25 }, () => 35);

  it("PASA: 'Domicilio 30-45 min, recoger 15-25 min' -> pisos 30 y 15", () => {
    expect(pisoMinutosDeTexto("Domicilio 30-45 min, recoger 15-25 min", "domicilio")).toBe(30);
    expect(pisoMinutosDeTexto("Domicilio 30-45 min, recoger 15-25 min", "recoger")).toBe(15);
  });

  // Pasos: el dueno escribe su tiempo en HORAS (domingo de mucha demanda): "Domicilio de 1 a 2 horas". Hay >= 20 entregas de 35 min en la franja.
  it.fails("QA-R2-caos-05: 'Domicilio de 1 a 2 horas' nunca promete menos de 60 minutos", () => {
    const t = estimarTiempo({ textoFijo: "Domicilio de 1 a 2 horas", canal: "domicilio", muestras: muestras35, abiertos: 0, saturacion: SIN_SATURACION });
    // Actual: piso = 1 (minuto) y el texto al cliente es "de 30 a 40 minutos".
    expect(t.rango === null || t.rango.minimo >= 60).toBe(true);
  });

  // Pasos: el dueno no da numero para domicilio y si para recoger: "Domicilio segun la zona; para recoger 15-20 min".
  it.fails("QA-R2-caos-05b: el numero de RECOGER no se usa como piso de DOMICILIO", () => {
    expect(pisoMinutosDeTexto("Domicilio según la zona; para recoger 15-20 min", "domicilio")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// R2-caos-07: importacion de cartera (#435) -- un mapeo equivocado no se puede corregir reimportando
// ---------------------------------------------------------------------------------------------------------------------------------------
describe("R2-caos-07: reimportar para corregir un mapeo de columnas equivocado", () => {
  const HUELLA = "a".repeat(64); // sha-256 de los BYTES del archivo: no cambia al cambiar el mapeo en el dialogo

  // Pasos: Clientes -> Importar -> el mapeo asistido (o la persona) deja "Nombre" apuntando a la columna "Colonia"; se importan los renglones.
  // La persona ve el error en la lista de clientes, corrige el mapeo y vuelve a importar EL MISMO archivo; luego prueba con el archivo corregido.
  it.fails("QA-R2-caos-07: reimportar con el mapeo corregido arregla los nombres (o el panel ofrece deshacer la importacion)", async () => {
    const fx = buildRestaurantFixture();
    const malo = prepararImportacionClientes([{ telefono: "9991230001", nombre: "Itzimná", direccion: "Calle 1", colonia: "", notas: "" }]);
    await fx.repo.importarClientes(fx.organizationId, HUELLA, malo.validas);
    expect((await fx.repo.findCustomerByPhone(fx.organizationId, "9991230001"))?.name).toBe("Itzimná");

    const bueno = prepararImportacionClientes([{ telefono: "9991230001", nombre: "José Peña", direccion: "Calle 1", colonia: "Itzimná", notas: "" }]);
    const mismoArchivo = await fx.repo.importarClientes(fx.organizationId, HUELLA, bueno.validas);
    expect(mismoArchivo.yaImportado).toBe(true); // "Este archivo ya se habia importado: no se volvio a escribir nada."
    const otroArchivo = await fx.repo.importarClientes(fx.organizationId, "b".repeat(64), bueno.validas);
    expect(otroArchivo.sinCambios).toBe(1); // "nunca pisa el nombre conocido"
    // Actual: sigue "Itzimná" para siempre; el agente (Cliente 360) saluda "Hola Itzimná". Solo queda editar cliente por cliente (hasta 5,000).
    expect((await fx.repo.findCustomerByPhone(fx.organizationId, "9991230001"))?.name).toBe("José Peña");
  });
});
