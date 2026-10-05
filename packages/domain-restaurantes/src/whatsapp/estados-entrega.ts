// Procesa los `statuses` de Meta (entrega/lectura/fallo de un mensaje SALIENTE) del webhook de restaurantes.
//
// Un status avanza el estado de entrega de la fila del outbox con ese wamid (`restaurantes.registrar_estado_entrega_whatsapp`, migracion 066:
// solo sesion de sistema, idempotente, sin retroceso, `failed` gana). Solo cuando un mensaje PASA a `failed` se avisa:
//   * notificacion in-app a owner/admin/staff (catalogo `restaurantes.whatsapp.entrega_fallida*`, sin PII, dedupe por mensaje); si hay mas de
//     UMBRAL_AVISOS_AGRUPADOS fallos en la ultima hora se emite UN aviso agrupado por hora en vez de uno por mensaje, para no inundar la campana;
//   * si era el aviso de estado de un pedido y el cliente dejo correo, respaldo por correo (dedupe por pedido y estado).
// NO reintenta un `failed` de negocio (131047, 131026): solo se avisa. No toca el ledger de mensajes entrantes ni el turno del agente.
//
// Privacidad: este modulo no recibe ni guarda el telefono del destinatario ni el texto del mensaje; solo wamid, estado y codigo de error.
// Las notificaciones llevan unicamente un codigo de motivo (sin PII). El correo de respaldo usa el correo que el cliente dejo en SU pedido.
import { correoRespaldoEstadoPedido } from "../emails/order-templates.ts";
import { esEstadoNotificadoAlCliente, frasePedidoParaEstado } from "../order-notifications.ts";
import type { EstadoEntregaEntrante, RegistroEstadoEntrega, RestaurantesRepository } from "../repository.ts";

/** Mas de este numero de entregas fallidas en una hora de la misma organizacion se agrupan en un solo aviso. */
export const UMBRAL_AVISOS_AGRUPADOS = 5;

export type EventoEntregaFallida = "restaurantes.whatsapp.entrega_fallida" | "restaurantes.whatsapp.entrega_fallida_pedido" | "restaurantes.whatsapp.entregas_fallidas_varias";

export interface EmisionEntregaFallida {
  readonly evento: EventoEntregaFallida;
  readonly organizationId: string;
  readonly clave: string;
  readonly parametros: Readonly<Record<string, string | number>>;
  readonly entidadTipo?: string | null;
  readonly entidadId?: string | null;
}

export interface ProcesarEstadosEntregaOptions {
  /** Emite la notificacion in-app (en produccion `emitirNotificacion(db, ...)`, que nunca lanza ni aborta la transaccion). */
  readonly emitir: (e: EmisionEntregaFallida) => Promise<void>;
  /** Reloj inyectable (la clave del aviso agrupado es la hora UTC). */
  readonly ahora?: () => Date;
}

export interface ResumenEstadosEntrega {
  readonly recibidos: number;
  readonly actualizados: number;
  readonly sinCambio: number;
  readonly desconocidos: number;
  /** Base sin la migracion 066: se ignoran sin error. */
  readonly noDisponibles: number;
  readonly fallidos: number;
  readonly avisosEmitidos: number;
  readonly correosEncolados: number;
  readonly errores: number;
}

function horaUtc(d: Date): string {
  return d.toISOString().slice(0, 13).replace("T", "");
}

async function respaldoPorCorreo(repo: RestaurantesRepository, organizationId: string, r: RegistroEstadoEntrega): Promise<boolean> {
  const datos = r.respaldoCorreo;
  if (!datos || !r.orderId || !r.orderStatus || !esEstadoNotificadoAlCliente(r.orderStatus)) return false;
  const orderId = r.orderId;
  const orderStatus = r.orderStatus;
  // La frase sale de la misma plantilla del aviso por WhatsApp (por estado). Los datos del pedido vienen de la funcion SQL: la sesion de sistema no
  // puede leer `orders` (RLS solo de staff).
  const frase = frasePedidoParaEstado({ customerName: datos.clienteNombre, branch: datos.sucursal, total: datos.total, status: orderStatus });
  if (!frase) return false;
  const correo = correoRespaldoEstadoPedido({ clienteNombre: datos.clienteNombre, branch: datos.sucursal, mensaje: frase, total: datos.total });
  return repo.runWithRowSavepoint(async () => {
    await repo.enqueueMessagingOutbox(organizationId, "email", "order.status.whatsapp_fallido.email", `order-status-email:${orderId}:${orderStatus}`, {
      to: datos.to,
      subject: correo.asunto,
      html: correo.html,
      text: correo.texto,
      transaccional: true, // aviso de SU pedido: la lista de supresion no lo bloquea (mismo criterio que la confirmacion).
    });
    return true;
  });
}

export async function procesarEstadosEntrega(
  repo: RestaurantesRepository,
  organizationId: string,
  estados: readonly EstadoEntregaEntrante[],
  opts: ProcesarEstadosEntregaOptions,
): Promise<ResumenEstadosEntrega> {
  const ahora = opts.ahora ?? (() => new Date());
  let actualizados = 0;
  let sinCambio = 0;
  let desconocidos = 0;
  let noDisponibles = 0;
  let fallidos = 0;
  let avisosEmitidos = 0;
  let correosEncolados = 0;
  let errores = 0;

  for (const estado of estados) {
    let r: RegistroEstadoEntrega;
    try {
      r = await repo.registrarEstadoEntregaWhatsapp(organizationId, estado);
    } catch (err) {
      // Un status que falla (error de Postgres que no es "base sin migrar") no tumba el resto del lote ni los mensajes entrantes de este webhook.
      errores++;
      console.error("estados-entrega: no se pudo registrar un status (se ignora)", (err as { code?: unknown })?.code ?? null, err instanceof Error ? err.name : typeof err);
      continue;
    }
    if (r.resultado === "no_disponible") {
      noDisponibles++;
      continue;
    }
    if (r.resultado === "desconocido") {
      desconocidos++;
      continue;
    }
    if (r.resultado === "sin_cambio") {
      sinCambio++;
      continue;
    }
    actualizados++;
    if (r.estado !== "failed" || !r.outboxId) continue;
    fallidos++;

    try {
      if (r.fallidasUltimaHora > UMBRAL_AVISOS_AGRUPADOS) {
        await opts.emitir({ evento: "restaurantes.whatsapp.entregas_fallidas_varias", organizationId, clave: `${organizationId}:${horaUtc(ahora())}`, parametros: { cantidad: r.fallidasUltimaHora } });
      } else {
        await opts.emitir({
          evento: r.orderId ? "restaurantes.whatsapp.entrega_fallida_pedido" : "restaurantes.whatsapp.entrega_fallida",
          organizationId,
          clave: r.outboxId,
          parametros: { motivo: r.motivoFallo ?? "otro" },
          entidadTipo: "messaging_outbox",
          entidadId: r.outboxId,
        });
      }
      avisosEmitidos++;
    } catch {
      errores++;
    }

    try {
      if (await respaldoPorCorreo(repo, organizationId, r)) correosEncolados++;
    } catch (err) {
      errores++;
      console.error("estados-entrega: no se pudo encolar el respaldo por correo (se ignora)", (err as { code?: unknown })?.code ?? null, err instanceof Error ? err.name : typeof err);
    }
  }

  return { recibidos: estados.length, actualizados, sinCambio, desconocidos, noDisponibles, fallidos, avisosEmitidos, correosEncolados, errores };
}
