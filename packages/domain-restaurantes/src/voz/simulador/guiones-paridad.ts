// Suite de PARIDAD de voz con WhatsApp: llamadas completas (proveedor FALSO guionado, sin red ni costo) que ejercitan las mismas reglas de pedido que los
// escenarios de WhatsApp: horario cerrado, ultimo pedido (30 min antes del cierre), hora exacta de recogida, pedido programado, packs de N piezas, direccion
// faltante, pago invalido, cambio de producto, cancelacion, silencio y paso a una persona. Cada escenario trae su RELOJ y, si hace falta, su HORARIO: las reglas
// de horario viven en el servidor y aplican igual a `source: voice`, de modo que lo que se mide aqui es lo que el cliente oiria por telefono.
// Menu, importes y nombres son inventados para el arnes.
import { correrGuionConAdaptador } from "@atiende/voice-core/simulador";
import { LIMITES_VOZ_PM } from "../llamada/maquina.ts";
import type { HorarioSucursal } from "../../types.ts";
import { ADAPTADOR_SIMULADOR_PM } from "./correr-guion.ts";
import { BRANCH_SLUG_PRINCIPAL, crearMundoVoz } from "./mundo-voz.ts";
import type { MundoVoz } from "./mundo-voz.ts";
import type { GuionLlamada, LlamadaSimulada, MemoriaTools, PasoAgente } from "./tipos.ts";

const SUC = BRANCH_SLUG_PRINCIPAL;
const ZONA = "America/Merida";
/** Horario de las sucursales de PM de noche: 12:00 a 01:00 todos los dias (ultimo pedido 00:30). */
export const HORARIO_PM: HorarioSucursal = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }];

export interface EscenarioVoz {
  readonly guion: GuionLlamada;
  /** Instante de la llamada (ISO con -06:00): el servidor usa su reloj para horario, ultimo pedido y plazos. */
  readonly ahora: string;
  readonly horario?: HorarioSucursal;
}

const buscar = (query: string): PasoAgente => ({ tool: "buscar_producto", args: { query, branch_slug: SUC } });
const linea = (m: MemoriaTools, frag: string, piezas: number, tortilla?: "maiz" | "harina") => {
  const p = m.producto(frag);
  return { product_id: p.id, product_name: p.name, requested_quantity: piezas, ...(tortilla ? { tortilla } : {}) };
};
type Lineas = (m: MemoriaTools) => unknown[];
const cotizar = (items: Lineas, extra: Record<string, unknown> = {}): PasoAgente => ({ tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, items: items(m), canal: "recoger", ...extra }) });
const confirmar: PasoAgente = { tool: "confirmar_resumen", args: (m) => ({ quote_hash: m.quoteHash() }) };
const crear = (items: Lineas, extra: Record<string, unknown> = {}): PasoAgente => ({
  tool: "crear_pedido",
  args: (m) => ({ branch_slug: SUC, customer_name: "Ana Pech", items: items(m), payment_method: "efectivo", canal: "recoger", ...extra }),
});
const dice = (texto: string): PasoAgente => ({ dice: texto });
const consultar: PasoAgente = { tool: "consultar_sucursal", args: { branch_slug: SUC } };

const pastor3: Lineas = (m) => [linea(m, "pastor", 3, "maiz")];
const bistec3: Lineas = (m) => [linea(m, "bistec", 3, "maiz")];
const MIERCOLES_12 = "2026-10-07T12:00:00-06:00";
const PEDIDO_PASTOR_RECOGER = (total: number) => ({ sucursal: "Francisco de Montejo", canal: "recoger" as const, pago: "efectivo" as const, total, items: [{ nombre: "Tacos al Pastor (orden de 3)", cantidad: 1 }] });

export const ESCENARIOS_PARIDAD: readonly EscenarioVoz[] = [
  {
    ahora: "2026-10-07T08:00:00-06:00",
    horario: HORARIO_PM,
    guion: {
      id: "P01-sucursal-cerrada-a-las-8",
      titulo: "A las 8:00 la sucursal esta cerrada (abre 12:00): cotizar se rechaza con la hora de apertura y no nace ningun pedido",
      rasgos: ["horario cerrado", "hora de apertura", "paridad con WhatsApp"],
      turnos: [
        { kind: "voz", cliente: "Buenos días, tres tacos de pastor para recoger ahorita", agente: [buscar("pastor"), cotizar(pastor3), dice("Disculpe, la sucursal está cerrada en este momento y abre hoy a las doce del día. ¿Desea que se lo deje programado?")] },
        { kind: "voz", cliente: "No, gracias, llamo más tarde", agente: [dice("Con gusto. Gracias por llamar.")] },
      ],
      esperado: { resultado: "abandonado", sinPedido: true, herramientasRechazadas: [{ nombre: "cotizar_pedido", error: /cerrada en este momento; abre hoy a las 12:00/ }] },
    },
  },
  {
    ahora: "2026-10-07T08:00:00-06:00",
    horario: HORARIO_PM,
    guion: {
      id: "P02-programado-para-la-apertura",
      titulo: "A las 8:00 pide el pedido para la apertura: se programa a las 12:30 con programado_para (misma hora en cotizar y crear)",
      rasgos: ["pedido programado", "H16", "paridad con WhatsApp"],
      turnos: [
        { kind: "voz", cliente: "Buenos días, tres tacos de pastor para recoger hoy a las doce y media", agente: [buscar("pastor"), cotizar(pastor3, { programado_para: "2026-10-07T12:30:00-06:00" }), dice("Son tres tacos al pastor, ciento veinte pesos, para recoger hoy a las doce y media. ¿Es correcto?")] },
        { kind: "voz", cliente: "Sí, a nombre de Ana Pech, en efectivo", agente: [confirmar, crear(pastor3, { programado_para: "2026-10-07T12:30:00-06:00" }), dice("Listo, su pedido quedó programado para las doce y media. Gracias por llamar.")] },
      ],
      esperado: { resultado: "pedido_creado", pedido: PEDIDO_PASTOR_RECOGER(120) },
    },
  },
  {
    ahora: "2026-10-08T00:40:00-06:00",
    horario: HORARIO_PM,
    guion: {
      id: "P03-ultimo-pedido-pasado-a-las-0040",
      titulo: "A las 00:40 (cierre 01:00) ya paso el ultimo pedido (00:30): cotizar se rechaza con el margen y la hora, sin prometer horas fuera de horario",
      rasgos: ["ultimo pedido", "sucursal abierta pero sin pedidos", "paridad con WhatsApp"],
      turnos: [
        { kind: "voz", cliente: "Buenas noches, tres tacos de pastor para recoger", agente: [consultar, buscar("pastor"), cotizar(pastor3), dice("Disculpe, ya pasó el último pedido de hoy, se toma treinta minutos antes del cierre. Si gusta puede pedir mañana desde las doce del día.")] },
        { kind: "voz", cliente: "Ah, está bien, gracias", agente: [dice("Gracias por llamar, buenas noches.")] },
      ],
      esperado: { resultado: "abandonado", sinPedido: true, herramientasRechazadas: [{ nombre: "cotizar_pedido", error: /ya no toma pedidos para hoy por el cierre próximo.*30 minutos antes del cierre \(hasta las 00:30\)/ }] },
    },
  },
  {
    ahora: "2026-10-08T00:10:00-06:00",
    horario: HORARIO_PM,
    guion: {
      id: "P04-hora-de-recogida-despues-del-ultimo-pedido",
      titulo: "A las 00:10 pide recoger a las 00:50 (despues del ultimo pedido 00:30): se rechaza la hora y se acepta una hora anterior",
      rasgos: ["ultimo pedido", "hora exacta de recogida", "reintento corregido"],
      turnos: [
        { kind: "voz", cliente: "Tres tacos de pastor para recoger a las doce cincuenta de la noche", agente: [buscar("pastor"), cotizar(pastor3, { hora_recogida: "2026-10-08T00:50:00-06:00" }), cotizar(pastor3, { hora_recogida: "2026-10-08T00:25:00-06:00" }), dice("A esa hora ya no se toman pedidos; el último es a las doce y media. Puede pasar a las doce y veinticinco. ¿Le parece?")] },
        { kind: "voz", cliente: "Sí, a nombre de Ana Pech, en efectivo", agente: [confirmar, crear(pastor3, { hora_recogida: "2026-10-08T00:25:00-06:00" }), dice("Listo, lo esperamos a las doce y veinticinco. Gracias por llamar.")] },
      ],
      esperado: { resultado: "pedido_creado", herramientasRechazadas: [{ nombre: "cotizar_pedido", error: /para la hora elegida.*hasta las 00:30/ }], pedido: PEDIDO_PASTOR_RECOGER(120) },
    },
  },
  {
    ahora: MIERCOLES_12,
    horario: HORARIO_PM,
    guion: {
      id: "P05-hora-exacta-de-recogida",
      titulo: "'Paso a la una y media': hora exacta en hora_recogida, la misma en cotizar y crear",
      rasgos: ["hora exacta de recogida", "hora_recogida ISO -06:00"],
      turnos: [
        { kind: "voz", cliente: "Tres tacos de pastor de maíz para recoger a la una y media", agente: [buscar("pastor"), cotizar(pastor3, { hora_recogida: "2026-10-07T13:30:00-06:00" }), dice("Son ciento veinte pesos, para recoger a la una y media. ¿Es correcto?")] },
        { kind: "voz", cliente: "Sí, a nombre de Ana Pech, en efectivo", agente: [confirmar, crear(pastor3, { hora_recogida: "2026-10-07T13:30:00-06:00" }), dice("Listo, lo esperamos a la una y media. Gracias.")] },
      ],
      esperado: { resultado: "pedido_creado", pedido: PEDIDO_PASTOR_RECOGER(120) },
    },
  },
  {
    ahora: MIERCOLES_12,
    horario: HORARIO_PM,
    guion: {
      id: "P06-cancelar-pasa-a-una-persona",
      titulo: "'Quiero cancelar mi pedido': no hay herramienta de cancelar; el agente escala con el motivo cancelacion_modificacion y no se crea nada",
      rasgos: ["cancelar", "handoff por motivo"],
      turnos: [
        { kind: "voz", cliente: "Buenas tardes, quiero cancelar el pedido que hice hace rato", agente: [{ tool: "escalar_a_humano", args: { customer_name: "Ana Pech", motivo: "cancelacion_modificacion", resumen: "El cliente quiere cancelar su pedido de hace un rato." } }, dice("Permítame avisar al gerente; una persona le confirmará la cancelación.")] },
      ],
      esperado: { resultado: "escalado", sinPedido: true, callbacks: ["escalada:cancelacion_modificacion"] },
    },
  },
  {
    ahora: MIERCOLES_12,
    horario: HORARIO_PM,
    guion: {
      id: "P07-cambia-de-producto-tras-el-resumen",
      titulo: "Despues del resumen cambia bistec por pastor: se vuelve a cotizar y confirmar; el hash viejo ya no sirve y el pedido sale con el producto nuevo",
      rasgos: ["cambio de producto", "resumen vigente", "quote_hash"],
      turnos: [
        { kind: "voz", cliente: "Una orden de tacos de bistec de maíz para recoger", agente: [buscar("bistec"), cotizar(bistec3), dice("Son tres tacos de bistec, ciento sesenta y cuatro pesos. ¿Es correcto?")] },
        { kind: "voz", cliente: "Espere, mejor de pastor", agente: [buscar("pastor"), cotizar(pastor3), dice("Sin problema: tres tacos al pastor, ciento veinte pesos. ¿Es correcto?")] },
        { kind: "voz", cliente: "Sí, a nombre de Ana Pech, en efectivo", agente: [confirmar, crear(pastor3), dice("Listo, su pedido quedó registrado. Gracias.")] },
      ],
      esperado: { resultado: "pedido_creado", pedido: PEDIDO_PASTOR_RECOGER(120) },
    },
  },
  {
    ahora: MIERCOLES_12,
    horario: HORARIO_PM,
    guion: {
      id: "P08-cuatro-tacos-no-es-multiplo-de-tres",
      titulo: "'Cuatro tacos de bistec': el servidor rechaza la cantidad (orden de 3) y el agente ofrece una orden de tres",
      rasgos: ["pack_size", "cantidad no multiplo", "paridad con WhatsApp"],
      turnos: [
        { kind: "voz", cliente: "Cuatro tacos de bistec de maíz para recoger", agente: [buscar("bistec"), cotizar((m) => [linea(m, "bistec", 4, "maiz")]), cotizar(bistec3), dice("Los tacos de bistec van en órdenes de tres; una orden son ciento sesenta y cuatro pesos. ¿Le parece?")] },
        { kind: "voz", cliente: "Sí, una orden, a nombre de Ana Pech, en efectivo", agente: [confirmar, crear(bistec3), dice("Listo, su pedido quedó registrado. Gracias.")] },
      ],
      esperado: { resultado: "pedido_creado", herramientasRechazadas: [{ nombre: "cotizar_pedido", error: /orden|m[uú]ltiplo|3/i }], pedido: { sucursal: "Francisco de Montejo", canal: "recoger", pago: "efectivo", total: 164, items: [{ nombre: "Tacos de Bistec de Res (orden de 3)", cantidad: 1 }] } },
    },
  },
  {
    ahora: MIERCOLES_12,
    horario: HORARIO_PM,
    guion: {
      id: "P09-domicilio-sin-direccion-no-se-crea",
      titulo: "A domicilio sin direccion escrita: crear_pedido se rechaza y el pedido se crea solo cuando el cliente la da",
      rasgos: ["direccion", "domicilio", "dato indispensable"],
      sensibles: ["Calle 63", "412"],
      turnos: [
        { kind: "voz", cliente: "Seis tacos de pastor a domicilio por el Centro, de maíz", agente: [buscar("pastor"), cotizar((m) => [linea(m, "pastor", 6, "maiz")], { canal: "domicilio", colonia_entrega: "Centro" }), dice("Son seis tacos al pastor, doscientos cuarenta pesos. ¿Es correcto?")] },
        { kind: "voz", cliente: "Sí, a nombre de Ana Pech, en efectivo", agente: [confirmar, crear((m) => [linea(m, "pastor", 6, "maiz")], { canal: "domicilio", colonia_entrega: "Centro" }), dice("Me falta su dirección completa: calle, número y entre qué calles.")] },
        { kind: "voz", cliente: "Calle sesenta y tres número cuatrocientos doce por cuarenta y cinco y cuarenta y siete", agente: [crear((m) => [linea(m, "pastor", 6, "maiz")], { canal: "domicilio", colonia_entrega: "Centro", customer_address: "Calle 63 número 412 por 45 y 47, colonia Centro" }), dice("Listo, su pedido quedó registrado. Gracias.")] },
      ],
      esperado: {
        resultado: "pedido_creado",
        herramientasRechazadas: [{ nombre: "crear_pedido", error: /direcci[oó]n/i }],
        pedido: { sucursal: "Francisco de Montejo", canal: "domicilio", pago: "efectivo", total: 240, items: [{ nombre: "Tacos al Pastor (orden de 3)", cantidad: 2 }], direccionIncluye: ["412"] },
      },
    },
  },
  {
    ahora: MIERCOLES_12,
    horario: HORARIO_PM,
    guion: {
      id: "P10-pago-invalido-y-luego-tarjeta",
      titulo: "'Pago por transferencia': no es una forma de pago valida; el agente ofrece efectivo o tarjeta y el pedido sale con tarjeta",
      rasgos: ["forma de pago", "pago invalido"],
      turnos: [
        { kind: "voz", cliente: "Tres tacos de pastor de maíz para recoger", agente: [buscar("pastor"), cotizar(pastor3), dice("Son ciento veinte pesos. ¿Es correcto?")] },
        { kind: "voz", cliente: "Sí, a nombre de Ana Pech, pago por transferencia", agente: [confirmar, crear(pastor3, { payment_method: "transferencia" }), dice("Por teléfono solo manejamos efectivo o tarjeta en la sucursal. ¿Cuál prefiere?")] },
        { kind: "voz", cliente: "Entonces con tarjeta", agente: [crear(pastor3, { payment_method: "tarjeta" }), dice("Listo, su pedido quedó registrado; pagará con tarjeta en la sucursal. Gracias.")] },
      ],
      esperado: { resultado: "pedido_creado", herramientasRechazadas: [{ nombre: "crear_pedido", error: /pago|payment/i }], pedido: { sucursal: "Francisco de Montejo", canal: "recoger", pago: "tarjeta", total: 120, items: [{ nombre: "Tacos al Pastor (orden de 3)", cantidad: 1 }] } },
    },
  },
  {
    ahora: MIERCOLES_12,
    horario: HORARIO_PM,
    guion: {
      id: "P11-silencio-con-el-pedido-cotizado",
      titulo: "Cotiza y el cliente se queda callado: un solo '¿sigue ahi?', despedida y ningun pedido sin su si",
      rasgos: ["silencio", "pedido cotizado sin confirmar"],
      turnos: [
        { kind: "voz", cliente: "Tres tacos de pastor de maíz para recoger", agente: [buscar("pastor"), cotizar(pastor3), dice("Son ciento veinte pesos. ¿Es correcto?")] },
        { kind: "silencio", ms: 7500 },
        { kind: "silencio", ms: 7500 },
      ],
      esperado: { resultado: "abandonado", sinPedido: true, pregrabados: ["silencio_reprompt", "silencio_despedida"] },
    },
  },
  {
    ahora: MIERCOLES_12,
    horario: HORARIO_PM,
    guion: {
      id: "P12-interrumpe-al-pedir-la-direccion",
      titulo: "El cliente interrumpe al agente mientras lee la hora de recogida y corrige: se corta el audio y se usa lo ultimo que dijo",
      rasgos: ["interrupcion", "barge-in", "correccion de hora"],
      turnos: [
        { kind: "voz", cliente: "Tres tacos de pastor de maíz para recoger a la una", agente: [buscar("pastor"), cotizar(pastor3, { hora_recogida: "2026-10-07T13:00:00-06:00" }), { dice: "Son tres tacos al pastor, ciento veinte pesos, para recoger hoy a la una de la tarde en la sucursal de Francisco de Montejo, pagando en caja, ¿es correcto?", largo: true } as PasoAgente] },
        { kind: "voz", cliente: "No, mejor a la una y media", interrumpe: true, agente: [cotizar(pastor3, { hora_recogida: "2026-10-07T13:30:00-06:00" }), dice("Entendido, a la una y media. Son ciento veinte pesos. ¿Es correcto?")] },
        { kind: "voz", cliente: "Sí, a nombre de Ana Pech, en efectivo", agente: [confirmar, crear(pastor3, { hora_recogida: "2026-10-07T13:30:00-06:00" }), dice("Listo, lo esperamos a la una y media. Gracias.")] },
      ],
      esperado: { resultado: "pedido_creado", audioCortadoMin: 1, pedido: PEDIDO_PASTOR_RECOGER(120) },
    },
  },
  {
    ahora: MIERCOLES_12,
    horario: HORARIO_PM,
    guion: {
      id: "P13-gerente-con-pedido-ya-registrado",
      titulo: "Con el pedido ya registrado el cliente pide hablar con el gerente: la guardia escala (la llamada cierra `escalado`, decision vigente: una guardia pesa mas que un cierre exitoso) y el pedido existente no se duplica",
      rasgos: ["transferencia a humano", "pedido ya creado"],
      turnos: [
        { kind: "voz", cliente: "Tres tacos de pastor de maíz para recoger", agente: [buscar("pastor"), cotizar(pastor3), dice("Son ciento veinte pesos. ¿Es correcto?")] },
        { kind: "voz", cliente: "Sí, a nombre de Ana Pech, en efectivo", agente: [confirmar, crear(pastor3), dice("Listo, su pedido quedó registrado. ¿Algo más?")] },
        { kind: "voz", cliente: "Sí, páseme con el gerente por favor", agente: [] },
      ],
      esperado: { resultado: "escalado", pedido: PEDIDO_PASTOR_RECOGER(120), callbacks: ["escalada:cliente_lo_pide"] },
    },
  },
];

/** Telemetria de un turno del cliente: herramientas que corrio el agente y tiempo REAL de servidor (en proceso) que gastaron. */
export interface TurnoMedido {
  readonly turno: number;
  readonly herramientas: number;
  readonly servidorMs: number;
}
export interface CorridaMedida {
  readonly llamada: LlamadaSimulada;
  readonly turnos: readonly TurnoMedido[];
}

/** Corre un escenario con su horario y mide el servidor por turno. El llamador fija el reloj (`vi.setSystemTime(new Date(esc.ahora))`). */
export async function correrEscenario(esc: EscenarioVoz): Promise<CorridaMedida> {
  const porTurno = new Map<number, { herramientas: number; servidorMs: number }>();
  const adaptador = {
    ...ADAPTADOR_SIMULADOR_PM,
    crearMundo: (): MundoVoz => {
      const mundo = crearMundoVoz();
      if (esc.horario) {
        // seedBranchPolicy REEMPLAZA la politica: se repite el minimo de $200 del mundo base.
        mundo.repo.seedBranchPolicy(mundo.propertyId, { pedidoMinimoDomicilio: 200, horario: esc.horario });
        void mundo.repo.upsertBranchZonaHoraria(mundo.propertyId, ZONA);
      }
      return mundo;
    },
    transporte: (mundo: MundoVoz, ctx: { readonly callId: string; readonly telefono: string | null }) => {
      const base = ADAPTADOR_SIMULADOR_PM.transporte(mundo, ctx);
      return async (nombre: string, args: Readonly<Record<string, unknown>>, senal: AbortSignal, contexto?: { readonly turno: number | null }) => {
        const t0 = performance.now();
        try {
          return await base(nombre, args, senal, contexto as never);
        } finally {
          const k = contexto?.turno ?? -1;
          const acc = porTurno.get(k) ?? { herramientas: 0, servidorMs: 0 };
          acc.herramientas += 1;
          acc.servidorMs += performance.now() - t0;
          porTurno.set(k, acc);
        }
      };
    },
  };
  const guion = { ...esc.guion, limites: { silenciosMax: LIMITES_VOZ_PM.silenciosMax, ...esc.guion.limites } };
  const llamada = await correrGuionConAdaptador(adaptador, guion);
  const turnos = [...porTurno.entries()].sort((a, b) => a[0] - b[0]).map(([turno, v]) => ({ turno, ...v }));
  return { llamada, turnos };
}
