// Cliente HTTP tipado hacia los endpoints de voz de la API propia (config por
// sucursal, sesión de vista previa con token efímero, conversaciones). Esos
// endpoints los construye OTRA tarea: si todavía no existen (404) o el servicio de
// voz está apagado (503), este cliente lanza `VozNoDisponibleError` y la interfaz
// muestra un estado honesto; nunca inventa datos.
//
// Mismo criterio que el resto de lib/*.ts: `fetchImpl` inyectado y renovación de
// sesión vía `withAuthRefresh` (un 401 intenta un refresh y reintenta una vez).
import { apiBaseUrlFromRequestUrl, readErrorMessage, readWriteErrorMessage, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { defaultAuthCtx, RestaurantesAdminError } from "./admin-client.ts";

/** Config de voz de UNA sucursal, tal como la edita el panel (mapeada del contrato real de la API). */
export interface VozConfig {
  /** Nombre de la voz predefinida de Gemini (ver voz-catalogo.ts), o null si no se ha elegido. */
  readonly vozId: string | null;
  /** `comportamiento` en la API. */
  readonly promptSistema: string;
  readonly mensajeInicial: string;
  /** `false` = el saludo no se corta si quien llama habla encima (el aviso de asistente virtual y grabación se escucha completo). */
  readonly mensajeInicialInterrumpible: boolean;
  /** Si el agente está encendido para esta sucursal. */
  readonly habilitado: boolean;
}

export type VozConfigInput = VozConfig;

/** Proveedor con el que el panel guarda la configuración (las voces del catálogo son de Gemini). */
export const PROVEEDOR_VOZ_PANEL = "gemini-3.8-live";

export type { SesionPreviewVoz } from "../../../lib/voz/tipos.ts";
import type { SesionPreviewVoz } from "../../../lib/voz/tipos.ts";

/** Valores reales del API (`VOZ_RESULTADOS`). */
export type ResultadoConversacion = "pedido_creado" | "escalado" | "abandonado";

export interface LineaConversacion {
  readonly rol: "agente" | "usuario";
  readonly texto: string;
  readonly ts: number;
}

export interface ConversacionVoz {
  readonly id: string;
  readonly iniciadaEn: string;
  readonly duracionSegundos: number | null;
  /** Costo estimado en USD (la API lo entrega en micro-USD); 0 si aún no se calculó. */
  readonly costoUsd: number | null;
  readonly resultado: ResultadoConversacion | null;
  /** Transcripción completa: solo viene en el detalle (`fetchConversacionVoz`), no en el listado. */
  readonly transcripcion?: readonly LineaConversacion[];
  /** La API de hoy NO lo reporta; si algún día lo hace, la pestaña Herramientas cuenta ejecuciones reales. */
  readonly herramientas?: readonly string[];
}

/** El endpoint no existe todavía (404) o el servicio está apagado (503). */
export class VozNoDisponibleError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("El servicio de voz todavía no está disponible para este negocio.");
    this.name = "VozNoDisponibleError";
    this.status = status;
  }
}

function esNoDisponible(status: number): boolean {
  return status === 404 || status === 503;
}

export function base(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/voz`;
}

export async function pedir<T>(fetchImpl: typeof fetch, url: string, token: string, init: { method: "GET" | "PUT" | "POST"; body?: unknown }): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) =>
    fetchImpl(url, {
      method: init.method,
      headers: init.method === "GET" ? { authorization: `Bearer ${t}` } : { authorization: `Bearer ${t}`, "content-type": "application/json" },
      ...(init.method === "GET" ? {} : { body: JSON.stringify(init.body ?? {}) }),
    }),
  );
  if (esNoDisponible(res.status)) throw new VozNoDisponibleError(res.status);
  if (!res.ok) {
    const fallback = `No se pudo completar la solicitud a ${url} (${res.status}).`;
    throw new RestaurantesAdminError(init.method === "GET" ? await readErrorMessage(res, fallback) : await readWriteErrorMessage(res, fallback));
  }
  return (await res.json()) as T;
}

interface ConfigWire {
  readonly disponible: boolean;
  readonly configurada: boolean;
  readonly habilitado: boolean;
  readonly voiceId: string;
  readonly comportamiento: string;
  readonly mensajeInicial: string;
  /** Migración 053; una API anterior no lo manda (= interrumpible, como siempre). */
  readonly mensajeInicialInterrumpible?: boolean;
}

function configDesdeWire(w: ConfigWire): VozConfig {
  return { vozId: w.configurada && w.voiceId ? w.voiceId : null, promptSistema: w.comportamiento, mensajeInicial: w.mensajeInicial, mensajeInicialInterrumpible: w.mensajeInicialInterrumpible !== false, habilitado: w.habilitado };
}

/** `null` = el servicio existe pero esta sucursal todavía no tiene configuración guardada. Base sin migrar (`disponible: false`) = VozNoDisponibleError. */
export async function fetchVozConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<VozConfig | null> {
  const w = await pedir<ConfigWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/config`, token, { method: "GET" });
  if (w.disponible === false) throw new VozNoDisponibleError(503);
  return w.configurada ? configDesdeWire(w) : null;
}

/** El PUT de la API reemplaza la config completa y exige una voz: sin voz elegida no se puede guardar. */
export async function updateVozConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: VozConfigInput): Promise<VozConfig> {
  if (input.vozId === null) throw new RestaurantesAdminError("Elige una voz antes de guardar.");
  const body = { habilitado: input.habilitado, proveedor: PROVEEDOR_VOZ_PANEL, voiceId: input.vozId, comportamiento: input.promptSistema, mensajeInicial: input.mensajeInicial, mensajeInicialInterrumpible: input.mensajeInicialInterrumpible };
  return configDesdeWire(await pedir<ConfigWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/config`, token, { method: "PUT", body }));
}

export async function crearSesionPreviewVoz(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, opts: { readonly voiceId?: string } = {}): Promise<SesionPreviewVoz> {
  return pedir<SesionPreviewVoz>(fetchImpl, `${base(apiBaseUrl, propertyId)}/preview/sesion`, token, { method: "POST", body: opts });
}

/** Pedido SIMULADO que devuelve `crear_pedido` en la llamada/chat de prueba: nunca existe en la base (folio PRUEBA-xxxx). */
export interface PedidoSimulado {
  readonly folio: string;
  readonly sucursal: string;
  readonly total: number;
  readonly metodoPago: string | null;
  readonly renglones: readonly { readonly nombre: string; readonly cantidad: number; readonly precio: number }[];
}

/** Extrae el pedido simulado del resultado de una herramienta (`{ order: {...} }` de `crear_pedido` en modo preview); null si no lo es. */
export function pedidoSimuladoDe(resultado: unknown): PedidoSimulado | null {
  const o = (resultado as { order?: unknown } | null)?.order as { id?: unknown; branch?: unknown; total?: unknown; payment_method?: unknown; items?: unknown; simulado?: unknown } | undefined;
  if (!o || o.simulado !== true || typeof o.id !== "string" || typeof o.total !== "number") return null;
  const items = Array.isArray(o.items) ? (o.items as { name?: unknown; quantity?: unknown; price?: unknown }[]) : [];
  return {
    folio: o.id,
    sucursal: typeof o.branch === "string" ? o.branch : "",
    total: o.total,
    metodoPago: typeof o.payment_method === "string" ? o.payment_method : null,
    renglones: items.filter((i) => typeof i.name === "string").map((i) => ({ nombre: String(i.name), cantidad: Number(i.quantity) || 0, precio: Number(i.price) || 0 })),
  };
}

/** Relevo de UNA herramienta de la llamada de prueba al servidor (modo preview: sin efectos). Devuelve el resultado que ve el modelo. */
export async function ejecutarHerramientaPreviewVoz(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  sesion: Pick<SesionPreviewVoz, "sesionId" | "tokenPreview">,
  nombre: string,
  argumentos: Record<string, unknown>,
): Promise<{ readonly resultado: unknown; readonly simulado: boolean }> {
  return pedir<{ resultado: unknown; simulado: boolean }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/preview/${encodeURIComponent(sesion.sesionId)}/herramienta`, token, {
    method: "POST",
    body: { tokenPreview: sesion.tokenPreview, nombre, argumentos },
  });
}

/** Salud del proveedor de voz de ESTE despliegue (credencial presente o no), sin abrir ninguna sesion ni gastar. */
export interface SaludVoz {
  readonly ok: boolean;
  readonly detalle: string;
}

export async function fetchSaludVoz(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<SaludVoz> {
  const w = await pedir<{ salud?: { ok?: unknown; detalle?: unknown } }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/catalogo`, token, { method: "GET" });
  return { ok: w.salud?.ok === true, detalle: typeof w.salud?.detalle === "string" && w.salud.detalle ? w.salud.detalle : "El servicio de voz no informó su estado." };
}

interface ConversacionWire {
  readonly id: string;
  readonly iniciadaEn: string;
  readonly duracionS: number | null;
  readonly costoEstimadoMicroUsd: number;
  readonly resultado: string | null;
  readonly turnos?: readonly { readonly rol: string; readonly texto: string; readonly creadoEn: string }[];
}

const RESULTADOS: readonly string[] = ["pedido_creado", "escalado", "abandonado"];

function conversacionDesdeWire(w: ConversacionWire): ConversacionVoz {
  const base: ConversacionVoz = {
    id: w.id,
    iniciadaEn: w.iniciadaEn,
    duracionSegundos: w.duracionS,
    costoUsd: Number.isFinite(w.costoEstimadoMicroUsd) ? w.costoEstimadoMicroUsd / 1_000_000 : null,
    resultado: w.resultado !== null && RESULTADOS.includes(w.resultado) ? (w.resultado as ResultadoConversacion) : null,
  };
  if (!w.turnos) return base;
  return { ...base, transcripcion: w.turnos.map((t) => ({ rol: t.rol === "agente" ? "agente" : "usuario", texto: t.texto, ts: Date.parse(t.creadoEn) })) };
}

export async function fetchConversacionesVoz(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, limite = 50): Promise<readonly ConversacionVoz[]> {
  const w = await pedir<{ disponible: boolean; items: ConversacionWire[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/conversaciones?limit=${limite}`, token, { method: "GET" });
  if (w.disponible === false) throw new VozNoDisponibleError(503);
  return w.items.map(conversacionDesdeWire);
}

/** Detalle con transcripción (turnos). Su lectura queda en la bitácora del servidor. */
export async function fetchConversacionVoz(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, conversationId: string): Promise<ConversacionVoz> {
  return conversacionDesdeWire(await pedir<ConversacionWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/conversaciones/${encodeURIComponent(conversationId)}`, token, { method: "GET" }));
}
