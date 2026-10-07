// Prueba de PUNTA A PUNTA sin red: telefonia falsa (PCM) + proveedor de voz guionado + la API REAL en proceso (Hono con repositorios en memoria) +
// el motor real de pedidos. El guion "cliente recurrente pide lo de siempre a domicilio" termina con un pedido real `source = voice`, el cliente
// actualizado (order_count + 1, tier recalculado), la comanda encolada en el outbox de SoftRestaurant, la conversacion de voz cerrada con su costo y
// su latencia de voz a voz. Repetir la MISMA llamada no crea un segundo pedido.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crearEscaleraLlamada } from "@atiende/voice-core";
import type { SumideroLog } from "@atiende/voice-core";
import { lookupCustomer } from "@atiende/domain-restaurantes";
import { BRANCH_SLUG_PRINCIPAL } from "../../../packages/domain-restaurantes/src/voz/simulador/mundo-voz.ts";
import type { MemoriaTools } from "../../../packages/domain-restaurantes/src/voz/simulador/tipos.ts";
import { Worker } from "../src/worker.ts";
import { TelefoniaFalsa } from "../src/telefonia/falsa.ts";
import { AgenteGuionado } from "./support/agente-guionado.ts";
import type { PasoGuion, TurnoGuion } from "./support/agente-guionado.ts";
import { turnoCliente } from "./support/llamada.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";
import type { MundoApi } from "./support/mundo-api.ts";

const SUC = BRANCH_SLUG_PRINCIPAL;
const TELEFONO = "9991234567";
const SIP_DESDE = "+5219991234567";
const DIRECCION = "Calle 63 número 412 por 45 y 47, colonia Centro";

const dice = (texto: string): PasoGuion => ({ dice: texto });
const linea = (m: MemoriaTools) => {
  const p = m.producto("bistec");
  return { product_id: p.id, product_name: p.name, requested_quantity: 6, tortilla: "maiz" };
};
const buscar: PasoGuion = { tool: "buscar_producto", args: { query: "bistec", branch_slug: SUC } };
const cotizar: PasoGuion = { tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, items: [linea(m)], canal: "domicilio", colonia_entrega: "Centro" }) };
const confirmar: PasoGuion = { tool: "confirmar_resumen", args: (m) => ({ quote_hash: m.quoteHash() }) };
const crear: PasoGuion = {
  tool: "crear_pedido",
  args: (m) => ({ branch_slug: SUC, customer_name: "Ana Pech", items: [linea(m)], payment_method: "efectivo", canal: "domicilio", customer_address: DIRECCION, colonia_entrega: "Centro", customer_email: "ana@ejemplo.invalid" }),
};

/** Guion de la llamada: consentimiento de grabacion, pedido, confirmacion, datos y cierre. */
function guionPedido(recurrente: boolean): TurnoGuion[] {
  return [
    { cliente: "Sí, autorizo que se grabe la llamada", agente: [dice("Gracias, queda registrado. ¿Qué desea pedir?")] },
    {
      cliente: recurrente ? "Lo de siempre, a domicilio, estoy por el Centro" : "Seis tacos de bistec de maíz, a domicilio por el Centro",
      agente: [{ tool: "buscar_cliente", args: {} }, { tool: "buscar_sucursal_cercana", args: { colonia: "Centro" } }, buscar, cotizar, dice("Son dos órdenes de tres tacos de bistec, trescientos veintiocho pesos. ¿Le parece bien?")],
    },
    { cliente: "Sí, está bien", agente: [confirmar, dice("Perfecto. ¿A nombre de quién y cuál es la dirección completa?")] },
    { cliente: "A nombre de Ana Pech, calle sesenta y tres número cuatrocientos doce, colonia Centro, pago en efectivo", agente: [crear, dice("Listo, su pedido quedó registrado. Gracias por llamar.")] },
  ];
}

/** El cliente de la llamada tal como lo ve el agente (memoria real: nombre, cuantos pedidos, tier). Falla si el sistema aun no lo conoce. */
async function clienteConocido(api: MundoApi) {
  const c = await lookupCustomer(api.mundo.repo, api.mundo.organizationId, TELEFONO);
  if (c.isNew) throw new Error("el cliente deberia existir tras el pedido");
  return c;
}

interface Prueba {
  readonly api: MundoApi;
  readonly telefonia: TelefoniaFalsa;
  readonly worker: Worker;
}

async function armar(opts: { agente: () => AgenteGuionado; mundo?: MundoApi; log?: SumideroLog }): Promise<Prueba & { llamar: (id: string, recurrente: boolean) => Promise<{ agente: AgenteGuionado }> }> {
  const api = opts.mundo ?? (await crearMundoApi());
  const telefonia = new TelefoniaFalsa();
  let agenteActual: AgenteGuionado = opts.agente();
  const worker = new Worker({
    config: api.config,
    telefonia,
    log: () => undefined,
    deps: api.depsAtencion({ crearEscalera: () => crearEscaleraLlamada([agenteActual.escalon()], { ahora: api.reloj.ahora }), ...(opts.log ? { log: opts.log } : {}) }),
  });
  expect(await worker.iniciar()).toBe(true);
  const llamar = async (id: string, recurrente: boolean) => {
    const agente = new AgenteGuionado(guionPedido(recurrente));
    agenteActual = agente;
    // Se cuenta ANTES de llamar: tras crear el pedido la despedida del agente cuelga la llamada (QA-PM-R2-voz-16) y la llamada puede cerrar antes que el cliente.
    const antes = worker.salud().llamadasAtendidas;
    const llamada = telefonia.llamar({ id, dnis: NUMERO_SUCURSAL, desde: SIP_DESDE });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    for (let i = 1; i <= agente.turnos.length; i++) await turnoCliente(llamada, api.reloj, () => agente.respondidos, i);
    llamada.clienteCuelga();
    await vi.waitFor(() => expect(worker.salud().llamadasAtendidas).toBe(antes + 1), { timeout: 5_000, interval: 5 });
    return { agente };
  };
  return { api, telefonia, worker, llamar };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("llamada de punta a punta (telefonia falsa + proveedor guionado + API real en proceso)", () => {
  it("cliente recurrente pide lo de siempre a domicilio: pedido voz, cliente actualizado, comanda al POS, conversacion cerrada con costo y latencia", async () => {
    const t = await armar({ agente: () => new AgenteGuionado([]) });
    const { api } = t;

    // Primera llamada: cliente nuevo.
    const primera = await t.llamar("llamada-A", false);
    expect(primera.agente.memoria.ultimo("buscar_cliente")).toEqual({ isNew: true });
    let pedidos = await api.mundo.pedidos();
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toMatchObject({ source: "voice", status: "pending", total: 328 });
    expect(await clienteConocido(api)).toMatchObject({ orderCount: 1 });

    // Pasaron mas de 5 minutos: la proteccion contra duplicados (huella de 5 min) ya no aplica a un pedido nuevo del mismo cliente.
    vi.setSystemTime(new Date("2026-03-10T18:30:00.000Z"));

    // Segunda llamada, otro `callId`: el cliente ya es recurrente y pide lo de siempre.
    const segunda = await t.llamar("llamada-B", true);
    const instruccion = segunda.agente.aperturas[0]?.instruccion ?? "";
    expect(instruccion).toContain(`Llamada a "Francisco de Montejo" (branch_slug "${SUC}")`); // sucursal MARCADA de la llamada
    expect(instruccion).toContain("buscar_cliente"); // el perfil de voz manda recuperar la memoria del cliente con la herramienta
    expect(instruccion).not.toContain(TELEFONO); // el telefono nunca viaja en la instruccion
    // La memoria del cliente la trae la herramienta con el telefono del SIP From (token de la llamada): recurrente, con su ultimo pedido.
    expect(segunda.agente.memoria.ultimo("buscar_cliente")).toMatchObject({ isNew: false, orderCount: 1, lastOrderItems: [{ name: "Tacos de Bistec de Res (orden de 3)", quantity: 2 }] });

    pedidos = await api.mundo.pedidos();
    expect(pedidos).toHaveLength(2);
    expect(pedidos.every((p) => p.source === "voice")).toBe(true);
    const cliente = await clienteConocido(api);
    expect(cliente.orderCount).toBe(2);
    expect(cliente.tier).toBeTruthy();

    // La comanda de cada pedido quedo encolada en el outbox de SoftRestaurant (modo sombra de la organizacion).
    expect(api.srStore.todas()).toHaveLength(2);

    // La confirmacion por correo del pedido (el cliente dejo correo) quedo en el outbox de mensajeria.
    expect(api.mundo.repo.getOutbox().filter((o) => o.channel === "email")).not.toHaveLength(0);

    // Conversaciones de voz cerradas con resultado, pedido, costo y latencia.
    const lista = await api.voz.listConversaciones(api.mundo.organizationId, api.mundo.propertyId, {});
    expect(lista.valor.items).toHaveLength(2);
    for (const c of lista.valor.items) {
      expect(c).toMatchObject({ resultado: "pedido_creado", canal: "llamada" });
      expect(c.endedAt).not.toBeNull();
      expect(c.orderId).not.toBeNull();
      expect(c.costoEstimadoMicroUsd).toBeGreaterThan(0);
    }
    expect(new Set(lista.valor.items.map((c) => c.orderId)).size).toBe(2);

    // Costo por escalon en `core.usage_cost_event` (via la API, calculado en el servidor desde los tramos).
    expect(api.llamadaRepo.eventos.map((e) => [e.proveedor, e.categoria, e.refTipo])).toEqual([
      ["gemini-3.8-live", "voz", "voz_restaurantes"],
      ["gemini-3.8-live", "voz", "voz_restaurantes"],
    ]);
    expect(api.llamadaRepo.eventos[0]?.refId).toBe("llamada-A:gemini-3.8-live");

    // Modo de entrada y franja de cada llamada (sin desvio en la linea: el modo configurado, `total`).
    expect([...api.llamadaRepo.modos.values()].map((m) => m.modo)).toEqual(["total", "total"]);

    // Latencia de voz a voz medida por respuesta (4 turnos con voz del cliente por llamada), por debajo del objetivo de 1.5 s.
    const latencias = api.kpi.eventos.filter((e) => e.tipo === "latencia_voz");
    expect(latencias).toHaveLength(8);
    for (const e of latencias) {
      expect(e.latenciaMs).toBeGreaterThanOrEqual(500);
      expect(e.latenciaMs).toBeLessThan(1500);
    }
    const resumen = t.worker.resumenes.at(-1);
    expect(resumen).toMatchObject({ resultado: "pedido_creado", modoEntrada: "total" });
    expect(resumen?.latenciasMs).toHaveLength(4);
  });

  it("la API vio el flujo esperado: token de llamada, aviso de privacidad, consentimiento, herramientas con token y cierre", async () => {
    const t = await armar({ agente: () => new AgenteGuionado([]) });
    await t.llamar("llamada-C", false);
    const rutas = t.api.peticiones;
    const orden = [
      "POST /internal/restaurantes/voz/llamada/contexto",
      "POST /internal/restaurantes/voz/conversaciones",
      "POST /internal/restaurantes/voz/privacidad/apertura",
      "POST /v1/restaurantes/los-taquitos-de-pm/voice/call-token",
      "POST /v1/restaurantes/los-taquitos-de-pm/orders/quote",
      "POST /v1/restaurantes/los-taquitos-de-pm/orders/confirm",
      "POST /v1/restaurantes/los-taquitos-de-pm/orders",
    ];
    let desde = 0;
    for (const r of orden) {
      const i = rutas.indexOf(r, desde);
      expect(i, r).toBeGreaterThanOrEqual(desde);
      desde = i;
    }
    expect(rutas.filter((r) => r.includes("/consentimiento-grabacion"))).toHaveLength(1);
    expect(rutas.filter((r) => r.endsWith("/cerrar"))).toHaveLength(1);
    // El aviso de privacidad se le pide al agente tal cual (asistente virtual, IA) y la grabacion quedo otorgada.
    const trigger = t.worker.resumenes.length; // la llamada ya termino
    expect(trigger).toBe(1);
    expect([...t.api.privacidad.consents.values()]).toEqual(["otorgado"]);
    const conv = (await t.api.voz.listConversaciones(t.api.mundo.organizationId, t.api.mundo.propertyId, {})).valor.items[0]!;
    const detalle = await t.api.voz.getConversacion(t.api.mundo.organizationId, t.api.mundo.propertyId, conv.id);
    const turnos = detalle.valor?.turnos ?? [];
    expect(turnos.map((x) => x.rol)).toContain("cliente");
    expect(turnos.map((x) => x.rol)).toContain("agente");
    expect(turnos.map((x) => x.rol)).toContain("herramienta");
    // El costo total de la llamada quedo en el ultimo turno (el unico que lo lleva).
    expect(turnos.filter((x) => x.costoEstimadoMicroUsd > 0)).toHaveLength(1);
    expect(turnos.at(-1)?.costoEstimadoMicroUsd).toBe(conv.costoEstimadoMicroUsd);
  });

  it("repetir la MISMA llamada (mismo call_id) no crea un segundo pedido ni duplica comanda, conversacion ni costo", async () => {
    const t = await armar({ agente: () => new AgenteGuionado([]) });
    await t.llamar("llamada-D", false);
    expect(await t.api.mundo.pedidos()).toHaveLength(1);
    // La telefonia reentrega la sala (mismo nombre): el worker atiende otra vez la misma llamada.
    await t.llamar("llamada-D", false);
    expect(await t.api.mundo.pedidos()).toHaveLength(1);
    expect(t.api.srStore.todas()).toHaveLength(1);
    expect((await t.api.voz.listConversaciones(t.api.mundo.organizationId, t.api.mundo.propertyId, {})).valor.items).toHaveLength(1);
    expect(t.api.llamadaRepo.eventos).toHaveLength(1);
  });

  it("los logs de la llamada no llevan PII: ni telefono, ni nombre, ni direccion, ni correo, ni lo que dijo el cliente", async () => {
    const lineas: string[] = [];
    const t = await armar({ agente: () => new AgenteGuionado([]), log: ({ evento, campos }) => void lineas.push(JSON.stringify({ evento, ...campos })) });
    await t.llamar("llamada-E", false);
    expect(lineas.length).toBeGreaterThan(5);
    // Los UUID de organizacion y sucursal son aleatorios y pueden contener "412" por azar: no son el numero de la direccion.
    const todo = lineas.join("\n").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
    for (const sensible of [TELEFONO, "Ana Pech", "calle sesenta", "Calle 63", "412", "ana@ejemplo.invalid", "autorizo", "bistec", SIP_DESDE]) expect(todo, sensible).not.toContain(sensible);
    // La llamada se correlaciona por una referencia opaca (hash), nunca por el id de la sala ni del proveedor.
    expect(todo).not.toContain("llamada-E");
    expect(lineas.some((l) => /"callRef":"[0-9a-f]{12}"/.test(l))).toBe(true);
  });
});
