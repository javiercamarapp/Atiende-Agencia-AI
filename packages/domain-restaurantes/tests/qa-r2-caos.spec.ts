// QA restaurantes, RONDA 2, lente EXCEPCIONES Y CAOS (main del 4-oct noche: #429 autopiloto, #435 comandas POS, #441 interruptor duro, #437 R-34).
// Cruces entre funciones nuevas que se rompen en el ciclo de punta a punta de PM (WhatsApp -> pedido -> cocina -> entrega -> cierre). Todo con dobles:
// repositorios en memoria, POS falso y reloj simulado; nada toca la base real ni manda mensajes.
// Cada prueba QA-R2-caos-NN fija la correccion de su defecto (QA-restaurantes-R2-caos-NN).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrder } from "../src/orders.ts";
import { prepararImportacionClientes } from "../src/clientes-importacion.ts";
import { AGENTE_APAGADO_TEXTO, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate } from "../src/index.ts";
import { InMemoryAutopilotoRepository } from "../src/autopiloto/in-memory-repository.ts";
import type { PedidoMemoria } from "../src/autopiloto/in-memory-repository.ts";
import { estimarTiempo, pisoMinutosDeTexto } from "../src/autopiloto/tiempo-prometido.ts";
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
  it("QA-R2-caos-01: tras devolver la toma con el agente apagado, el siguiente mensaje del cliente vuelve a la bandeja (o recibe respuesta), no se pierde", async () => {
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
  it("QA-R2-caos-03: un pedido que se acaba de marcar listo NO se marca no_recogido en el siguiente tick", async () => {
    const auto = new InMemoryAutopilotoRepository();
    const p = pedidoRecoger(auto, new Date("2026-10-05T19:00:00.000Z")); // 13:00 en Merida
    const listoA = new Date("2026-10-05T20:05:00.000Z"); // 14:05: la cocina lo termina tarde
    p.status = "listo_para_recoger";
    p.listoDesde = listoA; // la base lo deriva del ultimo evento a listo_para_recoger de order_status_events
    const candidatos = (await auto.candidatosEstados(listoA, 200)).valor;
    // Actual: [{ hacia: "no_recogido" }] -> la campana avisa "no recogido" y el pedido sale de "Listos" mientras el cliente va en camino.
    expect(candidatos.filter((c) => c.orderId === p.id)).toEqual([]);
  });

  // Pasos: el cliente llega 70 min tarde (14:10) a un pedido ya marcado no_recogido. no_recogido solo puede volver a `preparando` (order-lifecycle);
  // el staff lo pasa a preparando -> listo para entregarlo, y el tick siguiente lo vuelve a tirar a no_recogido.
  it("QA-R2-caos-03b: re-marcar listo un pedido no_recogido (cliente en mostrador) no lo regresa a no_recogido en el siguiente tick", async () => {
    const auto = new InMemoryAutopilotoRepository();
    const p = pedidoRecoger(auto, new Date("2026-10-05T19:00:00.000Z"));
    p.status = "no_recogido";
    // El staff: no_recogido -> preparando -> listo_para_recoger (unico camino que permite order-lifecycle para entregarlo).
    p.status = "listo_para_recoger";
    p.listoDesde = new Date("2026-10-05T20:10:00.000Z"); // re-marcado listo: el plazo se reinicia
    const tick = new Date("2026-10-05T20:12:00.000Z");
    const candidatos = (await auto.candidatosEstados(tick, 200)).valor;
    expect(candidatos.filter((c) => c.orderId === p.id && c.hacia === "no_recogido")).toEqual([]);
  });

  it("PASA: un pedido listo a tiempo que nadie recoge pasa a no_recogido a los 60 min de la hora de recogida", async () => {
    const auto = new InMemoryAutopilotoRepository();
    const p = pedidoRecoger(auto, new Date("2026-10-05T19:00:00.000Z"));
    p.status = "listo_para_recoger";
    p.listoDesde = new Date("2026-10-05T18:30:00.000Z"); // listo a tiempo, antes de la hora de recogida
    expect((await auto.candidatosEstados(new Date("2026-10-05T19:59:00.000Z"), 200)).valor).toEqual([]);
    expect((await auto.candidatosEstados(new Date("2026-10-05T20:00:00.000Z"), 200)).valor.map((c) => c.hacia)).toEqual(["no_recogido"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// R2-caos-04: hora de recogida en el pasado (o del dia equivocado) aceptada sin validar
// ---------------------------------------------------------------------------------------------------------------------------------------
describe("R2-caos-04: hora_recogida fuera de rango", () => {
  // Reloj simulado (solo Date): martes 13:00 de Merida; con el reloj real +30 min / -5 min cruzan de dia en ciertas horas UTC.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
  });
  afterEach(() => vi.useRealTimers());

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
  it("QA-R2-caos-04: una hora de recogida de hace 3 horas se rechaza (o se corrige) en vez de guardarse tal cual", async () => {
    const hace3h = new Date(Date.now() - 3 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await expect(crearRecoger(hace3h)).rejects.toThrow();
  });

  it("QA-R2-caos-04b: una hora de recogida de dentro de 9 dias se rechaza (no es 'hoy')", async () => {
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
  it("QA-R2-caos-05: 'Domicilio de 1 a 2 horas' nunca promete menos de 60 minutos", () => {
    const t = estimarTiempo({ textoFijo: "Domicilio de 1 a 2 horas", canal: "domicilio", muestras: muestras35, abiertos: 0, saturacion: SIN_SATURACION });
    // Actual: piso = 1 (minuto) y el texto al cliente es "de 30 a 40 minutos".
    expect(t.rango === null || t.rango.minimo >= 60).toBe(true);
  });

  // Pasos: el dueno no da numero para domicilio y si para recoger: "Domicilio segun la zona; para recoger 15-20 min".
  it("QA-R2-caos-05b: el numero de RECOGER no se usa como piso de DOMICILIO", () => {
    expect(pisoMinutosDeTexto("Domicilio según la zona; para recoger 15-20 min", "domicilio")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// R2-caos-07: importacion de cartera (#435) -- un mapeo equivocado se corrige reimportando
// ---------------------------------------------------------------------------------------------------------------------------------------
describe("R2-caos-07: reimportar para corregir un mapeo de columnas equivocado", () => {
  // La huella de una importacion es archivo + mapeo (apps/web huellaConMapeo): el mismo archivo con otro mapeo es OTRA importacion.
  const HUELLA_MAPEO_MALO = "a".repeat(64);
  const HUELLA_MAPEO_BUENO = "b".repeat(64);
  const TEL = "9991230001";

  async function importarMalo(fx: ReturnType<typeof buildRestaurantFixture>) {
    // "Nombre" apuntaba a la columna Colonia y "Direccion" a la de Notas por error.
    const malo = prepararImportacionClientes([{ telefono: TEL, nombre: "Itzimná", direccion: "Sin dirección", colonia: "", notas: "" }]);
    await fx.repo.importarClientes(fx.organizationId, HUELLA_MAPEO_MALO, malo.validas);
    expect((await fx.repo.findCustomerByPhone(fx.organizationId, TEL))?.name).toBe("Itzimná");
  }
  const bueno = () => prepararImportacionClientes([{ telefono: TEL, nombre: "José Peña", direccion: "Calle 1 x 2 y 4, Itzimná", colonia: "", notas: "" }]).validas;

  it("QA-R2-caos-07: reimportar el MISMO archivo con el mapeo corregido arregla el nombre y el domicilio predeterminado", async () => {
    const fx = buildRestaurantFixture();
    await importarMalo(fx);
    const r = await fx.repo.importarClientes(fx.organizationId, HUELLA_MAPEO_BUENO, bueno());
    if (!r.disponible) throw new Error("importacion no disponible");
    expect(r).toMatchObject({ yaImportado: false, actualizados: 1, sinCambios: 0 });
    const cliente = await fx.repo.findCustomerByPhone(fx.organizationId, TEL);
    expect(cliente?.name).toBe("José Peña"); // el agente (Cliente 360) ya no saluda "Hola Itzimná"
    const domicilios = await fx.repo.listCustomerAddresses(cliente!.id);
    expect(domicilios.find((d) => d.isDefault)?.address).toBe("Calle 1 x 2 y 4, Itzimná");
  });

  it("la misma importacion (mismo archivo y mismo mapeo) sigue siendo idempotente", async () => {
    const fx = buildRestaurantFixture();
    await importarMalo(fx);
    await fx.repo.importarClientes(fx.organizationId, HUELLA_MAPEO_BUENO, bueno());
    const otra = await fx.repo.importarClientes(fx.organizationId, HUELLA_MAPEO_BUENO, bueno());
    if (!otra.disponible) throw new Error("importacion no disponible");
    expect(otra.yaImportado).toBe(true);
  });

  it("NO pisa un nombre que una persona o el agente cambiaron despues de la importacion", async () => {
    const fx = buildRestaurantFixture();
    await importarMalo(fx);
    const cliente = (await fx.repo.findCustomerByPhone(fx.organizationId, TEL))!;
    await fx.repo.updateCustomerProfile(fx.organizationId, cliente.id, { name: "Pepe (el de siempre)" });
    const r = await fx.repo.importarClientes(fx.organizationId, HUELLA_MAPEO_BUENO, bueno());
    if (!r.disponible) throw new Error("importacion no disponible");
    expect((await fx.repo.findCustomerByPhone(fx.organizationId, TEL))?.name).toBe("Pepe (el de siempre)");
  });

  it("NO pisa el nombre de un cliente que ya existia antes de importar (no lo escribio ninguna importacion)", async () => {
    const fx = buildRestaurantFixture();
    await fx.repo.upsertCustomer(fx.organizationId, TEL, "Nombre del agente");
    const r = await fx.repo.importarClientes(fx.organizationId, HUELLA_MAPEO_BUENO, bueno());
    if (!r.disponible) throw new Error("importacion no disponible");
    expect(r.sinCambios).toBe(1);
    expect((await fx.repo.findCustomerByPhone(fx.organizationId, TEL))?.name).toBe("Nombre del agente");
  });
});

describe("R2-caos-04/05 (bordes de las correcciones)", () => {
  // Reloj simulado (solo Date): martes 13:00 de Merida; con el reloj real +30 min / -5 min cruzan de dia en ciertas horas UTC.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("hora_recogida: 5 minutos atras se tolera (el modelo redondea 'paso ya'); 11 atras, 8 dias y 6 dias adelante no (otro dia = programado_para)", async () => {
    const fx = buildRestaurantFixture();
    const crear = (offsetMin: number) =>
      createOrder(fx.repo, {
        organizationId: fx.organizationId, branchSlug: "fco-montejo", customerName: "Ana", customerPhone: "9991112233", paymentMethod: "efectivo", canal: "recoger",
        horaRecogida: new Date(Date.now() + offsetMin * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        items: [{ productId: fx.products.cocaCola, requestedQuantity: 1 }], source: "whatsapp",
      });
    await expect(crear(-5)).resolves.toBeDefined();
    await expect(crear(-11)).rejects.toThrow(/ya pasó/);
    await expect(crear(8 * 24 * 60)).rejects.toThrow(/próximos 7 días/);
    // PR #467 (PM agente loop R2) fijo que hora_recogida es SOLO "de hoy" (maximo 12 h; reglas-pedido.ts): una recogida a 6 dias ya no se acepta
    // como hora_recogida, para otro dia se usa programado_para. El borde de 7 dias de este test sigue protegiendo (orders.ts, se evalua antes).
    await expect(crear(6 * 24 * 60)).rejects.toThrow(/12 horas/);
    await expect(crear(30)).resolves.toBeDefined();
  });

  it("pisoMinutosDeTexto entiende horas, 'media hora' y no usa numeros ambiguos sin unidad", () => {
    expect(pisoMinutosDeTexto("Domicilio de 1 a 2 horas", "domicilio")).toBe(60);
    expect(pisoMinutosDeTexto("Domicilio 1.5 horas, recoger 20 min", "domicilio")).toBe(90);
    expect(pisoMinutosDeTexto("Domicilio 1.5 horas, recoger 20 min", "recoger")).toBe(20);
    expect(pisoMinutosDeTexto("Recoger media hora; domicilio una hora", "recoger")).toBe(30);
    expect(pisoMinutosDeTexto("Recoger media hora; domicilio una hora", "domicilio")).toBe(60);
    expect(pisoMinutosDeTexto("Domicilio 2", "domicilio")).toBeNull();
    expect(pisoMinutosDeTexto("Domicilio 40", "domicilio")).toBe(40);
  });

  it("estimarTiempo con texto en horas nunca promete menos del piso; con numero de otro canal usa el texto fijo", () => {
    const sat = { umbral1: null, umbral2: null, extraMinutos: 15 };
    const muestras = Array.from({ length: 25 }, () => 35);
    expect(estimarTiempo({ textoFijo: "Domicilio de 1 a 2 horas", canal: "domicilio", muestras, abiertos: 0, saturacion: sat }).rango?.minimo).toBeGreaterThanOrEqual(60);
    const t = estimarTiempo({ textoFijo: "Domicilio según la zona; para recoger 15-20 min", canal: "domicilio", muestras, abiertos: 0, saturacion: sat });
    expect(t.origen).toBe("texto_fijo");
  });
});

describe("R2-caos-01 (SQL en memoria): el regreso automatico del handoff respeta el interruptor del agente", () => {
  it("la toma de una sucursal con el agente apagado no regresa al agente; con el agente encendido si", async () => {
    const auto = new InMemoryAutopilotoRepository();
    const org = "00000000-0000-4000-8000-00000000000a";
    const apagada = "00000000-0000-4000-8000-00000000000b";
    const encendida = "00000000-0000-4000-8000-00000000000c";
    const base = { organizationId: org, conversationId: "c", telefono: "9991112233", estado: "tomada" as const, tomadaAt: new Date("2026-10-05T18:00:00Z"), ultimaHumanaAt: null, ultimoClienteAt: new Date("2026-10-05T18:00:00Z") };
    auto.handoffs.push({ ...base, id: "h-apagada", propertyId: apagada }, { ...base, id: "h-encendida", propertyId: encendida });
    auto.agentesApagados.add(apagada);
    const r = (await auto.devolverHandoffsVencidos(new Date("2026-10-05T19:00:00Z"), 50)).valor;
    expect(r.map((h) => h.handoffId)).toEqual(["h-encendida"]);
    expect(auto.handoffs.find((h) => h.id === "h-apagada")?.estado).toBe("tomada");
  });
});
