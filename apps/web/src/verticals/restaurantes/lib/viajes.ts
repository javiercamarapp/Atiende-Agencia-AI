// Reglas puras de la pantalla Viajes del encargado: seleccion de lote (maximo 6), chofer por omision y texto de carga. Sin DOM ni red.
import type { ViajesSalida } from "@atiende/domain-restaurantes/operacion";

export const MAX_LOTE = 6;
export const ETA_POR_OMISION_MIN = 35;

export type Chofer = ViajesSalida["repartidores"][number];

/** Agrega o quita `id` del lote. Si el lote ya tiene 6, un septimo se ignora (la pantalla lo avisa). */
export function alternarSeleccion(actual: readonly string[], id: string): readonly string[] {
  if (actual.includes(id)) return actual.filter((x) => x !== id);
  return actual.length >= MAX_LOTE ? actual : [...actual, id];
}

/** Quita de la seleccion lo que ya no esta por salir (otro encargado lo despacho, se cancelo). */
export function depurarSeleccion(actual: readonly string[], porSalirIds: readonly string[]): readonly string[] {
  const vigentes = new Set(porSalirIds);
  const nueva = actual.filter((id) => vigentes.has(id));
  return nueva.length === actual.length ? actual : nueva;
}

/** Chofer inicial: el sugerido por el servidor; si no hay, el primero disponible; si no, ninguno (la persona elige). */
export function choferInicial(repartidores: readonly Chofer[]): string | null {
  return repartidores.find((r) => r.sugerido && r.disponible)?.id ?? repartidores.find((r) => r.disponible)?.id ?? null;
}

export function etiquetaChofer(c: Chofer): string {
  const carga = c.activos === 1 ? "1 activo" : `${c.activos} activos`;
  return `${c.nombre} (${carga})${c.sugerido ? " · sugerido" : ""}${c.disponible ? "" : " · fuera de turno"}`;
}

export function textoBotonSalio(n: number): string {
  return n === 1 ? "Salió (1 pedido)" : `Salió (${n} pedidos)`;
}

export interface PedidoLote {
  readonly id: string;
  readonly numero: number;
  readonly estado: string;
}

/** `desdeEstado` del despacho: el estado REAL de los pedidos del lote. Solo `preparando` existe en el contrato; si algun pedido esta en otro estado no se manda (el servidor decide y responde `estado_cambio`). */
export function desdeEstadoDe(lote: readonly PedidoLote[]): "preparando" | undefined {
  return lote.length > 0 && lote.every((p) => p.estado === "preparando") ? "preparando" : undefined;
}

export interface ResultadoLote {
  readonly pedidoId: string;
  readonly resultado: "despachado" | "ya_aplicado" | "reasignado";
  readonly aviso: string;
}

export interface ResumenLote {
  readonly salieron: readonly number[];
  readonly yaEstaban: readonly number[];
  readonly reasignados: readonly number[];
  /** Pedidos del lote que el servidor NO reporto: no se asume que salieron. */
  readonly sinRespuesta: readonly number[];
  readonly sinAviso: number;
}

/** Cruza lo enviado con lo que respondio el servidor: nada se cuenta como «salio» si no vino `despachado`. */
export function resumirLote(lote: readonly PedidoLote[], resultados: readonly ResultadoLote[]): ResumenLote {
  const por = new Map(resultados.map((r) => [r.pedidoId, r]));
  const salieron: number[] = [];
  const yaEstaban: number[] = [];
  const reasignados: number[] = [];
  const sinRespuesta: number[] = [];
  let sinAviso = 0;
  for (const p of lote) {
    const r = por.get(p.id);
    if (!r) sinRespuesta.push(p.numero);
    else if (r.resultado === "despachado") salieron.push(p.numero);
    else if (r.resultado === "ya_aplicado") yaEstaban.push(p.numero);
    else reasignados.push(p.numero);
    if (r && r.resultado === "despachado" && r.aviso.startsWith("omitido")) sinAviso += 1;
  }
  return { salieron, yaEstaban, reasignados, sinRespuesta, sinAviso };
}

const lista = (n: readonly number[]) => n.map((x) => `#${x}`).join(", ");

/** Mensajes para la persona: uno de exito (si salio alguno) y uno de atencion por cada grupo que NO salio. */
export function mensajesLote(r: ResumenLote, chofer: string): { readonly exito: string | null; readonly atencion: readonly string[] } {
  const atencion: string[] = [];
  if (r.sinRespuesta.length > 0) atencion.push(`El servidor no confirmó ${r.sinRespuesta.length === 1 ? "el pedido" : "los pedidos"} ${lista(r.sinRespuesta)}: revisa en «En camino» antes de volver a intentar.`);
  if (r.yaEstaban.length > 0) atencion.push(`${lista(r.yaEstaban)} ya estaba${r.yaEstaban.length === 1 ? "" : "n"} en camino con ${chofer}.`);
  if (r.reasignados.length > 0) atencion.push(`${lista(r.reasignados)} se reasignó${r.reasignados.length === 1 ? "" : "aron"} a ${chofer}.`);
  if (r.sinAviso > 0) atencion.push(`${r.sinAviso === 1 ? "1 cliente quedó" : `${r.sinAviso} clientes quedaron`} sin aviso por WhatsApp: avísales por llamada.`);
  const exito = r.salieron.length > 0 ? `${r.salieron.length === 1 ? `El pedido ${lista(r.salieron)} salió` : `Los pedidos ${lista(r.salieron)} salieron`} con ${chofer}.` : null;
  return { exito, atencion };
}

/** 409 `estado_cambio`: dice cual pedido cambio si el servidor lo informa (`details.pedidoId`), si no, avisa del lote completo (el despacho es todo o nada). */
export function textoEstadoCambio(lote: readonly PedidoLote[], details: Readonly<Record<string, string>> | null): string {
  const culpable = details?.["pedidoId"] ? lote.find((p) => p.id === details["pedidoId"]) : undefined;
  return culpable
    ? `El pedido #${culpable.numero} ya cambió de estado y nada salió. Se actualizó la lista: revisa y vuelve a elegir.`
    : "Alguno de los pedidos ya cambió de estado y nada salió. Se actualizó la lista: revisa y vuelve a elegir.";
}
