// Confirmacion inmediata al cliente de VOZ y WEB (autopiloto, A-21): "Recibimos su pedido #folio, tiempo estimado X". WhatsApp ya confirma en el chat y
// nunca recibe este aviso. Reglas:
//   * Idempotente por pedido (dedupe `order-recibido:<id>` en el outbox): un reintento del checkout no manda un segundo mensaje.
//   * SIN plantilla aprobada (`WHATSAPP_APPROVED_TEMPLATES` incluye `pedido_recibido`) NO se envia: estado honesto `plantilla_no_aprobada` (el cliente de
//     voz o web casi nunca tiene la ventana de 24 h abierta, y un texto libre fuera de ella Meta lo rechaza).
//   * Best-effort con SAVEPOINT: un fallo nunca revierte ni retrasa el pedido ya creado.
//   * El tiempo estimado sale de `estimarTiempoSucursal` (mediana de la franja con piso del dueno, o el texto fijo del dueno).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PLANTILLAS_AUTOPILOTO, confirmarPedidoRecibido, estimarTiempoSucursal } from "@atiende/domain-restaurantes";
import type { Order, RestaurantesRepository } from "@atiende/domain-restaurantes";
import type { AppDeps } from "../../../deps.ts";

export type ResultadoAvisoRecibido =
  | { readonly enviado: true }
  | { readonly enviado: false; readonly motivo: "canal_no_aplica" | "plantilla_no_aprobada" | "sin_telefono" | "sin_canal_whatsapp" | "error" };

export async function avisarPedidoRecibido(deps: AppDeps, db: TenantDbSession, repo: RestaurantesRepository, order: Order): Promise<ResultadoAvisoRecibido> {
  if (order.source !== "voice" && order.source !== "web") return { enviado: false, motivo: "canal_no_aplica" };
  if (!(deps.env.whatsappApprovedTemplates ?? []).includes(PLANTILLAS_AUTOPILOTO.recibido.name)) return { enviado: false, motivo: "plantilla_no_aprobada" };
  try {
    return await repo.runWithRowSavepoint(async (): Promise<ResultadoAvisoRecibido> => {
      const [info] = await repo.listOrderPickupInfo(order.organizationId, [order.id]);
      const canal = info?.canal === "recoger" ? "recoger" : "domicilio";
      const tiempo = await estimarTiempoSucursal(
        { auto: deps.autopilotoRepo ? deps.autopilotoRepo(db) : null, repo },
        { organizationId: order.organizationId, propertyId: order.propertyId, canal, ahora: new Date() },
      );
      const r = await confirmarPedidoRecibido(repo, order, tiempo.texto, order.orderNumber ?? null);
      return r.enviado ? { enviado: true } : { enviado: false, motivo: r.motivo ?? "error" };
    });
  } catch (err) {
    console.error("autopiloto: el aviso 'pedido recibido' fallo (el pedido ya quedo registrado):", err instanceof Error ? err.message : err);
    return { enviado: false, motivo: "error" };
  }
}
