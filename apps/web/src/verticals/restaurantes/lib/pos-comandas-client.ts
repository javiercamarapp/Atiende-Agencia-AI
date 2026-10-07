// Comandas al POS (captura asistida de SoftRestaurant) -- cliente de las rutas de
// apps/api/.../restaurantes/admin-softrestaurant.ts. Los tipos replican la forma del servidor (apps/web no depende de los
// paquetes de dominio, mismo criterio que orders-client.ts). Las funciones puras (texto para el POS, mascara de telefono,
// antiguedad, etiqueta de estado) viven aqui para poder probarlas sin pintar nada.
import { horaEsMx } from "../../../lib/formato-fecha.ts";
import { fetchJson, sendJson } from "./admin-client.ts";

export type EstadoComandaWire = "pendiente" | "enviada" | "confirmada" | "fallida" | "captura_manual" | "capturada_manual";
export type ModoPos = "apagado" | "sombra" | "activo";

export interface ItemComandaWire {
  readonly codigo: string;
  readonly cantidad: number;
  readonly nombre?: string;
  readonly nota?: string;
  readonly modificadores: ReadonlyArray<{ readonly codigo: string; readonly nombre?: string }>;
}

export interface ComandaPayloadWire {
  readonly sucursal: string;
  readonly tipo: "domicilio" | "recoger";
  readonly cliente: { readonly nombre: string; readonly telefono: string };
  readonly direccion?: { readonly texto: string; readonly colonia?: string; readonly referencias?: string };
  readonly formaPago: "efectivo" | "tarjeta";
  readonly propina?: number;
  readonly items: readonly ItemComandaWire[];
  readonly notas?: string;
  readonly horaCompromiso?: string;
}

export interface ComandaWire {
  readonly id: string;
  readonly propertyId: string;
  readonly orderId: string;
  readonly estado: EstadoComandaWire;
  readonly intentos: number;
  readonly maxIntentos: number;
  readonly folio: string | null;
  readonly ultimoError: string | null;
  readonly notaCaptura: string | null;
  readonly capturadoEn: string | null;
  readonly creadoEn: string;
  /** Total del pedido en Atiende; `null` si el pedido ya no se encuentra. */
  readonly totalPedido: number | null;
  readonly comanda: ComandaPayloadWire;
}

export interface ComandasWire {
  /** `false` = la base aun no tiene la migracion 024. */
  readonly disponible: boolean;
  readonly comandas: readonly ComandaWire[];
  readonly resumen: Readonly<Record<EstadoComandaWire, number>>;
  readonly requierenAtencion: number;
}

export interface ConfigPosWire {
  readonly modo: ModoPos;
  readonly disponible: boolean;
  readonly adaptador: { readonly nombre: string; readonly esReal: boolean };
  readonly umbralCapturaManual: {
    readonly porOmisionMin: number;
    readonly minimo: number;
    readonly maximo: number;
    /** `false` = la base aun no tiene la migracion 054: el umbral no se puede configurar. */
    readonly disponible: boolean;
    readonly porSucursal: Readonly<Record<string, number>>;
  };
}

const base = (propertyId: string) => `/v1/restaurantes/${propertyId}/admin/softrestaurant`;

export async function fetchConfigPos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ConfigPosWire> {
  return fetchJson<ConfigPosWire>(fetchImpl, `${apiBaseUrl}${base(propertyId)}/config`, token);
}

export async function fijarModoPos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, modo: ModoPos): Promise<{ readonly modo: ModoPos }> {
  return sendJson(fetchImpl, `${apiBaseUrl}${base(propertyId)}/config`, token, "PUT", { modo });
}

export async function fetchComandas(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  opts: { readonly estados?: readonly EstadoComandaWire[]; readonly branchId?: string; readonly limit?: number; readonly offset?: number } = {},
): Promise<ComandasWire> {
  const params = new URLSearchParams();
  if (opts.estados && opts.estados.length > 0) params.set("estado", opts.estados.join(","));
  if (opts.branchId) params.set("branchId", opts.branchId);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return fetchJson<ComandasWire>(fetchImpl, `${apiBaseUrl}${base(propertyId)}/comandas${qs ? `?${qs}` : ""}`, token);
}

export async function marcarComandaCapturada(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  comandaId: string,
  nota: string | null,
): Promise<{ readonly comanda: ComandaWire }> {
  return sendJson(fetchImpl, `${apiBaseUrl}${base(propertyId)}/comandas/${comandaId}/capturada`, token, "POST", nota ? { nota } : {});
}

export async function fijarUmbralCapturaManual(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  branchId: string,
  minutos: number,
): Promise<{ readonly branchId: string; readonly minutos: number }> {
  return sendJson(fetchImpl, `${apiBaseUrl}${base(propertyId)}/umbral-captura-manual`, token, "PUT", { branchId, minutos });
}

/** Estado de la comanda de cada pedido (hasta 100 ids por consulta); los pedidos sin comanda no aparecen. */
export async function fetchEstadosComandaPorPedido(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  orderIds: readonly string[],
): Promise<{ readonly disponible: boolean; readonly estados: Readonly<Record<string, EstadoComandaWire>> }> {
  if (orderIds.length === 0) return { disponible: true, estados: {} };
  return fetchJson(fetchImpl, `${apiBaseUrl}${base(propertyId)}/estados?orderIds=${orderIds.slice(0, 100).join(",")}`, token);
}

// ---- Puro ------------------------------------------------------------------------------------------------------------------------

export const ESTADOS_FILTRO_POR_DEFECTO: readonly EstadoComandaWire[] = ["captura_manual", "fallida", "pendiente", "enviada"];

export const ETIQUETA_ESTADO_COMANDA: Readonly<Record<EstadoComandaWire, string>> = {
  captura_manual: "Capturar a mano",
  fallida: "Falló",
  pendiente: "Pendiente",
  enviada: "Enviando al POS",
  confirmada: "En POS",
  capturada_manual: "Capturada a mano",
};

export const TONO_ESTADO_COMANDA: Readonly<Record<EstadoComandaWire, "neutral" | "info" | "success" | "warning" | "danger">> = {
  captura_manual: "warning",
  fallida: "danger",
  pendiente: "neutral",
  enviada: "info",
  confirmada: "success",
  capturada_manual: "success",
};

/** Insignia de la comanda dentro de Pedidos: confirmada y capturada a mano = "En POS". */
export function etiquetaInsigniaPedido(estado: EstadoComandaWire): string {
  if (estado === "confirmada" || estado === "capturada_manual") return "En POS";
  if (estado === "captura_manual") return "Capturar a mano";
  if (estado === "fallida") return "Falló";
  return "Enviando al POS";
}

/** Solo los ultimos 4 digitos ("******1234"); para pantalla, nunca para copiar. */
export function telefonoEnmascarado(telefono: string): string {
  const digitos = telefono.replace(/\D/g, "");
  if (digitos.length < 4) return "*".repeat(Math.max(digitos.length, 4));
  return `${"*".repeat(digitos.length - 4)}${digitos.slice(-4)}`;
}

/** Referencia corta del pedido de Atiende (8 caracteres del id). */
export function referenciaPedido(orderId: string): string {
  return orderId.replace(/-/g, "").slice(0, 8).toUpperCase();
}

export function antiguedadTexto(desdeIso: string, ahoraMs: number): string {
  const min = Math.max(0, Math.floor((ahoraMs - Date.parse(desdeIso)) / 60_000));
  if (min < 1) return "hace menos de 1 min";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h ${min % 60} min`;
  return `hace ${Math.floor(h / 24)} d`;
}

function pesos(n: number): string {
  return n.toFixed(2);
}

/**
 * Texto plano en el orden en que se captura una comanda en SoftRestaurant: sucursal y tipo, cliente (con telefono completo: es
 * lo que se teclea), direccion, renglones con SU CODIGO POS y modificadores, forma de pago, propina y notas. Sin cobros ni
 * montos de total: la comanda nunca cobra (el cobro lo hace caja o el repartidor).
 */
export function textoParaPos(c: ComandaWire): string {
  const p = c.comanda;
  const lineas: string[] = [];
  lineas.push(`COMANDA ${referenciaPedido(c.orderId)} - SUCURSAL ${p.sucursal} - ${p.tipo === "domicilio" ? "DOMICILIO" : "PARA RECOGER"}`);
  lineas.push(`Cliente: ${p.cliente.nombre}`);
  lineas.push(`Telefono: ${p.cliente.telefono}`);
  if (p.tipo === "domicilio" && p.direccion) {
    lineas.push(`Direccion: ${p.direccion.texto}`);
    if (p.direccion.colonia) lineas.push(`Colonia: ${p.direccion.colonia}`);
    if (p.direccion.referencias) lineas.push(`Referencias: ${p.direccion.referencias}`);
  }
  if (p.horaCompromiso) lineas.push(`Hora: ${horaEsMx(p.horaCompromiso)}`);
  lineas.push("");
  p.items.forEach((it, i) => {
    lineas.push(`${i + 1}. ${it.cantidad} x ${it.codigo}${it.nombre ? ` (${it.nombre})` : ""}`);
    for (const m of it.modificadores) lineas.push(`   + ${m.codigo}${m.nombre ? ` (${m.nombre})` : ""}`);
    if (it.nota) lineas.push(`   Nota: ${it.nota}`);
  });
  lineas.push("");
  lineas.push(`Forma de pago: ${p.formaPago === "tarjeta" ? "Tarjeta" : "Efectivo"}`);
  if (p.propina !== undefined && p.propina > 0) lineas.push(`Propina: $${pesos(p.propina)} (solo con tarjeta)`);
  if (p.notas) lineas.push(`Notas: ${p.notas}`);
  return lineas.join("\n");
}
