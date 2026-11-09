// Aviso «su pedido va en camino» por WhatsApp (decision del dueno de PM, 9-nov-2026; migracion 107, docs/restaurantes/AVISO-EN-CAMINO.md).
//
// Cuando un pedido a DOMICILIO pasa a `en_camino` (salio con el repartidor) se avisa al cliente UNA vez, venga de WhatsApp, de una llamada (agente de
// voz) o del panel. Es el unico estado con estas reglas; preparando/entregado/cancelado siguen con el aviso de siempre (`order-notifications.ts`).
//
//   * Dentro de la ventana de 24 h de la conversacion del cliente (con 1 h de margen): texto libre, SIN plantilla.
//   * Fuera de ella (siempre en pedidos por llamada): SOLO la plantilla utility aprobada de la organizacion (catalogo `core.whatsapp_plantilla`, evento
//     `order.en_camino`), con `solo_plantilla` para que el gateway nunca la degrade a texto (Meta lo rechazaria con 131047).
//   * Sin plantilla aprobada: no se encola nada, el pedido queda `omitido_falta_plantilla` y el dueno recibe UNA notificacion in-app por organizacion.
//   * Respeta el interruptor de la organizacion (encendido por omision), la BAJA (consentimiento revocado, 091) y, en pedidos capturados por el
//     personal (llamada/mostrador), el consentimiento registrado. Una sucursal solo venta local (Galerias) o un pedido para recoger no aplican.
//
// El contexto (ventana, plantilla, consentimiento, interruptor) lo calcula la base (`restaurantes.aviso_en_camino_contexto`): la sesion de staff o de
// chofer que mueve el pedido no puede leer el ledger de entrantes ni el catalogo. Base SIN la 107 (o un doble sin el metodo): `null` y el llamador
// conserva el aviso anterior (texto + plantilla declarada; decide el gateway con WHATSAPP_APPROVED_TEMPLATES).
import { descripcionSeguraDeError } from "./log-seguro.ts";
import { toWhatsAppRecipient } from "./phone.ts";
import type { Order } from "./types.ts";
import type { RestaurantesRepository } from "./repository.ts";

/** Evento del catalogo de plantillas (`core.whatsapp_plantilla.evento`) que usa este aviso. */
export const EVENTO_PLANTILLA_EN_CAMINO = "order.en_camino";

/** Plantilla que el dueno da de alta en su Administrador de WhatsApp (texto exacto en docs/restaurantes/AVISO-EN-CAMINO.md). */
export const PLANTILLA_EN_CAMINO_SUGERIDA: PlantillaAvisoEnCamino = { nombre: "pedido_en_camino", idioma: "es_MX", variables: ["sucursal", "folio", "tiempo"] };

/** Variables que este aviso sabe calcular (cualquier orden). Una plantilla que pida otra no se puede llenar y se trata como faltante. */
export const VARIABLES_AVISO_EN_CAMINO = ["sucursal", "folio", "tiempo", "nombre", "total"] as const;

/** Respaldo de la variable `tiempo` cuando la sucursal no configuro su tiempo de entrega (Meta rechaza variables vacias). */
export const TIEMPO_SIN_DATO = "unos minutos";

export interface PlantillaAvisoEnCamino {
  readonly nombre: string;
  readonly idioma: string;
  readonly variables: readonly string[];
}

export interface ContextoAvisoEnCamino {
  /** Interruptor de la organizacion (sin fila = encendido). */
  readonly activo: boolean;
  /** El cliente escribio a la organizacion hace menos de 23 h. */
  readonly ventanaAbierta: boolean;
  readonly consentimiento: "vigente" | "revocado" | "sin_registro";
  /** Pedido capturado por el personal (llamada/mostrador): sin consentimiento registrado no se avisa (091). */
  readonly requiereConsentimiento: boolean;
  /** Consentimiento que aplico a ESE pedido (`orders.aviso_whatsapp`), si se registro. */
  readonly avisoWhatsapp: boolean | null;
  /** Plantilla APROBADA de la organizacion para `order.en_camino`, o null. */
  readonly plantilla: PlantillaAvisoEnCamino | null;
}

export type LecturaContextoAvisoEnCamino =
  | { readonly disponible: false }
  /** `contexto: null` = el pedido no existe en la organizacion. */
  | { readonly disponible: true; readonly contexto: (ContextoAvisoEnCamino & { readonly yaAvisado: boolean }) | null };

export const ESTADOS_AVISO_EN_CAMINO = ["texto", "plantilla", "omitido_falta_plantilla", "omitido_sin_consentimiento", "omitido_baja", "omitido_desactivado"] as const;
export type EstadoAvisoEnCamino = (typeof ESTADOS_AVISO_EN_CAMINO)[number];

export type MotivoAvisoEnCaminoOmitido =
  | "no_customer_phone"
  | "no_whatsapp_channel"
  | "no_aplica"
  | "ya_avisado"
  | "desactivado"
  | "baja"
  | "sin_consentimiento"
  | "falta_plantilla";

export type ResultadoAvisoEnCamino =
  | { readonly enqueued: true; readonly como: "texto" | "plantilla" }
  | { readonly enqueued: false; readonly reason: MotivoAvisoEnCaminoOmitido };

/** Fila jsonb de `restaurantes.aviso_en_camino_contexto` -> contexto tipado (valores desconocidos caen al lado seguro). */
export function mapearContextoAvisoEnCamino(c: Readonly<Record<string, unknown>> | null): (ContextoAvisoEnCamino & { readonly yaAvisado: boolean }) | null {
  if (!c) return null;
  const p = c.plantilla as Readonly<Record<string, unknown>> | null | undefined;
  const plantilla: PlantillaAvisoEnCamino | null =
    p && typeof p.nombre === "string" && typeof p.idioma === "string"
      ? { nombre: p.nombre, idioma: p.idioma, variables: Array.isArray(p.variables) ? p.variables.filter((v): v is string => typeof v === "string") : [] }
      : null;
  return {
    activo: c.activo !== false,
    ventanaAbierta: c.ventana_abierta === true,
    consentimiento: c.consentimiento === "vigente" ? "vigente" : c.consentimiento === "revocado" ? "revocado" : "sin_registro",
    requiereConsentimiento: c.requiere_consentimiento === true,
    avisoWhatsapp: typeof c.aviso_whatsapp === "boolean" ? c.aviso_whatsapp : null,
    plantilla,
    yaAvisado: c.ya_avisado === true,
  };
}

function variable(valor: string | null | undefined, respaldo: string): string {
  const limpio = (valor ?? "").replace(/\s+/g, " ").trim().slice(0, 1024);
  return limpio.length > 0 ? limpio : respaldo;
}

function folioDe(order: Order): string {
  return order.orderNumber !== undefined && order.orderNumber !== null ? String(order.orderNumber) : order.id.slice(0, 8).toUpperCase();
}

/** Valores de las variables de la plantilla en el ORDEN registrado en el catalogo; `null` si pide una variable que el aviso no calcula. */
export function parametrosPlantillaEnCamino(plantilla: PlantillaAvisoEnCamino, order: Order, tiempo: string | null): string[] | null {
  if (plantilla.variables.length === 0) return [];
  const valores: Readonly<Record<(typeof VARIABLES_AVISO_EN_CAMINO)[number], string>> = {
    sucursal: variable(order.branch, "la sucursal"),
    folio: folioDe(order),
    tiempo: variable(tiempo, TIEMPO_SIN_DATO),
    nombre: variable(order.customerName, "cliente"),
    total: `$${order.total.toFixed(2)} MXN`,
  };
  const params: string[] = [];
  for (const v of plantilla.variables) {
    if (!(VARIABLES_AVISO_EN_CAMINO as readonly string[]).includes(v)) return null;
    params.push(valores[v as (typeof VARIABLES_AVISO_EN_CAMINO)[number]]);
  }
  return params;
}

/** Texto libre (solo dentro de la ventana de 24 h): saludo, folio, sucursal y, si existe, el tiempo estimado. */
export function textoAvisoEnCamino(order: Order, tiempo: string | null): string {
  const saludo = order.customerName ? `Hola ${order.customerName}, ` : "Hola, ";
  const sucursal = order.branch ? ` de ${order.branch}` : "";
  const t = tiempo ? ` Tiempo estimado de llegada: ${tiempo}.` : "";
  return `${saludo}su pedido #${folioDe(order)}${sucursal} va en camino.${t}`;
}

async function tiempoEstimado(repo: RestaurantesRepository, order: Order): Promise<string | null> {
  try {
    const texto = (await repo.findWhatsAppAgentConfig(order.organizationId, order.propertyId))?.deliveryTimeText;
    const limpio = (texto ?? "").replace(/\s+/g, " ").trim();
    return limpio.length > 0 ? limpio.slice(0, 120) : null;
  } catch (err) {
    console.error("aviso-en-camino: no se pudo leer el tiempo de entrega de la sucursal (se usa el respaldo):", descripcionSeguraDeError(err));
    return null;
  }
}

async function marcar(repo: RestaurantesRepository, order: Order, estado: EstadoAvisoEnCamino): Promise<void> {
  if (!repo.marcarAvisoEnCamino) return;
  try {
    await repo.marcarAvisoEnCamino(order.organizationId, order.id, estado);
  } catch (err) {
    // La marca es bitacora: nunca tumba el aviso ya encolado (el metodo hace ROLLBACK TO SAVEPOINT antes de relanzar).
    console.error("aviso-en-camino: no se pudo registrar el estado del aviso en el pedido:", descripcionSeguraDeError(err));
  }
}

async function omitir(repo: RestaurantesRepository, order: Order, estado: EstadoAvisoEnCamino, reason: MotivoAvisoEnCaminoOmitido): Promise<ResultadoAvisoEnCamino> {
  await marcar(repo, order, estado);
  console.info(JSON.stringify({ evento: "restaurantes_aviso_en_camino_omitido", organizationId: order.organizationId, orderId: order.id, motivo: reason }));
  return { enqueued: false, reason };
}

/**
 * Decide y encola el aviso «va en camino» de `order` (ya en `en_camino`). Devuelve `null` si el contexto no esta disponible (base sin la 107 o doble
 * sin el metodo): el llamador conserva el aviso anterior. Puede lanzar (el llamador lo corre como best-effort con SAVEPOINT).
 */
export async function avisarPedidoEnCamino(repo: RestaurantesRepository, order: Order): Promise<ResultadoAvisoEnCamino | null> {
  if (order.status !== "en_camino") return { enqueued: false, reason: "no_aplica" };
  if (!repo.leerContextoAvisoEnCamino) return null;
  const recipient = order.customerPhone ? toWhatsAppRecipient(order.customerPhone) : null;
  if (!recipient) return { enqueued: false, reason: "no_customer_phone" };
  // Credenciales por organizacion (0090): el numero de la sucursal decide con que token sale (lo resuelve el despachador por phone_number_id).
  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberId(order.organizationId, order.propertyId);
  if (!phoneNumberId) return { enqueued: false, reason: "no_whatsapp_channel" };

  const lectura = await repo.leerContextoAvisoEnCamino(order.organizationId, order.id);
  if (!lectura.disponible) return null;
  const ctx = lectura.contexto;
  if (!ctx) return { enqueued: false, reason: "no_aplica" };
  if (ctx.yaAvisado) return { enqueued: false, reason: "ya_avisado" };

  // Solo domicilio: un pedido para recoger no sale en camino y una sucursal solo venta local (Galerias) no tiene domicilio.
  const [info] = await repo.listOrderPickupInfo(order.organizationId, [order.id]);
  if (info?.canal === "recoger") return { enqueued: false, reason: "no_aplica" };
  if ((await repo.listarSucursalesSoloVentaLocal(order.organizationId)).includes(order.propertyId)) return { enqueued: false, reason: "no_aplica" };

  if (!ctx.activo) return omitir(repo, order, "omitido_desactivado", "desactivado");
  if (ctx.consentimiento === "revocado") return omitir(repo, order, "omitido_baja", "baja");
  if (ctx.requiereConsentimiento) {
    const otorgado = ctx.avisoWhatsapp === true || (ctx.avisoWhatsapp !== false && ctx.consentimiento === "vigente");
    if (!otorgado) return omitir(repo, order, "omitido_sin_consentimiento", "sin_consentimiento");
  }

  const tiempo = await tiempoEstimado(repo, order);
  const base = { to: recipient, phone_number_id: phoneNumberId, body: textoAvisoEnCamino(order, tiempo), transaccional: true };
  const tipo = "order.status.en_camino";
  const dedupe = `order-status:${order.id}:en_camino`;

  if (ctx.ventanaAbierta) {
    await repo.enqueueMessagingOutbox(order.organizationId, "whatsapp", tipo, dedupe, base);
    await marcar(repo, order, "texto");
    return { enqueued: true, como: "texto" };
  }

  const params = ctx.plantilla ? parametrosPlantillaEnCamino(ctx.plantilla, order, tiempo) : null;
  if (!ctx.plantilla || !params) {
    const r = await omitir(repo, order, "omitido_falta_plantilla", "falta_plantilla");
    if (repo.notificarFaltaPlantillaEnCamino) {
      try {
        await repo.notificarFaltaPlantillaEnCamino(order.organizationId, order.propertyId);
      } catch (err) {
        console.error("aviso-en-camino: no se pudo emitir la notificacion de plantilla faltante:", descripcionSeguraDeError(err));
      }
    }
    return r;
  }

  await repo.enqueueMessagingOutbox(order.organizationId, "whatsapp", tipo, dedupe, {
    ...base,
    template: { name: ctx.plantilla.nombre, language: ctx.plantilla.idioma, params },
    solo_plantilla: true,
  });
  await marcar(repo, order, "plantilla");
  return { enqueued: true, como: "plantilla" };
}
