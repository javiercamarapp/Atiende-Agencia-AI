// SINTÉTICO · Datos de prueba del CFO de restaurantes con la forma y los volúmenes de «Los Taquitos de PM» (diseño §4.8).
//
// NO son datos reales: ni clientes, ni teléfonos, ni un export real de SoftRestaurant. Todo sale de un generador DETERMINISTA
// (semilla fija): mismas entradas, mismas salidas. Nada de esto debe tocar jamás una base real.
//
// Volúmenes (PM): 3,929 pedidos al mes (2,806 a domicilio y 1,123 para recoger); ~18 % por WhatsApp y el resto por voz (≈165 por semana);
// picos sábado y domingo 13–16 h y 18–22 h; ~70 % de clientes recurrentes; ~8 % de cancelaciones; promos de lunes y martes SOLO para recoger
// (2x1 en tacos al pastor); ticket alrededor de $312. Sucursales: T1, T2, T3, T7 y T8 reparten a domicilio; T4 (Galerías) y T5 (Chicxulub)
// solo presencial y recoger.
import type {
  CfoConfig,
  FilaAgenteDiario,
  FilaAgotado,
  FilaClientesResumen,
  FilaComandasPos,
  FilaCortesias,
  FilaCostoCaptura,
  FilaProducto,
  FilaSrResumen,
  FilaSrTicket,
  FilaVentasDiarias,
  FilaVentasHora,
  SucursalCfo,
  TipoServicioSr,
} from "../../src/cfo/tipos.ts";
import { CFO_CONFIG_POR_DEFECTO } from "../../src/cfo/tipos.ts";
import { cmp } from "../../src/cfo/util.ts";

export const ETIQUETA_SINTETICO = "SINTÉTICO – no es un export real de SoftRestaurant";

export interface SucursalSintetica extends SucursalCfo {
  readonly codigo: string;
  /** Reparte a domicilio. */
  readonly reparte: boolean;
  readonly pesoDomicilio: number;
  readonly pesoRecoger: number;
}

export const SUCURSALES_PM_SINTETICAS: readonly SucursalSintetica[] = [
  { codigo: "T1", propertyId: "00000000-0000-4000-8000-0000000000a1", nombre: "Prolongación Montejo", reparte: true, pesoDomicilio: 0.27, pesoRecoger: 0.2 },
  { codigo: "T2", propertyId: "00000000-0000-4000-8000-0000000000a2", nombre: "Francisco de Montejo", reparte: true, pesoDomicilio: 0.17, pesoRecoger: 0.12 },
  { codigo: "T3", propertyId: "00000000-0000-4000-8000-0000000000a3", nombre: "Pensiones", reparte: true, pesoDomicilio: 0.15, pesoRecoger: 0.1 },
  { codigo: "T7", propertyId: "00000000-0000-4000-8000-0000000000a7", nombre: "Victory Platz", reparte: true, pesoDomicilio: 0.22, pesoRecoger: 0.18 },
  { codigo: "T8", propertyId: "00000000-0000-4000-8000-0000000000a8", nombre: "Altabrisa", reparte: true, pesoDomicilio: 0.19, pesoRecoger: 0.15 },
  { codigo: "T4", propertyId: "00000000-0000-4000-8000-0000000000a4", nombre: "Galerías", reparte: false, pesoDomicilio: 0, pesoRecoger: 0.15 },
  { codigo: "T5", propertyId: "00000000-0000-4000-8000-0000000000a5", nombre: "Chicxulub", reparte: false, pesoDomicilio: 0, pesoRecoger: 0.1 },
];

export const CORTE_NEGOCIO_SINTETICO = "01:00";
export const TIPO_CAMBIO_SINTETICO_MXN_POR_USD = 18;

// ---- Catálogo SINTÉTICO de productos (centavos) --------------------------------------------------------------------------------------------

export const PRODUCTOS_SINTETICOS = [
  { ref: "p-taco-pastor", nombre: "Taco al pastor", categoria: "Tacos", precio: 4200 },
  { ref: "p-orden-bistec", nombre: "Orden de 3 de bistec", categoria: "Órdenes", precio: 19400 },
  { ref: "p-agua-fresca", nombre: "Agua fresca 1 L", categoria: "Bebidas", precio: 6000 },
  { ref: "p-refresco", nombre: "Refresco", categoria: "Bebidas", precio: 3500 },
  { ref: "p-cochinita", nombre: "Cochinita pibil", categoria: "Regional", precio: 13500 },
  { ref: "p-flan", nombre: "Flan", categoria: "Postres", precio: 5500 },
] as const;

// ---- PRNG determinista -------------------------------------------------------------------------------------------------------------------

export function mulberry32(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function isoDow(fecha: string): number {
  const d = new Date(`${fecha}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function divR(num: number, den: number): number {
  return Math.round(num / den);
}

// ---- Pedido sintético --------------------------------------------------------------------------------------------------------------------

export type EstadoSintetico = "entregado" | "completado" | "cancelado" | "no_recogido";

export interface PedidoSintetico {
  readonly id: string;
  readonly propertyId: string;
  readonly diaNegocio: string;
  readonly horaLocal: number;
  readonly canal: "domicilio" | "recoger";
  readonly source: "voice" | "whatsapp";
  readonly pago: "efectivo" | "tarjeta";
  readonly estado: EstadoSintetico;
  readonly esReposicion: boolean;
  readonly esCompensacion: boolean;
  readonly items: ReadonlyArray<{ readonly ref: string; readonly cantidad: number; readonly precio: number }>;
  readonly brutaCentavos: number;
  readonly descCentavos: number;
  readonly netaCentavos: number;
  readonly propinaCentavos: number;
  readonly entregaMin: number | null;
  readonly clienteId: string;
}

export interface OpcionesSinteticas {
  readonly semilla?: number;
  /** Último día de negocio generado (inclusive). */
  readonly hasta?: string;
  /** Cuántos días hacia atrás (incluye `hasta`). */
  readonly dias?: number;
}

const FACTOR_DOW = [0.85, 0.9, 0.95, 1.0, 1.15, 1.3, 1.25] as const;
const HORAS_PICO_FIN = [13, 14, 15, 16, 18, 19, 20, 21, 22] as const;
const HORAS_NORMAL = [12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 0] as const;
const PEDIDOS_MES_DOMICILIO = 2806;
const PEDIDOS_MES_RECOGER = 1123;

export function generarPedidosSinteticos(op: OpcionesSinteticas = {}): PedidoSintetico[] {
  const hasta = op.hasta ?? "2026-09-27";
  const dias = op.dias ?? 150;
  const rnd = mulberry32(op.semilla ?? 20261007);
  const media = FACTOR_DOW.reduce((s, x) => s + x, 0) / 7;

  // Clientes SINTÉTICOS: «Cliente SINTÉTICO n», con sucursal de casa. 70 % recurrentes (pesos altos).
  const clientes = Array.from({ length: 1800 }, (_, i) => {
    const suc = SUCURSALES_PM_SINTETICAS[Math.floor(rnd() * SUCURSALES_PM_SINTETICAS.length)]!;
    const recurrente = rnd() < 0.7;
    return { id: `cliente-sintetico-${i + 1}`, casa: suc.propertyId, peso: recurrente ? 5 + rnd() * 10 : 1 };
  });
  const porCasa = new Map<string, typeof clientes>();
  for (const c of clientes) porCasa.set(c.casa, [...(porCasa.get(c.casa) ?? []), c]);
  const elegirCliente = (lista: typeof clientes): string => {
    const total = lista.reduce((s, c) => s + c.peso, 0);
    let r = rnd() * total;
    for (const c of lista) { r -= c.peso; if (r <= 0) return c.id; }
    return lista[lista.length - 1]!.id;
  };

  const out: PedidoSintetico[] = [];
  let n = 0;
  for (let k = dias - 1; k >= 0; k--) {
    const dia = sumarDias(hasta, -k);
    const dow = isoDow(dia);
    const factor = FACTOR_DOW[dow - 1]! / media;
    for (const suc of SUCURSALES_PM_SINTETICAS) {
      for (const canal of ["domicilio", "recoger"] as const) {
        const peso = canal === "domicilio" ? suc.pesoDomicilio : suc.pesoRecoger;
        if (peso === 0) continue;
        const mensual = canal === "domicilio" ? PEDIDOS_MES_DOMICILIO : PEDIDOS_MES_RECOGER;
        const esperado = (mensual * peso) / 30.4 * factor;
        const cuantos = Math.max(0, Math.round(esperado * (0.85 + rnd() * 0.3)));
        for (let i = 0; i < cuantos; i++) {
          n += 1;
          const horas = dow >= 6 && rnd() < 0.7 ? HORAS_PICO_FIN : HORAS_NORMAL;
          const hora = horas[Math.floor(rnd() * horas.length)]!;
          const source = rnd() < 0.18 ? "whatsapp" : "voice";
          const pago = rnd() < (canal === "domicilio" ? 0.62 : 0.45) ? "efectivo" : "tarjeta";
          // Renglones: tacos al pastor (2..9) + agua (60 %) + extra (25 %).
          const tacos = 2 + Math.floor(rnd() * 8);
          const items: Array<{ ref: string; cantidad: number; precio: number }> = [{ ref: "p-taco-pastor", cantidad: tacos, precio: 4200 }];
          if (rnd() < 0.6) items.push({ ref: "p-agua-fresca", cantidad: 1, precio: 6000 });
          if (rnd() < 0.25) {
            const extra = PRODUCTOS_SINTETICOS[1 + Math.floor(rnd() * 5)]!;
            items.push({ ref: extra.ref, cantidad: 1, precio: extra.precio });
          }
          const bruta = items.reduce((s, it) => s + it.cantidad * it.precio, 0);
          // Descuentos: promo 2x1 al pastor lunes/martes SOLO para recoger; compensación GRACIAS- 15 % (1.5 %).
          let desc = 0;
          let esComp = false;
          if (canal === "recoger" && (dow === 1 || dow === 2) && rnd() < 0.7) desc = Math.min(Math.floor(tacos / 2) * 4200, bruta);
          else if (rnd() < 0.015) { desc = divR(bruta * 15, 100); esComp = true; }
          const reposicion = rnd() < 0.008;
          let estado: EstadoSintetico = canal === "domicilio" ? "entregado" : "completado";
          if (rnd() < 0.08) estado = "cancelado";
          else if (canal === "recoger" && rnd() < 0.02) estado = "no_recogido";
          const neta = reposicion ? 0 : bruta - desc;
          // minutos con 2 decimales, como el `round(..., 2)` por pedido de la SQL
          const entregaMin = estado === "entregado" ? Math.round(Math.max(20, Math.min(95, 45 + (rnd() + rnd() + rnd() - 1.5) * 20)) * 100) / 100 : null;
          const propina = estado === "entregado" || estado === "completado" ? (pago === "tarjeta" && rnd() < 0.7 ? divR(neta * 10, 100) : 0) : 0;
          out.push({
            id: `ped-${n}`,
            propertyId: suc.propertyId,
            diaNegocio: dia,
            horaLocal: hora,
            canal,
            source,
            pago,
            estado,
            esReposicion: reposicion,
            esCompensacion: esComp,
            items,
            brutaCentavos: bruta,
            descCentavos: reposicion ? 0 : desc,
            netaCentavos: neta,
            propinaCentavos: propina,
            entregaMin,
            clienteId: rnd() < 0.9 ? elegirCliente(porCasa.get(suc.propertyId) ?? clientes) : elegirCliente(clientes),
          });
        }
      }
    }
  }
  return out;
}

// ---- Agregados con la forma de las funciones SQL -----------------------------------------------------------------------------------------

const esVenta = (p: PedidoSintetico): boolean => (p.estado === "entregado" || p.estado === "completado") && !p.esReposicion;

export function agregarVentasDiarias(pedidos: readonly PedidoSintetico[], promesaMin = 50): FilaVentasDiarias[] {
  const m = new Map<string, FilaVentasDiarias>();
  const base = (p: PedidoSintetico): FilaVentasDiarias => ({
    propertyId: p.propertyId, diaNegocio: p.diaNegocio, canal: p.canal, source: p.source, paymentMethod: p.pago,
    pedidos: 0, brutaCentavos: 0, descPromoCentavos: 0, descCompCentavos: 0, netaCentavos: 0, propinaCentavos: 0, cancelados: 0, canceladosCentavos: 0,
    noRecogidos: 0, noRecogidosCentavos: 0, reposiciones: 0, reposicionUnidades: 0, entregados: 0, entregaMinSuma: 0, entregaTarde: 0,
  });
  for (const p of pedidos) {
    const k = `${p.propertyId}|${p.diaNegocio}|${p.canal}|${p.source}|${p.pago}`;
    const f = { ...(m.get(k) ?? base(p)) };
    if (p.esReposicion) {
      f.reposiciones += 1;
      f.reposicionUnidades += p.items.reduce((s, it) => s + it.cantidad, 0);
    } else if (p.estado === "cancelado") {
      f.cancelados += 1;
      f.canceladosCentavos += p.netaCentavos;
    } else if (p.estado === "no_recogido") {
      f.noRecogidos += 1;
      f.noRecogidosCentavos += p.netaCentavos;
    } else if (esVenta(p)) {
      f.pedidos += 1;
      f.brutaCentavos += p.brutaCentavos;
      if (p.esCompensacion) f.descCompCentavos += p.descCentavos;
      else f.descPromoCentavos += p.descCentavos;
      f.netaCentavos += p.netaCentavos;
      f.propinaCentavos += p.propinaCentavos;
      if (p.entregaMin != null) {
        f.entregados += 1;
        f.entregaMinSuma = Math.round((f.entregaMinSuma + p.entregaMin) * 100) / 100;
        if (p.entregaMin > promesaMin) f.entregaTarde += 1;
      }
    }
    m.set(k, f);
  }
  return [...m.values()].sort((a, b) => cmp(a.propertyId, b.propertyId) || cmp(a.diaNegocio, b.diaNegocio) || cmp(a.canal, b.canal) || cmp(a.source, b.source) || cmp((a.paymentMethod ?? ""), b.paymentMethod ?? ""));
}

export function agregarCortesias(pedidos: readonly PedidoSintetico[]): FilaCortesias[] {
  const m = new Map<string, FilaCortesias>();
  for (const p of pedidos) {
    if (!p.esReposicion) continue;
    const k = `${p.propertyId}|${p.diaNegocio}`;
    const prev = m.get(k) ?? { propertyId: p.propertyId, diaNegocio: p.diaNegocio, reposiciones: 0, valorListaCentavos: 0, renglonesSinPrecio: 0 };
    m.set(k, { ...prev, reposiciones: prev.reposiciones + 1, valorListaCentavos: prev.valorListaCentavos + p.brutaCentavos });
  }
  return [...m.values()].sort((a, b) => cmp(a.propertyId, b.propertyId) || cmp(a.diaNegocio, b.diaNegocio));
}

export function agregarVentasHora(pedidos: readonly PedidoSintetico[]): FilaVentasHora[] {
  const m = new Map<string, FilaVentasHora>();
  for (const p of pedidos) {
    if (!esVenta(p)) continue;
    const dow = isoDow(p.diaNegocio);
    const k = `${p.propertyId}|${dow}|${p.horaLocal}|${p.source}`;
    const prev = m.get(k) ?? { propertyId: p.propertyId, dowNegocio: dow, horaLocal: p.horaLocal, source: p.source, pedidos: 0, netaCentavos: 0 };
    m.set(k, { ...prev, pedidos: prev.pedidos + 1, netaCentavos: prev.netaCentavos + p.netaCentavos });
  }
  return [...m.values()].sort((a, b) => cmp(a.propertyId, b.propertyId) || a.dowNegocio - b.dowNegocio || a.horaLocal - b.horaLocal || cmp(a.source, b.source));
}

export function agregarProductos(pedidos: readonly PedidoSintetico[]): FilaProducto[] {
  const m = new Map<string, FilaProducto>();
  const cat = new Map<string, (typeof PRODUCTOS_SINTETICOS)[number]>(PRODUCTOS_SINTETICOS.map((p) => [p.ref, p]));
  for (const p of pedidos) {
    if (!esVenta(p)) continue;
    for (const it of p.items) {
      const prod = cat.get(it.ref)!;
      const k = `${p.propertyId}|${it.ref}|${p.diaNegocio}`;
      const prev = m.get(k) ?? { propertyId: p.propertyId, productoRef: it.ref, nombreActual: prod.nombre, categoria: prod.categoria, diaNegocio: p.diaNegocio, dowNegocio: isoDow(p.diaNegocio), unidades: 0, ingresoCentavos: 0, pedidos: 0 };
      m.set(k, { ...prev, unidades: prev.unidades + it.cantidad, ingresoCentavos: prev.ingresoCentavos + it.cantidad * it.precio, pedidos: prev.pedidos + 1 });
    }
  }
  return [...m.values()].sort((a, b) => cmp(a.propertyId, b.propertyId) || cmp(a.productoRef, b.productoRef) || cmp(a.diaNegocio, b.diaNegocio));
}

// ---- Clientes (conteos distintos: NO aditivos) -------------------------------------------------------------------------------------------

function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function resumirClientes(pedidos: readonly PedidoSintetico[], desde: string, hasta: string, config: CfoConfig = CFO_CONFIG_POR_DEFECTO): FilaClientesResumen[] {
  const ventas = pedidos.filter((p) => esVenta(p) && p.diaNegocio <= hasta);
  const calcular = (alcance: "sucursal" | "conjunto", propertyId: string | null, lista: readonly PedidoSintetico[]): FilaClientesResumen => {
    const porCliente = new Map<string, PedidoSintetico[]>();
    for (const p of lista) porCliente.set(p.clienteId, [...(porCliente.get(p.clienteId) ?? []), p]);
    let clientesConPedido = 0, nuevos = 0, activos = 0, dormidos = 0, perdidos = 0, frecuentes = 0, recuperados = 0;
    const netaPorCliente: number[] = [];
    const intervalos: number[] = [];
    let pedidos12m = 0, clientes12m = 0;
    for (const ps of porCliente.values()) {
      const orden = [...ps].sort((a, b) => cmp(a.diaNegocio, b.diaNegocio));
      const enRango = orden.filter((p) => p.diaNegocio >= desde);
      const ultimo = orden[orden.length - 1]!.diaNegocio;
      const d = diasEntre(ultimo, hasta);
      if (d <= config.activoDias) activos += 1; else if (d <= config.perdidoDias) dormidos += 1; else perdidos += 1;
      if (orden.filter((p) => diasEntre(p.diaNegocio, hasta) < config.frecuenteDias).length >= config.frecuenteN) frecuentes += 1;
      pedidos12m += orden.length; clientes12m += 1;
      for (let i = 1; i < orden.length; i++) intervalos.push(diasEntre(orden[i - 1]!.diaNegocio, orden[i]!.diaNegocio));
      if (enRango.length === 0) continue;
      clientesConPedido += 1;
      if (orden[0]!.diaNegocio >= desde) nuevos += 1;
      else {
        const previos = orden.filter((p) => p.diaNegocio < desde);
        if (previos.length > 0 && diasEntre(previos[previos.length - 1]!.diaNegocio, desde) > config.activoDias) recuperados += 1;
      }
      netaPorCliente.push(enRango.reduce((s, p) => s + p.netaCentavos, 0));
    }
    netaPorCliente.sort((a, b) => b - a);
    const top = Math.ceil(netaPorCliente.length * 0.1);
    intervalos.sort((a, b) => a - b);
    return {
      propertyId, alcance, clientesConPedido, nuevos, recurrentes: clientesConPedido - nuevos, activos, dormidos, perdidos, frecuentes,
      multiSucursal: null, clientesVariasSucursales: null, recuperados, recuperadosPorCampana: 0, activosAlInicio: 0, pasanAPerdidos: 0,
      diasEntrePedidosMediana: intervalos.length === 0 ? null : intervalos[Math.floor(intervalos.length / 2)]!,
      netaTop10pctCentavos: netaPorCliente.slice(0, top).reduce((s, x) => s + x, 0),
      netaTotalCentavos: netaPorCliente.reduce((s, x) => s + x, 0),
      pedidosPorCliente12mPromedio: clientes12m === 0 ? null : Math.round((pedidos12m / clientes12m) * 100) / 100,
      pedidosConCliente: 0, pedidosSinCliente: 0,
    };
  };
  const filas = SUCURSALES_PM_SINTETICAS.map((s) => calcular("sucursal", s.propertyId, ventas.filter((p) => p.propertyId === s.propertyId)));
  const conjunto = calcular("conjunto", null, ventas);
  const suma = filas.reduce((s, f) => s + f.clientesConPedido, 0);
  return [...filas, { ...conjunto, multiSucursal: suma - conjunto.clientesConPedido }];
}

// ---- Agente, comandas, agotados ----------------------------------------------------------------------------------------------------------

export function generarAgenteDiario(pedidos: readonly PedidoSintetico[], semilla = 7): FilaAgenteDiario[] {
  const rnd = mulberry32(semilla);
  const porClave = new Map<string, { wa: number; voz: number }>();
  for (const p of pedidos) {
    if (!esVenta(p)) continue;
    const k = `${p.propertyId}|${p.diaNegocio}`;
    const prev = porClave.get(k) ?? { wa: 0, voz: 0 };
    if (p.source === "whatsapp") prev.wa += 1; else prev.voz += 1;
    porClave.set(k, prev);
  }
  const tc = TIPO_CAMBIO_SINTETICO_MXN_POR_USD;
  const centavos = (micro: number): number => Math.round((micro * tc) / 10_000);
  const filas: FilaAgenteDiario[] = [];
  const diasVistos = new Set<string>();
  for (const [k, v] of [...porClave.entries()].sort(([a], [b]) => cmp(a, b))) {
    const [propertyId, diaNegocio] = k.split("|") as [string, string];
    diasVistos.add(diaNegocio);
    const waConv = Math.max(v.wa, Math.round((v.wa / 0.3) * (0.9 + rnd() * 0.2)));
    const llamadas = Math.max(v.voz, Math.round((v.voz / 0.55) * (0.9 + rnd() * 0.2)));
    const escalado = Math.min(llamadas - v.voz, Math.round(llamadas * 0.1));
    const costoVoz = llamadas * 150_000;
    const costoTel = llamadas * 20_000;
    filas.push({
      propertyId, diaNegocio,
      waConversacionesNuevas: waConv, waConPedido: v.wa, waConHandoff: Math.round(waConv * 0.05), waHandoffs: Math.round(waConv * 0.06),
      vozLlamadas: llamadas, vozPedidoCreado: v.voz, vozEscalado: escalado, vozAbandonado: llamadas - v.voz - escalado,
      costoVozMicroUsd: costoVoz, costoTelefoniaMicroUsd: costoTel, costoMetaMicroUsd: null, costoLlmMicroUsd: null,
      costoVozCentavos: centavos(costoVoz), costoTelefoniaCentavos: centavos(costoTel), costoMetaCentavos: null, costoLlmCentavos: null, metaEventos: 0, mxnPorUsd: TIPO_CAMBIO_SINTETICO_MXN_POR_USD,
    });
  }
  // Renglón «No asignado» por día: LLM de texto de la organización.
  for (const diaNegocio of [...diasVistos].sort()) {
    const llm = 250_000 + Math.floor(rnd() * 100_000);
    filas.push({
      propertyId: null, diaNegocio,
      waConversacionesNuevas: 0, waConPedido: 0, waConHandoff: 0, waHandoffs: 0, vozLlamadas: 0, vozPedidoCreado: 0, vozEscalado: 0, vozAbandonado: 0,
      costoVozMicroUsd: 0, costoTelefoniaMicroUsd: 0, costoMetaMicroUsd: null, costoLlmMicroUsd: llm,
      costoVozCentavos: null, costoTelefoniaCentavos: null, costoMetaCentavos: null, costoLlmCentavos: centavos(llm), metaEventos: 0, mxnPorUsd: TIPO_CAMBIO_SINTETICO_MXN_POR_USD,
    });
  }
  return filas;
}

export function generarComandasPos(pedidos: readonly PedidoSintetico[], modo = "sombra", semilla = 11): FilaComandasPos[] {
  const rnd = mulberry32(semilla);
  const m = new Map<string, number>();
  for (const p of pedidos) if (esVenta(p)) m.set(`${p.propertyId}|${p.diaNegocio}`, (m.get(`${p.propertyId}|${p.diaNegocio}`) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => cmp(a, b)).map(([k, n]) => {
    const [propertyId, diaNegocio] = k.split("|") as [string, string];
    const confirmadas = Math.round(n * 0.1);
    const capturadas = Math.round(n * (0.8 + rnd() * 0.15));
    const pendientes = Math.max(0, n - confirmadas - capturadas);
    return {
      propertyId, diaNegocio, modo, encoladas: n, confirmadas, capturadasManual: capturadas, capturaManualPendientes: pendientes, fallidas: 0, pendientesEnviadas: 0,
      minACapturaSuma: Math.round(capturadas * 4.37 * 100) / 100, capturadasConTiempo: capturadas, vencidasUmbral: pendientes > 2 ? 1 : 0, conFolioPos: confirmadas, conFolioDeclarado: Math.round(capturadas * 0.5),
    };
  });
}

export function generarAgotados(pedidos: readonly PedidoSintetico[], hasta: string): FilaAgotado[] {
  const ult28 = pedidos.filter((p) => esVenta(p) && diasEntre(p.diaNegocio, hasta) < 28);
  const out: FilaAgotado[] = [];
  for (const suc of SUCURSALES_PM_SINTETICAS) {
    const unidades = new Map<string, number>();
    for (const p of ult28) if (p.propertyId === suc.propertyId) for (const it of p.items) unidades.set(it.ref, (unidades.get(it.ref) ?? 0) + it.cantidad);
    const orden = [...unidades.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
    orden.forEach(([ref, u], i) => {
      const prod = PRODUCTOS_SINTETICOS.find((x) => x.ref === ref)!;
      out.push({ propertyId: suc.propertyId, productId: ref, nombre: prod.nombre, disponible: true, agotadoHasta: null, unidades28d: u, diasConVenta28d: 28, precioListaCentavos: prod.precio, rankingUnidades: i + 1 });
    });
  }
  return out;
}

// ---- Costos capturados SINTÉTICOS --------------------------------------------------------------------------------------------------------

/** Costos del mes (`YYYY-MM-01`) para las sucursales dadas. T3 NO captura nómina a propósito (para probar «captura pendiente»). */
export function costosCapturadosSinteticos(mes: string): FilaCostoCaptura[] {
  const out: FilaCostoCaptura[] = [];
  for (const s of SUCURSALES_PM_SINTETICAS) {
    out.push({ propertyId: s.propertyId, mes, concepto: "insumos", montoCentavos: 30_000_000, pct: null });
    if (s.codigo !== "T3") out.push({ propertyId: s.propertyId, mes, concepto: "nomina", montoCentavos: 25_000_000, pct: null });
    out.push({ propertyId: s.propertyId, mes, concepto: "renta", montoCentavos: 8_000_000, pct: null });
    out.push({ propertyId: s.propertyId, mes, concepto: "servicios", montoCentavos: 3_000_000, pct: null });
    out.push({ propertyId: s.propertyId, mes, concepto: "otros", montoCentavos: 1_000_000, pct: null });
    out.push({ propertyId: s.propertyId, mes, concepto: "comision_terminal", montoCentavos: 900_000, pct: null });
  }
  return out;
}

// ---- SoftRestaurant SINTÉTICO ------------------------------------------------------------------------------------------------------------

/** Resumen por tipo de servicio de SR (SINTÉTICO): el domicilio y el recoger del agente son un SUBCONJUNTO de «domicilio» y «para llevar» de SR. */
export function generarSrResumen(pedidos: readonly PedidoSintetico[], semilla = 13): FilaSrResumen[] {
  const rnd = mulberry32(semilla);
  const agente = new Map<string, { dom: number; rec: number }>();
  for (const p of pedidos) {
    if (!esVenta(p)) continue;
    const k = `${p.propertyId}|${p.diaNegocio}`;
    const prev = agente.get(k) ?? { dom: 0, rec: 0 };
    if (p.canal === "domicilio") prev.dom += p.netaCentavos; else prev.rec += p.netaCentavos;
    agente.set(k, prev);
  }
  const filas: FilaSrResumen[] = [];
  for (const [k, a] of [...agente.entries()].sort(([x], [y]) => cmp(x, y))) {
    const [propertyId, diaNegocio] = k.split("|") as [string, string];
    const base = (tipo: TipoServicioSr, neta: number, tarjetaPct: number): void => {
      for (const forma of ["efectivo", "tarjeta"] as const) {
        const parte = forma === "tarjeta" ? divR(neta * tarjetaPct, 100) : neta - divR(neta * tarjetaPct, 100);
        if (parte <= 0) continue;
        const desc = divR(parte * 4, 100);
        filas.push({
          propertyId, diaNegocio, tipoServicio: tipo, formaPago: forma, tickets: Math.max(1, divR(parte, 28_000)),
          brutaCentavos: parte + desc, descuentoCentavos: desc, canceladoCentavos: divR(parte * 2, 100),
          propinaCentavos: forma === "tarjeta" && tipo === "comedor" ? divR(parte * 6, 100) : 0, ivaCentavos: null, netaCentavos: parte,
        });
      }
    };
    base("domicilio", divR(a.dom * (112 + Math.floor(rnd() * 10)), 100), 40);
    base("para_llevar", divR(a.rec * (120 + Math.floor(rnd() * 10)), 100) + 150_000, 45);
    base("comedor", 6_000_000 + Math.floor(rnd() * 3_000_000), 55);
    base("rapido", 400_000 + Math.floor(rnd() * 200_000), 30);
  }
  return filas;
}

// ---- Cuentas de SR SINTÉTICAS (una sucursal, una semana) y sus exports ------------------------------------------------------------------------

export interface CuentaSinteticaCsv {
  readonly ticket: FilaSrTicket;
  /** Fecha calendario dd/mm/aaaa y hora HH:MM como las imprimiría SR. */
  readonly fechaCalendario: string;
  readonly hora: string;
  readonly subtotalCentavos: number;
}

function ddmmaaaa(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

function dinero(centavos: number, conSigno: boolean): string {
  const p = Math.floor(centavos / 100);
  const c = String(centavos % 100).padStart(2, "0");
  const miles = String(p).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return conSigno ? `$${miles}.${c}` : `${p}.${c}`;
}

export function generarCuentasSr(propertyId: string, codigo: string, desdeDia: string, dias: number, semilla = 17): CuentaSinteticaCsv[] {
  const rnd = mulberry32(semilla);
  const out: CuentaSinteticaCsv[] = [];
  let folio = 0;
  const servicios: readonly TipoServicioSr[] = ["comedor", "para_llevar", "domicilio", "rapido"];
  for (let k = 0; k < dias; k++) {
    const dia = sumarDias(desdeDia, k);
    const tickets = 25 + Math.floor(rnd() * 15);
    for (let i = 0; i < tickets; i++) {
      folio += 1;
      const tipo = servicios[Math.floor(rnd() * servicios.length)]!;
      const hora = [0, 12, 13, 14, 15, 18, 19, 20, 21, 22][Math.floor(rnd() * 10)]!;
      const min = Math.floor(rnd() * 60);
      const subtotal = 8_000 + Math.floor(rnd() * 60_000);
      const desc = rnd() < 0.15 ? divR(subtotal * 10, 100) : 0;
      const total = subtotal - desc;
      const cancelado = rnd() < 0.04;
      const pago = rnd() < 0.5 ? "Efectivo" : "Tarjeta";
      const fechaCal = hora === 0 ? sumarDias(dia, 1) : dia;
      out.push({
        fechaCalendario: ddmmaaaa(fechaCal),
        hora: `${String(hora).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
        subtotalCentavos: subtotal,
        ticket: {
          propertyId, folio: `${codigo}-${String(folio).padStart(5, "0")}`, diaNegocio: dia, horaLocal: `${String(hora).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
          tipoServicio: tipo, totalCentavos: total, descuentoCentavos: desc, propinaCentavos: pago === "Tarjeta" && !cancelado ? divR(total * 10, 100) : 0, formaPago: pago.toLowerCase(), cancelado,
        },
      });
    }
  }
  return out;
}

const ETIQUETA_SERVICIO_CSV: Readonly<Record<TipoServicioSr, string>> = { comedor: "Comedor", para_llevar: "Para llevar", domicilio: "A domicilio", rapido: "Rápido", otro: "Drive thru" };

/** Sucursal T2, 7 días terminando en 2026-09-27. */
const T2 = SUCURSALES_PM_SINTETICAS[1]!;
export const CUENTAS_SR_SINTETICAS: readonly CuentaSinteticaCsv[] = generarCuentasSr(T2.propertyId, T2.codigo, "2026-09-21", 7);

/** Verdad esperada tras normalizar `CSV_SR_SINTETICO` (con corte 01:00). */
export const TICKETS_SR_ESPERADOS: readonly FilaSrTicket[] = CUENTAS_SR_SINTETICAS.map((c) => c.ticket);

const ENCABEZADO_CUENTAS = ["Folio", "Fecha", "Hora", "Tipo de servicio", "Subtotal", "Descuento", "Propina", "Total", "Forma de pago", "Cancelada"];

function csvCelda(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Layout «cuentas» como CSV (SINTÉTICO): primera línea de título, montos con «$» y comas de millar, fechas dd/mm/aaaa. Sin datos de clientes. */
export const CSV_SR_SINTETICO: string = [
  csvCelda(ETIQUETA_SINTETICO),
  ENCABEZADO_CUENTAS.join(","),
  ...CUENTAS_SR_SINTETICAS.map((c) =>
    [
      c.ticket.folio, c.fechaCalendario, c.hora, ETIQUETA_SERVICIO_CSV[c.ticket.tipoServicio], dinero(c.subtotalCentavos, true), dinero(c.ticket.descuentoCentavos, true),
      dinero(c.ticket.propinaCentavos, true), dinero(c.ticket.totalCentavos, true), c.ticket.formaPago === "tarjeta" ? "Tarjeta" : "Efectivo", c.ticket.cancelado ? "Sí" : "No",
    ].map(csvCelda).join(","),
  ),
].join("\r\n");

/** Layout «resumen por tipo de servicio» como filas de XLSX (SINTÉTICO): título, encabezado, montos con coma decimal y fechas aaaa-mm-dd. */
export const RESUMEN_SR_SINTETICO_ESPERADO: readonly FilaSrResumen[] = (() => {
  const t2 = SUCURSALES_PM_SINTETICAS[1]!;
  const porLlave = new Map<string, FilaSrResumen>();
  for (const c of CUENTAS_SR_SINTETICAS) {
    if (c.ticket.cancelado) continue;
    const k = `${c.ticket.diaNegocio}|${c.ticket.tipoServicio}`;
    const p = porLlave.get(k);
    porLlave.set(k, {
      propertyId: t2.propertyId, diaNegocio: c.ticket.diaNegocio, tipoServicio: c.ticket.tipoServicio, formaPago: null,
      tickets: (p?.tickets ?? 0) + 1, brutaCentavos: (p?.brutaCentavos ?? 0) + c.subtotalCentavos, descuentoCentavos: (p?.descuentoCentavos ?? 0) + c.ticket.descuentoCentavos,
      canceladoCentavos: 0, propinaCentavos: (p?.propinaCentavos ?? 0) + c.ticket.propinaCentavos, ivaCentavos: null, netaCentavos: (p?.netaCentavos ?? 0) + c.ticket.totalCentavos,
    });
  }
  return [...porLlave.values()].sort((a, b) => cmp(a.diaNegocio, b.diaNegocio) || cmp(a.tipoServicio, b.tipoServicio));
})();

export const filasXlsxSrSintetico: string[][] = [
  [ETIQUETA_SINTETICO],
  ["Fecha", "Tipo de servicio", "Cuentas", "Subtotal", "Descuento", "Propina", "Total"],
  ...RESUMEN_SR_SINTETICO_ESPERADO.map((r) => [
    r.diaNegocio, ETIQUETA_SERVICIO_CSV[r.tipoServicio], String(r.tickets), dinero(r.brutaCentavos, false).replace(".", ","), dinero(r.descuentoCentavos, false).replace(".", ","),
    dinero(r.propinaCentavos, false).replace(".", ","), dinero(r.netaCentavos, false).replace(".", ","),
  ]),
];

// ---- Dataset completo --------------------------------------------------------------------------------------------------------------------

export interface DatasetSintetico {
  readonly sucursales: readonly SucursalSintetica[];
  readonly config: CfoConfig;
  readonly desde: string;
  readonly hasta: string;
  readonly pedidos: readonly PedidoSintetico[];
  readonly ventasDiarias: readonly FilaVentasDiarias[];
  readonly cortesias: readonly FilaCortesias[];
  readonly ventasHora: readonly FilaVentasHora[];
  readonly productos: readonly FilaProducto[];
  readonly clientes: readonly FilaClientesResumen[];
  readonly agenteDiario: readonly FilaAgenteDiario[];
  readonly comandasPos: readonly FilaComandasPos[];
  readonly agotados: readonly FilaAgotado[];
  readonly srResumen: readonly FilaSrResumen[];
}

export function generarDatasetSintetico(op: OpcionesSinteticas & { readonly diasRango?: number } = {}): DatasetSintetico {
  const hasta = op.hasta ?? "2026-09-27";
  const pedidos = generarPedidosSinteticos(op);
  const diasRango = op.diasRango ?? 28;
  const desde = sumarDias(hasta, -(diasRango - 1));
  const enRango = pedidos.filter((p) => p.diaNegocio >= desde && p.diaNegocio <= hasta);
  return {
    sucursales: SUCURSALES_PM_SINTETICAS,
    config: CFO_CONFIG_POR_DEFECTO,
    desde,
    hasta,
    pedidos,
    ventasDiarias: agregarVentasDiarias(enRango),
    cortesias: agregarCortesias(enRango),
    ventasHora: agregarVentasHora(enRango),
    productos: agregarProductos(enRango),
    clientes: resumirClientes(pedidos, desde, hasta),
    agenteDiario: generarAgenteDiario(enRango, op.semilla ?? 7),
    comandasPos: generarComandasPos(enRango),
    agotados: generarAgotados(pedidos, hasta),
    srResumen: generarSrResumen(enRango),
  };
}
