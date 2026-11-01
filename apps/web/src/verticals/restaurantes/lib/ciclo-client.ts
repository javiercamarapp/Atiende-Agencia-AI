// Cliente del ciclo operativo del pedido (F4b; migraciones 170 a 172): aceptar/rechazar con tiempo prometido y motivo, salida con repartidor, entrega con hora real,
// ratios de operacion y configuracion de encuesta y recordatorios. Los TIPOS son locales (apps/web no empaqueta codigo de los paquetes domain-*); el servidor
// re-valida rol, alcance y rangos. Las escrituras mandan `Idempotency-Key` por costumbre del panel (estas rutas no la leen: la idempotencia la da el servidor).
import { enviar, leer } from "./operacion-client.ts";
import { sendJson } from "./admin-client.ts";

export const MOTIVOS_RECHAZO = ["sin_insumos", "cerrado", "fuera_de_zona", "saturado", "datos_incompletos", "otro"] as const;
export type MotivoRechazo = (typeof MOTIVOS_RECHAZO)[number];
export const ETIQUETA_MOTIVO_RECHAZO: Readonly<Record<MotivoRechazo, string>> = {
  sin_insumos: "Faltan productos o insumos",
  cerrado: "La sucursal está cerrada",
  fuera_de_zona: "Domicilio fuera de zona",
  saturado: "Cocina saturada",
  datos_incompletos: "Faltan datos del pedido",
  otro: "Otro motivo",
};

export const TIEMPO_PROMETIDO_MIN = 5;
export const TIEMPO_PROMETIDO_MAX = 240;
export const TIEMPO_PROMETIDO_POR_OMISION = { domicilio: 45, recoger: 20 } as const;

export interface AvisoCliente {
  readonly encolado: boolean;
  readonly motivo?: "sin_telefono" | "sin_canal_whatsapp" | "error";
}
export interface RespuestaAceptar {
  readonly resultado: "aceptado" | "ya_aplicado";
  readonly aceptadoAt: string;
  readonly tiempoPrometidoMin: number;
  readonly aviso: AvisoCliente;
}
export interface RespuestaRechazar {
  readonly resultado: "rechazado" | "ya_aplicado";
  readonly rechazadoAt: string;
  readonly motivo: MotivoRechazo;
  readonly aviso: AvisoCliente;
}
export interface RespuestaSalida {
  readonly resultado: "despachado" | "ya_aplicado" | "reasignado";
  readonly salioAt: string | null;
  readonly repartidorId: string;
  /** `false` = la base aun no tiene la actualizacion de despacho: la salida se hizo pero sin hora real. */
  readonly horaRealRegistrada: boolean;
}
export interface RespuestaEntrega {
  readonly resultado: "entregado" | "ya_aplicado";
  readonly entregadoAt: string;
  readonly minutosDesdeAceptado: number | null;
  readonly tiempoPrometidoMin: number | null;
}
export interface RatiosOperacion {
  readonly tasaAceptacionPct: number | null;
  readonly tasaRechazoPct: number | null;
  readonly cumplimientoPromesaPct: number | null;
  readonly desvioMinProm: number | null;
  readonly aceptacionSegProm: number | null;
  readonly salidaMinProm: number | null;
  readonly encuesta: {
    readonly tasaRespuestaPct: number | null;
    readonly promedio: number | null;
    readonly pctBajas: number | null;
    readonly tasaOptOutPct: number | null;
    readonly enviadas: number;
    readonly respondidas: number;
  };
}
export interface RespuestaRatios {
  readonly disponible: boolean;
  readonly desde: string;
  readonly hasta: string;
  readonly ratios: RatiosOperacion | null;
  readonly detalle: { readonly tiempos: boolean; readonly encuesta: boolean };
}
export interface ConfigEncuesta {
  readonly disponible: boolean;
  readonly habilitada: boolean;
}
export interface ConfigRecordatorios {
  readonly disponible: boolean;
  readonly habilitado: boolean;
  readonly primeroMin: number;
  readonly repetirMin: number;
  readonly maximo: number;
}

function base(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/v1/restaurantes/${encodeURIComponent(propertyId)}/admin/ciclo`;
}
function pedido(apiBaseUrl: string, propertyId: string, orderId: string, accion: string): string {
  return `${base(apiBaseUrl, propertyId)}/pedidos/${encodeURIComponent(orderId)}/${accion}`;
}

export function aceptarConTiempo(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string, tiempoPrometidoMin: number, llave: string): Promise<RespuestaAceptar> {
  return enviar(fetchImpl, pedido(apiBaseUrl, propertyId, orderId, "aceptar"), token, "POST", { tiempoPrometidoMin }, llave);
}
export function rechazarConMotivo(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string, motivo: MotivoRechazo, nota: string, llave: string): Promise<RespuestaRechazar> {
  return enviar(fetchImpl, pedido(apiBaseUrl, propertyId, orderId, "rechazar"), token, "POST", { motivo, ...(nota.trim() ? { nota: nota.trim() } : {}) }, llave);
}
export function registrarSalidaConChofer(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string, repartidorId: string, etaMin: number, llave: string): Promise<RespuestaSalida> {
  return enviar(fetchImpl, pedido(apiBaseUrl, propertyId, orderId, "salida"), token, "POST", { repartidorId, etaMin }, llave);
}
/** `ocurrioEn` (ISO) = la hora real si la entrega ya ocurrio hace un rato; ausente = ahora. */
export function registrarEntregaReal(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string, ocurrioEn: string | null, llave: string): Promise<RespuestaEntrega> {
  return enviar(fetchImpl, pedido(apiBaseUrl, propertyId, orderId, "entrega"), token, "POST", ocurrioEn ? { ocurrioEn } : {}, llave);
}
export function fetchRatios(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<RespuestaRatios> {
  return leer<RespuestaRatios>(fetchImpl, `${base(apiBaseUrl, propertyId)}/ratios`, token);
}
export function fetchConfigEncuesta(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ConfigEncuesta> {
  return leer<ConfigEncuesta>(fetchImpl, `${base(apiBaseUrl, propertyId)}/encuesta/config`, token);
}
export function guardarConfigEncuesta(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, habilitada: boolean): Promise<{ readonly ok: boolean }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/encuesta/config`, token, "PUT", { habilitada });
}
export function fetchConfigRecordatorios(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ConfigRecordatorios> {
  return leer<ConfigRecordatorios>(fetchImpl, `${base(apiBaseUrl, propertyId)}/recordatorios/config`, token);
}
export function guardarConfigRecordatorios(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, c: Omit<ConfigRecordatorios, "disponible">): Promise<{ readonly ok: boolean }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/recordatorios/config`, token, "PUT", c);
}
