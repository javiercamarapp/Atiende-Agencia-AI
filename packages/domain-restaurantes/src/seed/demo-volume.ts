// R-20 -- seed de VOLUMEN de la cuenta demo: pedidos historicos, clientes, conversaciones, handoffs y contactos coherentes por
// sucursal (T1, T2, T3, T7, T8; T4 inactiva no recibe nada) en America/Merida.
//
// Los pedidos NO son INSERT inventados: cada uno pasa por `prepareCreateOrder`, el motor REAL de pedidos (resolucion de
// productos contra el catalogo de la sucursal, tortilla, multiplos de "orden de N", alcohol solo al recoger, pedido minimo,
// propina solo con tarjeta, horario de la sucursal y promocion automatica 2x1 del lunes), evaluado "como de" el instante
// historico (`asOf`). Los totales salen de ahi; este modulo solo decide QUE pide cada cliente y CUANDO.
//
// Garantias:
//   * Determinista: misma semilla y mismas opciones -> mismas filas (idempotencia: el SQL deduplica por clave de idempotencia).
//   * Sin PII real: telefonos del rango RESERVADO `0001xxxxxx` (lada 000: no existe), nombres compuestos ficticios, direcciones
//     genericas, sin correos. La limpieza (`restaurantes.demo_limpiar`, migracion 037) borra por ese rango.
//   * Sin canal de voz: la voz de la demo esta deshabilitada, asi que no hay pedidos "por voz" que la contradigan.
//   * Las proporciones por sucursal y canal son ILUSTRATIVAS (no son los volumenes reales del cliente).
import { createHash } from "node:crypto";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { OrderValidationError, PromotionError } from "../errors.ts";
import { fechaLocal } from "../horarios.ts";
import { prepareCreateOrder } from "../orders.ts";
import { buildComplementNotes } from "../order-quote.ts";
import type { RestaurantesRepository } from "../repository.ts";
import type { ConversationMessage } from "../repository.ts";
import type { CanalPedido, OrderStatus, PersistedOrderItem } from "../types.ts";
import { DEMO_PHONE_PREFIX_VOLUME, demoPhone } from "../demo/types.ts";

/**
 * Perfiles de volumen. `t7` reproduce el ritmo REAL medido en el WhatsApp de la sucursal T7 Garcia Lavin (muestra anonimizada de
 * 104 chats, 7-ago a 1-oct-2026; `docs/demo-pm/guion.md`): SOLO T7, 139 pedidos en 8 semanas (56 dias), 70 clientes de los cuales 32
 * son recurrentes y suman 101 de los 139 pedidos (73 %), 79 % a domicilio, todo por WhatsApp, pago casi mitad y mitad, tickets
 * con mediana ~$640 (p90 ~$1,500), tiempos de entrega de 50 a 90 min (mediana 65) y de 10 a 50 min para recoger, picos de
 * 12-16 h y de 19-22 h con fin de semana mas fuerte. Las cifras son las de la sucursal real; los clientes, direcciones y
 * telefonos son ficticios (rango 0001).
 */
export type DemoVolumeProfile = "t7";

export const DEMO_PERFIL_T7 = {
  sucursal: "garcia-lavin",
  /** Ventana de la muestra real (8 semanas). */
  dias: 56,
  pedidos: 139,
  pedidosRecurrentes: 101,
  clientesRecurrentes: 32,
  /** Pedido mas repetido por un solo cliente en la muestra. */
  maxPedidosUnCliente: 11,
  fraccionDomicilio: 0.79,
  fraccionTarjeta: 0.46,
} as const;

export interface DemoVolumeScale {
  readonly dias: number;
  readonly pedidosPorDia: number;
}

/** Escalas predefinidas. `completo` es la opcion de ~90k pedidos (90 dias x ~1000); NO es la que se usa por omision. */
export const DEMO_VOLUME_SCALES: Readonly<Record<"ligero" | "moderado" | "completo", DemoVolumeScale>> = {
  ligero: { dias: 30, pedidosPorDia: 12 },
  moderado: { dias: 90, pedidosPorDia: 24 },
  completo: { dias: 90, pedidosPorDia: 1000 },
};

export interface DemoVolumeOptions {
  readonly organizationId: string;
  /** Semilla del generador pseudoaleatorio (determinista). */
  readonly seed?: number;
  readonly dias: number;
  /** Promedio de pedidos por dia entre TODAS las sucursales activas (los fines de semana suben). Con `perfil` se ignora: el total
   * sale del perfil (escalado por `dias`). */
  readonly pedidosPorDia?: number;
  /** Perfil de ritmo real (ver `DemoVolumeProfile`). Sin perfil, el volumen es el generico ilustrativo de siempre. */
  readonly perfil?: DemoVolumeProfile;
  /** "Ahora": el ultimo dia generado es AYER (en la zona del negocio). Inyectable para pruebas. */
  readonly ahora?: Date;
}

export interface DemoCustomerRow {
  readonly phone: string;
  readonly name: string;
  readonly address: string;
  readonly firstOrderAt: string;
}

export interface DemoOrderRow {
  /** sha256 hex de la clave logica: unica por (organizacion, pedido) -> el SQL es idempotente. */
  readonly idempotencyKey: string;
  readonly branchSlug: string;
  readonly branchName: string;
  readonly customerPhone: string;
  readonly customerName: string;
  readonly address: string | null;
  readonly items: readonly PersistedOrderItem[];
  readonly total: number;
  readonly status: OrderStatus;
  readonly source: "web" | "whatsapp" | "admin";
  readonly paymentMethod: "efectivo" | "tarjeta";
  readonly canal: CanalPedido;
  readonly propina: number | null;
  readonly notes: string;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

export interface DemoConversationRow {
  readonly phone: string;
  readonly branchSlug: string;
  readonly messages: readonly ConversationMessage[];
  readonly status: "active" | "completed" | "abandoned";
  /** Clave de idempotencia del pedido ligado (null = conversacion sin pedido). */
  readonly orderKey: string | null;
  readonly updatedAt: string;
}

export interface DemoHandoffRow {
  readonly phone: string;
  readonly branchSlug: string;
  readonly estado: "pendiente" | "cerrada";
  readonly motivo: string;
  readonly solicitadaAt: string;
  readonly cerradaAt: string | null;
}

export interface DemoCallbackRow {
  readonly phone: string;
  readonly name: string;
  readonly branchSlug: string;
  readonly reason: string;
  readonly message: string;
  readonly resolved: boolean;
  readonly createdAt: string;
}

export interface DemoVolumeBatch {
  readonly customers: readonly DemoCustomerRow[];
  readonly orders: readonly DemoOrderRow[];
  readonly conversations: readonly DemoConversationRow[];
  readonly handoffs: readonly DemoHandoffRow[];
  readonly callbacks: readonly DemoCallbackRow[];
}

export interface DemoVolumeSummary {
  readonly orders: number;
  readonly customers: number;
  readonly omitidos: number;
  readonly porSucursal: Readonly<Record<string, number>>;
  readonly desde: string;
  readonly hasta: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Aleatoriedad determinista
// ---------------------------------------------------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    const total = items.reduce((s, i) => s + weight(i), 0);
    let r = this.next() * total;
    for (const item of items) {
      r -= weight(item);
      if (r < 0) return item;
    }
    return items[items.length - 1]!;
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------------------------------------------------
// Fechas en la zona del negocio
// ---------------------------------------------------------------------------------------------------------------------
function offsetMs(zone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(utcMs / 1000) * 1000;
}

/** Hora de pared de `zone` -> instante UTC (dos pasadas: absorbe cambios de horario de verano). */
export function localToUtc(zone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(zone, guess);
  return new Date(guess - offsetMs(zone, first));
}

function addDays(fecha: string, days: number): { year: number; month: number; day: number; iso: string; weekday: number } {
  const t = new Date(Date.parse(`${fecha}T00:00:00Z`) + days * 86_400_000);
  const iso = t.toISOString().slice(0, 10);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), iso, weekday: t.getUTCDay() };
}

// Distribucion por hora local (12..23 y 0 = pasada la medianoche). Fines de semana: picos 13-16 y 18-22.
const HORAS = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0] as const;
const PESO_HORA_SEMANA = [4, 10, 12, 8, 5, 5, 10, 12, 12, 9, 6, 4, 1];
const PESO_HORA_FIN_DE_SEMANA = [3, 13, 15, 11, 6, 5, 11, 14, 14, 11, 6, 3, 1];

// ---------------------------------------------------------------------------------------------------------------------
// Catalogos ficticios
// ---------------------------------------------------------------------------------------------------------------------
const NOMBRES = ["Ana", "Luis", "María", "Carlos", "Sofía", "Jorge", "Lucía", "Miguel", "Daniela", "Pedro", "Valeria", "Raúl", "Fernanda", "Diego", "Paola", "Andrés", "Claudia", "Héctor", "Mariana", "Iván", "Gabriela", "Ricardo", "Elena", "Omar", "Karla", "Sergio", "Natalia", "Tomás", "Renata", "Julián"];
const APELLIDOS = ["Demo", "Ficticio", "Prueba", "Muestra", "Ejemplo"];
const COLONIAS_POR_SUCURSAL: Readonly<Record<string, readonly string[]>> = {
  "prol-montejo": ["Emiliano Zapata Norte", "García Ginerés", "Itzimná", "Centro", "Jesús Carranza"],
  "fco-montejo": ["Francisco de Montejo", "Residencial Pensiones", "Montes de Amé", "Real Montejo", "Mulsay"],
  pensiones: ["San Damián", "Pensiones", "Reparto Granjas", "San Ramón Norte", "Chuburná"],
  "garcia-lavin": ["Xaman Tan", "Montecristo", "Altabrisa", "Santa Gertrudis Copó", "Cumbres de Montejo"],
  altabrisa: ["Vista Alegre", "Altabrisa", "Cholul", "Los Pinos", "Las Américas"],
};
const COLONIAS_POR_OMISION = ["Centro", "Itzimná", "Altabrisa", "Montebello", "Pensiones"];

/** Proporcion ilustrativa del volumen por sucursal (no son los volumenes reales del cliente). */
const PESO_SUCURSAL: Readonly<Record<string, number>> = { "prol-montejo": 0.24, "fco-montejo": 0.13, pensiones: 0.09, "garcia-lavin": 0.3, altabrisa: 0.24 };
/** Proporcion ilustrativa de pedidos para recoger por sucursal. */
const RECOGER_POR_SUCURSAL: Readonly<Record<string, number>> = { "prol-montejo": 0.06, "fco-montejo": 0.42, pensiones: 0.36, "garcia-lavin": 0.3, altabrisa: 0.35 };

interface CatalogItem {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly packSize: number | null;
  readonly noDomicilio: boolean;
  readonly requiresAdult: boolean;
  readonly isTacos: boolean;
  readonly peso: number;
}

interface Cliente {
  readonly phone10: string;
  readonly name: string;
  readonly address: string;
  readonly homeSlug: string;
  firstOrderAt: Date | null;
  /** Ultimo pedido por WhatsApp (base de la conversacion que se guarda: hay una conversacion por telefono). */
  lastWhatsapp: DemoOrderRow | null;
}

const PAQUETE_RE = /\(orden de (\d+)\)/i;

function itemPesoPorNombre(name: string, popular: boolean): number {
  let w = popular ? 4 : 1;
  if (/\btacos?\b/i.test(name)) w *= 3;
  if (/pastor/i.test(name)) w *= 2;
  if (/(refresco|agua|horchata|limonada|coca|jamaica)/i.test(name)) w *= 1.6;
  if (/(cerveza|corona|victoria|modelo|sol\b|heineken)/i.test(name)) w *= 0.5;
  return w;
}

function formatoPesos(n: number): string {
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

function lineaTexto(items: readonly PersistedOrderItem[]): string {
  return items.map((i) => `${i.quantity} ${i.name}${i.tortilla ? ` en tortilla de ${i.tortilla === "maiz" ? "maíz" : i.tortilla}` : ""}`).join(", ");
}

/** Transcripcion sintetica (demo) coherente con el pedido: los renglones y el total son los que calculo el motor real. */
function conversacionDePedido(order: DemoOrderRow, perfil?: DemoVolumeProfile): ConversationMessage[] {
  const donde = order.canal === "recoger" ? `para recoger en ${order.branchName}` : "a domicilio";
  return [
    { role: "user", content: "Hola, quiero hacer un pedido" },
    { role: "assistant", content: `Buenas tardes, gracias por comunicarse a Los Taquitos de PM, sucursal ${order.branchName}. Le atiende el asistente virtual. ¿Será para recoger o a domicilio?` },
    { role: "user", content: `${order.canal === "recoger" ? "Para recoger" : "A domicilio"}. Quiero ${lineaTexto(order.items)}` },
    { role: "assistant", content: `Con gusto. Repito su pedido ${donde}: ${lineaTexto(order.items)}. El total es ${formatoPesos(order.total)}. ¿Pagará en efectivo o con tarjeta y lo confirmo?` },
    { role: "user", content: `Sí, ${order.paymentMethod}` },
    { role: "assistant", content: `Listo, su pedido ya quedó registrado en cocina${order.canal === "domicilio" ? `. Le llegará en aproximadamente ${perfil ? "60 a 75" : "40 a 50"} minutos` : perfil ? ". Estará listo en unos 30 minutos" : ""}. Gracias por su preferencia.` },
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Generador
// ---------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------
// Perfil T7 (ritmo real de la sucursal)
// ---------------------------------------------------------------------------------------------------------------------
const PRIVADAS_T7 = ["Los Almendros", "Las Palmas", "San Fernando", "Cumbres", "Ceiba Real", "Aldea Maya", "Paraíso", "Montecarlo", "El Mirador", "Villas del Sol"];
// Domingo y sabado mandan (dicho por el dueño y visto en la muestra); de lunes a jueves es parejo.
const PESO_DIA_T7 = [3, 0.9, 1.1, 1, 1, 1.4, 2.4] as const; // indice = getUTCDay(): 0 domingo ... 6 sabado
// Sesiones por franja de la muestra: 12-15 h 36 %, 16-18 h 17 %, 19-21 h 39 % (pico 19 h), 22-01 h 4 %.
const PESO_HORA_T7 = [6, 12, 12, 8, 5, 5, 8, 16, 14, 9, 3, 2, 1];

interface SlotT7 {
  readonly hora: number;
  readonly minuto: number;
  readonly cliente: number;
}
interface PlanT7 {
  readonly nClientes: number;
  /** Pedidos por dia (clave = dias atras, 1 = ayer), en cualquier orden: el generador los ordena por hora. */
  readonly slotsPorDia: Map<number, SlotT7[]>;
}

/**
 * Reparte los 139 pedidos del perfil (escalados por `dias`/56) entre clientes y momentos de forma EXACTA: los recurrentes suman
 * `pedidosRecurrentes` pedidos (uno de ellos hace `maxPedidosUnCliente`, el resto 2 o mas) y cada cliente de un solo pedido pide
 * una vez. Despues sortea el dia (peso por dia de la semana) y la hora (peso por franja) de cada pedido.
 */
function planificarPerfilT7(rng: Rng, dias: number, hoy: string): PlanT7 {
  const escala = dias / DEMO_PERFIL_T7.dias;
  const total = Math.max(4, Math.round(DEMO_PERFIL_T7.pedidos * escala));
  const pedidosRec = Math.min(total - 1, Math.max(4, Math.round((total * DEMO_PERFIL_T7.pedidosRecurrentes) / DEMO_PERFIL_T7.pedidos)));
  const nRec = Math.max(2, Math.min(Math.floor(pedidosRec / 2), Math.round(DEMO_PERFIL_T7.clientesRecurrentes * escala)));
  // Pedidos por cliente recurrente: el campeon + (nRec-1) con >= 2; el sobrante se reparte de uno en uno.
  const campeon = Math.min(DEMO_PERFIL_T7.maxPedidosUnCliente, pedidosRec - 2 * (nRec - 1));
  const porRecurrente: number[] = [campeon, ...Array.from({ length: nRec - 1 }, () => 2)];
  let sobran = pedidosRec - porRecurrente.reduce((a, b) => a + b, 0);
  for (let i = 0; sobran > 0; i += 1, sobran -= 1) porRecurrente[1 + (i % (nRec - 1))]! += 1;
  const unaVez = total - pedidosRec;
  const duenos: number[] = [];
  porRecurrente.forEach((n, c) => {
    for (let k = 0; k < n; k += 1) duenos.push(c);
  });
  for (let c = 0; c < unaVez; c += 1) duenos.push(nRec + c);
  // Barajar (Fisher-Yates determinista).
  for (let i = duenos.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [duenos[i], duenos[j]] = [duenos[j]!, duenos[i]!];
  }
  const dias_ = Array.from({ length: dias }, (_, i) => i + 1);
  const pesoDia = (atras: number) => PESO_DIA_T7[addDays(hoy, -atras).weekday]!;
  const slotsPorDia = new Map<number, SlotT7[]>();
  for (const cliente of duenos) {
    const atras = rng.weighted(dias_, pesoDia);
    const hIdx = rng.weighted(HORAS.map((_, i) => i), (i) => PESO_HORA_T7[i]!);
    const hora = HORAS[hIdx]!;
    const minuto = hora === 0 ? rng.int(0, 44) : rng.int(0, 59);
    const lista = slotsPorDia.get(atras) ?? [];
    lista.push({ hora, minuto, cliente });
    slotsPorDia.set(atras, lista);
  }
  return { nClientes: nRec + unaVez, slotsPorDia };
}

type LineaT7 = { productId: string; requestedQuantity: number; tortilla?: "maiz" | "harina" | "mixta" };

/**
 * Canasta de un pedido de T7 con los productos que mas se piden en la muestra real: fracciones de kilo de bistec y pastor (lo mas
 * pedido), ordenes de tacos de bistec, nachos, frances/alambre suizo, gringas, frijol con tostadas, guacamole, extras de salsa
 * ($19) y refrescos. Cada renglon es un producto REAL del catalogo de la sucursal (si un nombre no existe, se omite). El
 * `intento` agrega complementos cuando el motor rechaza por el minimo a domicilio.
 */
function canastaT7(rng: Rng, catalogo: readonly CatalogItem[], intento: number): LineaT7[] {
  const buscar = (re: RegExp) => catalogo.find((c) => re.test(c.name));
  const lineas: LineaT7[] = [];
  const agrega = (item: CatalogItem | undefined, cantidad = 1, tortilla = false) => {
    if (!item || lineas.some((l) => l.productId === item.id)) return;
    lineas.push({ productId: item.id, requestedQuantity: cantidad, ...(tortilla ? { tortilla: rng.weighted(["maiz", "harina", "mixta"] as const, (t) => (t === "maiz" ? 0.6 : t === "harina" ? 0.25 : 0.15)) } : {}) });
  };
  const kilo = () => {
    const carne = rng.chance(0.55) ? "Bistec de Res" : "Pastor";
    const fraccion = rng.weighted(["250 g", "500 g", "750 g", "1 kg", "1.5 kg", "2 kg"], (f) => ({ "250 g": 30, "500 g": 34, "750 g": 10, "1 kg": 18, "1.5 kg": 6, "2 kg": 2 })[f]!);
    return buscar(new RegExp(`^${carne} — ${fraccion.replace(".", "\\.")}$`));
  };
  const arquetipo = rng.weighted(["kilos", "ordenes", "chico", "grande"] as const, (a) => ({ kilos: 30, ordenes: 37, chico: 28, grande: 5 })[a]);
  if (arquetipo === "kilos" || arquetipo === "grande") {
    agrega(kilo(), 1, true);
    if (arquetipo === "grande") {
      agrega(kilo(), 1, true);
      if (rng.chance(0.5)) agrega(buscar(/^Pastor — 1 kg$/), 1, true);
      if (rng.chance(0.15)) agrega(buscar(/^Parrillada para 4$/));
    } else if (rng.chance(0.35)) {
      agrega(kilo(), 1, true);
    }
    if (rng.chance(0.55)) agrega(buscar(/^Frijol con Tostada$/), rng.int(1, 2));
    if (rng.chance(0.4)) agrega(buscar(/^Guacamole$/));
    if (rng.chance(0.2)) agrega(buscar(/^Extra Salsa$/));
  } else if (arquetipo === "ordenes") {
    const platillos = [/^Tacos de Bistec de Res \(orden de 3\)$/, /^Nachos de Bistec$/, /^Nachos de Pastor$/, /^Francés Suizo de Pastor$/, /^Francés Suizo de Bistec de Res$/, /^Alambre Suizo de Bistec$/, /^Alambre Suizo de Pastor$/, /^Gringa de Pastor$/, /^Gringa de Bistec$/, /^Frijoles Charros Normal$/, /^Chicharrón de Queso$/, /^Chetaco de Arrachera$/];
    for (let k = 0; k < rng.int(1, 3); k += 1) {
      const it = buscar(rng.pick(platillos));
      agrega(it, it?.packSize === 3 ? 3 * rng.int(1, 2) : rng.int(1, 2), true);
    }
    if (rng.chance(0.4)) agrega(buscar(/^Frijol con Tostada$/));
    if (rng.chance(0.25)) agrega(buscar(/^Extra Salsa$/));
  } else {
    agrega(buscar(/^Taco Al Pastor \(individual\)$/), rng.int(3, 6), true);
    agrega(buscar(rng.pick([/^Frijol con Tostada$/, /^Chicharrón de Queso$/, /^Guacamole$/])));
  }
  if (rng.chance(0.4)) agrega(buscar(rng.pick([/^Coca-Cola$/, /^Agua de Jamaica$/, /^Horchata$/, /^Coca-Cola sin Azúcar$/, /^Topo Chico$/])), rng.int(1, 3));
  // Reintentos por el minimo a domicilio: se agrega un complemento mas (mas chico primero).
  const relleno = [/^Frijol con Tostada$/, /^Guacamole$/, /^Chicharrón de Queso$/, /^Nachos de Pastor$/];
  for (let k = 0; k < intento; k += 1) agrega(buscar(relleno[k % relleno.length]!), 1);
  if (lineas.length === 0) agrega(catalogo[0], 1, true);
  return lineas;
}

export const DEMO_VOLUME_MAX_DIAS = 365;
export const DEMO_VOLUME_MAX_PEDIDOS_POR_DIA = 2000;

export class DemoVolumeError extends Error {}

/** Lecturas del catalogo que se repiten miles de veces: se memorizan para no consultar la base por cada pedido. */
const LECTURAS_MEMORIZABLES = new Set([
  "findBranch",
  "listAvailableProductsForBranch",
  "findBranchPolicy",
  "findBranchZonaHoraria",
  "listBranchHoursExceptions",
  "listBranchDeliveryZoneIds",
  "listKnownZones",
  "listAutoApplyPromotions",
  "findPromotionByCode",
]);

/** Envuelve el repositorio con una cache de lecturas de catalogo/politica (solo esas; nada de escritura). El seed no cambia
 * ni el menu ni la politica mientras corre. */
export function memorizarLecturas<T extends object>(repo: T): T {
  const cache = new Map<string, Promise<unknown>>();
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function" || !LECTURAS_MEMORIZABLES.has(prop)) return typeof value === "function" ? value.bind(target) : value;
      return (...args: unknown[]) => {
        const key = `${prop}:${JSON.stringify(args)}`;
        let hit = cache.get(key);
        if (!hit) {
          hit = (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          cache.set(key, hit);
        }
        return hit;
      };
    },
  });
}

/**
 * Genera el volumen por LOTES (un lote por dia) para no cargar 90k pedidos en memoria. El ultimo lote trae las conversaciones,
 * los handoffs y los contactos (dependen del ultimo pedido de cada cliente).
 */
export async function* generarVolumenDemo(repoBase: RestaurantesRepository, options: DemoVolumeOptions): AsyncGenerator<DemoVolumeBatch, DemoVolumeSummary> {
  if (!Number.isInteger(options.dias) || options.dias < 1 || options.dias > DEMO_VOLUME_MAX_DIAS) throw new DemoVolumeError(`dias debe ser un entero de 1 a ${DEMO_VOLUME_MAX_DIAS}.`);
  const perfil = options.perfil;
  const pedidosPorDia = options.pedidosPorDia ?? 0;
  if (!perfil && (!Number.isInteger(pedidosPorDia) || pedidosPorDia < 1 || pedidosPorDia > DEMO_VOLUME_MAX_PEDIDOS_POR_DIA)) {
    throw new DemoVolumeError(`pedidosPorDia debe ser un entero de 1 a ${DEMO_VOLUME_MAX_PEDIDOS_POR_DIA}.`);
  }
  const repo = memorizarLecturas(repoBase);
  const seed = options.seed ?? 20_261_001;
  const rng = new Rng(seed);
  const ahora = options.ahora ?? new Date();
  const organizationId = options.organizationId;

  const branches = (await repo.listBranchesForOrganizationAdmin(organizationId)).filter((b) => b.status === "active" && (!perfil || b.slug === DEMO_PERFIL_T7.sucursal));
  if (perfil && branches.length === 0) throw new DemoVolumeError(`El perfil ${perfil} necesita la sucursal ${DEMO_PERFIL_T7.sucursal} ACTIVA (fase 1 del agente): cargue primero el seed de PM.`);
  if (branches.length === 0) throw new DemoVolumeError("La organizacion no tiene sucursales activas: cargue primero el seed de PM (scripts/seed-pm-demo).");
  const catalogos = new Map<string, CatalogItem[]>();
  const populares = new Set((await repo.listProducts(organizationId)).filter((p) => p.isPopular).map((p) => p.id));
  for (const b of branches) {
    const productos = await repo.listAvailableProductsForBranch(b.propertyId);
    if (productos.length === 0) throw new DemoVolumeError(`La sucursal ${b.name} no tiene menu: cargue primero el seed de PM.`);
    catalogos.set(
      b.slug,
      productos.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        packSize: Number(PAQUETE_RE.exec(`${p.name} ${p.description ?? ""}`)?.[1]) || null,
        noDomicilio: p.noDomicilio === true,
        requiresAdult: /(cerveza|licor|tequila|mezcal|vino|ron|whisky|vodka|michelada|margarita|corona|victoria|modelo|heineken|sol\b)/i.test(`${p.name} ${p.categoryName ?? ""}`) && p.noDomicilio === true,
        isTacos: /\btacos?\b/i.test(p.name),
        peso: itemPesoPorNombre(p.name, populares.has(p.id)),
      })),
    );
  }
  const zonaCruda = (await repo.findBranchZonaHoraria(branches[0]!.propertyId)).zonaHoraria;
  const zona = resolverZonaHorariaNegocio(zonaCruda);
  const hoy = fechaLocal(ahora, zona);

  // Colonias de cada sucursal: las de su cobertura de entrega cargada (el seed de PM las carga; sin ellas un domicilio de PM no se valida y el
  // agente exige el pin), y solo si la sucursal no tiene cobertura se usan las de ejemplo de este generador.
  const zonasDeLaOrg = await repo.listKnownZones(organizationId);
  const coloniasPorSucursal = new Map<string, readonly string[]>();
  for (const b of branches) {
    const cubiertas = new Set(await repo.listBranchDeliveryZoneIds(b.propertyId));
    const nombres = zonasDeLaOrg.filter((z) => cubiertas.has(z.id) && z.lat === null).map((z) => z.name).sort((a, c) => a.localeCompare(c, "es"));
    if (nombres.length > 0) coloniasPorSucursal.set(b.slug, nombres);
  }
  const coloniasDe = (slug: string): readonly string[] => coloniasPorSucursal.get(slug) ?? COLONIAS_POR_SUCURSAL[slug] ?? COLONIAS_POR_OMISION;

  // --- clientes ---------------------------------------------------------------------------------------------------
  const plan = perfil ? planificarPerfilT7(rng, options.dias, hoy) : null;
  const totalEsperado = options.dias * pedidosPorDia;
  const nClientes = plan ? plan.nClientes : Math.min(900_000, Math.max(40, Math.round(totalEsperado / 6)));
  const clientes: Cliente[] = [];
  for (let i = 0; i < nClientes; i += 1) {
    if (plan) {
      clientes.push({
        phone10: demoPhone(DEMO_PHONE_PREFIX_VOLUME, i).slice(3),
        name: `${rng.pick(NOMBRES)} ${rng.pick(APELLIDOS)} ${String(i + 1).padStart(4, "0")}`.slice(0, 60),
        address: `Privada ${rng.pick(PRIVADAS_T7)} casa ${rng.int(2, 48)}, Col. ${rng.pick(coloniasDe(DEMO_PERFIL_T7.sucursal))}, Mérida`,
        homeSlug: DEMO_PERFIL_T7.sucursal,
        firstOrderAt: null,
        lastWhatsapp: null,
      });
      continue;
    }
    const home = rng.weighted(branches, (b) => PESO_SUCURSAL[b.slug] ?? 0.2);
    const colonia = rng.pick(coloniasDe(home.slug));
    clientes.push({
      phone10: demoPhone(DEMO_PHONE_PREFIX_VOLUME, i).slice(3),
      name: `${rng.pick(NOMBRES)} ${rng.pick(APELLIDOS)} ${String(i + 1).padStart(4, "0")}`.slice(0, 60),
      address: `Calle ${rng.int(10, 90)} #${rng.int(100, 999)} x ${rng.int(10, 90)} y ${rng.int(10, 90)}, Col. ${colonia}, Mérida`,
      homeSlug: home.slug,
      firstOrderAt: null,
      lastWhatsapp: null,
    });
  }

  const clientePorTelefono = new Map(clientes.map((c) => [c.phone10, c]));
  const porSucursal: Record<string, number> = {};
  let totalPedidos = 0;
  let omitidos = 0;
  let consecutivo = 0;
  const vistos = new Set<string>();
  let desde = "";
  let hasta = "";

  for (let d = options.dias; d >= 1; d -= 1) {
    const dia = addDays(hoy, -d);
    const finDeSemana = dia.weekday === 0 || dia.weekday === 6 || dia.weekday === 5;
    const slotsDia = plan ? plan.slotsPorDia.get(d) ?? [] : null;
    const factor = slotsDia ? 1 : (dia.weekday === 6 || dia.weekday === 0 ? 1.45 : dia.weekday === 5 ? 1.2 : dia.weekday === 1 ? 1.1 : 0.88) * (0.85 + rng.float() * 0.3);
    const cuantos = slotsDia ? slotsDia.length : Math.max(1, Math.round(pedidosPorDia * factor));
    const pesos = finDeSemana ? PESO_HORA_FIN_DE_SEMANA : PESO_HORA_SEMANA;
    const delDia: DemoOrderRow[] = [];
    const clientesNuevos: DemoCustomerRow[] = [];

    for (let n = 0; n < cuantos; n += 1) {
      const slot = slotsDia?.[n];
      let hora: number;
      let minuto: number;
      if (slot) {
        hora = slot.hora;
        minuto = slot.minuto;
      } else {
        const hIdx = rng.weighted(HORAS.map((_, i) => i), (i) => pesos[i]!);
        hora = HORAS[hIdx]!;
        minuto = hora === 0 ? rng.int(0, 44) : rng.int(0, 59);
      }
      // La hora 0 es la madrugada del dia SIGUIENTE (el turno cruza la medianoche).
      const base = hora === 0 ? addDays(dia.iso, 1) : dia;
      const creado = localToUtc(zona, base.year, base.month, base.day, hora, minuto);

      const cliente = slot ? clientes[slot.cliente]! : clientes[Math.min(clientes.length - 1, Math.floor(clientes.length * rng.float() ** 2.2))]!;
      const sucursal = slot ? branches[0]! : rng.chance(0.86) ? branches.find((b) => b.slug === cliente.homeSlug) ?? branches[0]! : rng.weighted(branches, (b) => PESO_SUCURSAL[b.slug] ?? 0.2);
      const catalogo = catalogos.get(sucursal.slug)!;
      const canalElegido: CanalPedido = slot
        ? rng.chance(DEMO_PERFIL_T7.fraccionDomicilio) ? "domicilio" : "recoger"
        : rng.chance(RECOGER_POR_SUCURSAL[sucursal.slug] ?? 0.3) ? "recoger" : "domicilio";
      // En el perfil T7 TODO entra por WhatsApp (asi es la muestra real).
      const source = slot ? ("whatsapp" as const) : rng.weighted(["whatsapp", "admin"] as const, (s) => (s === "whatsapp" ? 0.9 : 0.1));
      const paymentMethod = slot ? (rng.chance(DEMO_PERFIL_T7.fraccionTarjeta) ? "tarjeta" : "efectivo") : rng.chance(0.38) ? "tarjeta" : "efectivo";
      consecutivo += 1;
      const clave = slot ? `demo-volumen-t7:${seed}:${consecutivo}` : `demo-volumen:${seed}:${consecutivo}`;

      // Se intenta con el canal elegido; si el motor rechaza (p. ej. no llega al minimo a domicilio) se agregan productos y,
      // como ultimo recurso, se pasa a recoger. Lo que el motor no acepta NUNCA se escribe.
      let prepared: Awaited<ReturnType<typeof prepareCreateOrder>> | null = null;
      let canalFinal: CanalPedido = canalElegido;
      let propina: number | null = null;
      for (let intento = 0; intento < 6 && !prepared; intento += 1) {
        let items: { productId: string; requestedQuantity: number; tortilla?: "maiz" | "harina" | "mixta" }[];
        let alcohol = false;
        if (slot) {
          items = canastaT7(rng, catalogo, intento);
        } else {
          const candidatos = catalogo.filter((c) => (canalFinal === "domicilio" ? !c.noDomicilio : true));
          const lineas = Math.min(candidatos.length, 1 + intento + rng.int(0, 2));
          const elegidos = new Map<string, CatalogItem>();
          for (let k = 0; k < lineas * 3 && elegidos.size < lineas; k += 1) {
            const it = rng.weighted(candidatos, (c) => c.peso * (c.requiresAdult ? (canalFinal === "recoger" ? 1 : 0) : 1));
            elegidos.set(it.id, it);
          }
          items = [...elegidos.values()].map((c) => {
            const requestedQuantity = c.packSize && c.packSize > 1 ? c.packSize * rng.int(1, 2) : c.isTacos ? rng.int(2, 10) : rng.int(1, 2);
            return { productId: c.id, requestedQuantity, ...(c.isTacos ? { tortilla: rng.weighted(["maiz", "harina", "mixta"] as const, (t) => (t === "maiz" ? 0.55 : t === "harina" ? 0.35 : 0.1)) } : {}) };
          });
          alcohol = [...elegidos.values()].some((c) => c.requiresAdult);
        }
        propina = paymentMethod === "tarjeta" && rng.chance(0.45) ? rng.pick([10, 15, 20, 30, 40]) : null;
        try {
          prepared = await prepareCreateOrder(
            repo,
            {
              organizationId,
              branchSlug: sucursal.slug,
              customerName: cliente.name,
              customerPhone: cliente.phone10,
              ...(canalFinal === "domicilio" ? { customerAddress: cliente.address, colonia: cliente.address.split("Col. ")[1]?.split(",")[0] } : {}),
              items,
              source,
              paymentMethod,
              canal: canalFinal,
              ...(propina ? { propina } : {}),
              ...(alcohol ? { adultConfirmed: true } : {}),
              idempotencyKey: clave,
            },
            { asOf: creado },
          );
        } catch (err) {
          if (!(err instanceof OrderValidationError) && !(err instanceof PromotionError)) throw err;
          if (intento >= 3) canalFinal = "recoger";
        }
      }
      if (!prepared) {
        omitidos += 1;
        continue;
      }
      if (vistos.has(clave)) continue;
      vistos.add(clave);

      // Estado final del pedido historico (los de hoy no se generan: el ultimo dia es ayer).
      const suerte = rng.float();
      let status: OrderStatus = "completado";
      // Perfil T7: 1.5 % cancelados y 5.8 % con problema (las 8 quejas de la muestra son 5.8 % de los pedidos).
      const corteCancelado = slot ? 0.015 : 0.06;
      const corteProblema = slot ? 0.073 : 0.085;
      if (suerte < corteCancelado) status = "cancelado";
      else if (suerte < corteProblema) status = canalFinal === "recoger" ? "no_recogido" : "problema";
      const duracionMin = slot
        ? canalFinal === "domicilio"
          ? rng.chance(0.55) ? rng.pick([60, 65, 75]) : rng.int(50, 90)
          : Math.round((rng.int(10, 45) + rng.int(10, 50)) / 2)
        : canalFinal === "domicilio" ? rng.int(32, 68) : rng.int(14, 32);
      const notas = [
        buildComplementNotes(undefined),
        prepared.appliedPromotion ? `Promoción aplicada: ${prepared.appliedPromotion.code} (-$${prepared.discount.toFixed(2)}).` : "",
        canalFinal === "recoger" ? "Canal: recoger en sucursal." : "Canal: domicilio.",
        propina && propina > 0 ? `Propina: $${propina.toFixed(2)} (no incluida en el total).` : "",
      ].filter(Boolean);
      const row: DemoOrderRow = {
        idempotencyKey: sha256(`${organizationId}:${clave}`),
        branchSlug: sucursal.slug,
        branchName: sucursal.name,
        customerPhone: prepared.payload.customerPhone,
        customerName: prepared.payload.customerName,
        address: canalFinal === "domicilio" ? cliente.address : null,
        items: prepared.orderItems,
        total: prepared.total,
        status,
        source: source as "web" | "whatsapp" | "admin",
        paymentMethod,
        canal: canalFinal,
        propina: propina && propina > 0 ? propina : null,
        notes: notas.join("\n"),
        createdAt: creado.toISOString(),
        deliveredAt: status === "completado" ? new Date(creado.getTime() + duracionMin * 60_000).toISOString() : null,
      };
      delDia.push(row);
      porSucursal[sucursal.slug] = (porSucursal[sucursal.slug] ?? 0) + 1;
      totalPedidos += 1;
      if (!desde || row.createdAt < desde) desde = row.createdAt;
      if (!hasta || row.createdAt > hasta) hasta = row.createdAt;
    }
    // Cronologico DENTRO del dia: el cliente "nuevo" y su ultimo pedido por WhatsApp se deciden ya con el orden real.
    delDia.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    for (const row of delDia) {
      const cliente = clientePorTelefono.get(row.customerPhone)!;
      if (!cliente.firstOrderAt) {
        cliente.firstOrderAt = new Date(row.createdAt);
        clientesNuevos.push({ phone: cliente.phone10, name: cliente.name, address: cliente.address, firstOrderAt: row.createdAt });
      }
      if (row.source === "whatsapp" && row.status !== "cancelado") cliente.lastWhatsapp = row;
    }
    yield { customers: clientesNuevos, orders: delDia, conversations: [], handoffs: [], callbacks: [] };
  }

  // --- conversaciones, handoffs y contactos (ultimo lote) ------------------------------------------------------------
  const conversations: DemoConversationRow[] = [];
  const handoffs: DemoHandoffRow[] = [];
  const callbacks: DemoCallbackRow[] = [];
  const conWhatsapp = clientes.filter((c) => c.lastWhatsapp);
  const ordenados = [...conWhatsapp].sort((a, b) => (Date.parse(a.lastWhatsapp!.createdAt) - Date.parse(b.lastWhatsapp!.createdAt)));
  const recientes = new Set(ordenados.slice(-3).map((c) => c.phone10));
  for (const c of conWhatsapp) {
    const w = c.lastWhatsapp!;
    const at = new Date(w.createdAt);
    const mensajes = conversacionDePedido(w, perfil);
    const queja = rng.chance(0.03) || recientes.has(c.phone10);
    if (queja) {
      const pendiente = recientes.has(c.phone10);
      const solicitada = pendiente ? new Date(ahora.getTime() - rng.int(5, 40) * 60_000) : new Date(at.getTime() + rng.int(40, 140) * 60_000);
      const motivo = rng.pick(["queja", "queja", "tiempos_entrega", "modificacion_platillo"] as const);
      conversations.push({
        phone: `+52${c.phone10}`,
        branchSlug: w.branchSlug,
        messages: [
          ...mensajes,
          { role: "user", content: motivo === "queja" ? "Mi pedido llegó incompleto y frío, quiero poner una queja" : motivo === "tiempos_entrega" ? "Ya pasó más de una hora y no llega mi pedido" : "¿Pueden cambiar la receta del platillo que pedí?" },
          { role: "assistant", content: "Lamento el inconveniente. Ya avisé al equipo de la sucursal y una persona se comunicará con usted. Gracias por su paciencia." },
        ],
        status: "active",
        orderKey: w.idempotencyKey,
        updatedAt: solicitada.toISOString(),
      });
      handoffs.push({ phone: `+52${c.phone10}`, branchSlug: w.branchSlug, estado: pendiente ? "pendiente" : "cerrada", motivo, solicitadaAt: solicitada.toISOString(), cerradaAt: pendiente ? null : new Date(solicitada.getTime() + rng.int(25, 180) * 60_000).toISOString() });
      callbacks.push({ phone: c.phone10, name: c.name, branchSlug: w.branchSlug, reason: `escalada:${motivo}`, message: "El cliente pidió que una persona lo contacte.", resolved: !pendiente, createdAt: solicitada.toISOString() });
    } else {
      conversations.push({ phone: `+52${c.phone10}`, branchSlug: w.branchSlug, messages: mensajes, status: "completed", orderKey: w.idempotencyKey, updatedAt: new Date(at.getTime() + 6 * 60_000).toISOString() });
    }
  }
  // Conversaciones abandonadas (preguntaron y no pidieron): ~4% de los clientes sin pedido por WhatsApp.
  const sinPedidoWa = clientes.filter((c) => !c.lastWhatsapp && c.firstOrderAt);
  for (const c of sinPedidoWa.slice(0, Math.max(0, Math.floor(sinPedidoWa.length * 0.04)))) {
    const quando = new Date(c.firstOrderAt!.getTime() + rng.int(1, 40) * 3_600_000);
    conversations.push({
      phone: `+52${c.phone10}`,
      branchSlug: c.homeSlug,
      messages: [
        { role: "user", content: "Hola, ¿qué promociones tienen?" },
        { role: "assistant", content: "Buenas tardes, gracias por comunicarse a Los Taquitos de PM. Los lunes tenemos 2x1 en tacos al pastor, solo para recoger. ¿Desea hacer un pedido?" },
      ],
      status: "abandoned",
      orderKey: null,
      updatedAt: quando.toISOString(),
    });
  }
  yield { customers: [], orders: [], conversations, handoffs, callbacks };

  return { orders: totalPedidos, customers: clientes.filter((c) => c.firstOrderAt).length, omitidos, porSucursal, desde, hasta };
}
