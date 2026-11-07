// Reglas puras de la pantalla Viajes del encargado: seleccion de lote (maximo 6), chofer por omision y texto de carga. Sin DOM ni red.
import type { ViajesSalida } from "@atiende/domain-restaurantes/operacion";
import { traductorActivo } from "@atiende/ui";
import { restaurantesViajes } from "@atiende/ui/i18n/restaurantes/viajes";

const tr = traductorActivo(restaurantesViajes);

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
  const carga = tr("restaurantes.viajes.activos", { count: c.activos });
  return `${c.nombre} (${carga})${c.sugerido ? tr("restaurantes.viajes.sugerido") : ""}${c.disponible ? "" : tr("restaurantes.viajes.fueraDeTurnoSufijo")}`;
}

export function textoBotonSalio(n: number): string {
  return tr("restaurantes.viajes.salio", { count: n });
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
  if (r.sinRespuesta.length > 0) atencion.push(tr("restaurantes.viajes.sinRespuesta", { count: r.sinRespuesta.length, lista: lista(r.sinRespuesta) }));
  if (r.yaEstaban.length > 0) atencion.push(tr("restaurantes.viajes.yaEstaban", { count: r.yaEstaban.length, lista: lista(r.yaEstaban), chofer }));
  if (r.reasignados.length > 0) atencion.push(tr("restaurantes.viajes.reasignados", { count: r.reasignados.length, lista: lista(r.reasignados), chofer }));
  if (r.sinAviso > 0) atencion.push(tr("restaurantes.viajes.sinAviso", { count: r.sinAviso }));
  const exito = r.salieron.length > 0 ? tr("restaurantes.viajes.exito", { count: r.salieron.length, lista: lista(r.salieron), chofer }) : null;
  return { exito, atencion };
}

/** 409 `estado_cambio`: dice cual pedido cambio si el servidor lo informa (`details.pedidoId`), si no, avisa del lote completo (el despacho es todo o nada). */
export function textoEstadoCambio(lote: readonly PedidoLote[], details: Readonly<Record<string, string>> | null): string {
  const culpable = details?.["pedidoId"] ? lote.find((p) => p.id === details["pedidoId"]) : undefined;
  return culpable ? tr("restaurantes.viajes.estadoCambioUno", { numero: String(culpable.numero) }) : tr("restaurantes.viajes.estadoCambioLote");

}
