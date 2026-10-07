// CR12 -- domicilio sin zonas de reparto cargadas, perfil `taqueria_pm`.
//
// Hoy, si una sucursal no tiene `branch_delivery_zone`, `aplicarReglasDeSucursal` no valida la cobertura (comportamiento opt-in,
// igual que cualquier restaurante que no configuro zonas). El dueño de PM prohibe el domicilio fuera de zona (cuestionario l.141):
// con el agente (WhatsApp o voz) y sin zonas cargadas, el pedido a domicilio no puede aceptar "cualquier colonia" en silencio.
// Entonces, SOLO para organizaciones con el perfil `taqueria_pm`:
//   * con pin de ubicacion (el que el cliente comparte por WhatsApp; el servidor lo toma del contexto del turno, nunca del modelo):
//     la sucursal se asigna por distancia real y el pedido solo se acepta en la sucursal MAS CERCANA con coordenadas;
//   * sin pin (o sin sucursal con coordenadas): se rechaza con un mensaje que manda a pedir el pin o a pasar con una persona
//     (motivo `zona_no_reconocida`).
// El resto de las organizaciones y los pedidos de captura manual (admin) o del checkout web conservan el comportamiento actual.
//
// Las lecturas van por `repo.*`, que degradan con SAVEPOINT contra la base sin migrar: `findWhatsAppAgentConfig` devuelve null
// (perfil generico) y `listBranchDeliveryZoneIds` devuelve [] -- este modulo no captura SQLSTATE por su cuenta.
import { OrderValidationError } from "./errors.ts";
import { rankBranchesByKm } from "./branch-assignment.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Branch, CanalPedido } from "./types.ts";

export interface UbicacionCompartida {
  readonly lat: number;
  readonly lng: number;
}

export const PM_SIN_ZONAS_PEDIR_PIN_MENSAJE =
  "Esta sucursal todavía no tiene zonas de reparto cargadas, así que no puedo confirmar que ese domicilio esté dentro de su cobertura. " +
  "Pida al cliente que comparta su ubicación (pin de WhatsApp) para asignar la sucursal por distancia; si no puede compartirla o es una llamada, " +
  "pase el pedido con una persona (escalar_a_humano, motivo zona_no_reconocida). No lo registre a domicilio sin eso.";

export interface PinRepartoArgs {
  readonly branch: Branch;
  readonly canal: CanalPedido;
  readonly source?: "web" | "voice" | "whatsapp" | "admin";
  readonly ubicacion?: UbicacionCompartida | null;
}

export async function exigirPinSiPmSinZonas(repo: RestaurantesRepository, args: PinRepartoArgs): Promise<void> {
  const { branch } = args;
  if (args.canal !== "domicilio") return;
  if (args.source !== "whatsapp" && args.source !== "voice") return;
  if ((await repo.listBranchDeliveryZoneIds(branch.propertyId)).length > 0) return;
  const config = await repo.findWhatsAppAgentConfig(branch.organizationId, branch.propertyId);
  if (config?.perfil !== "taqueria_pm") return;

  const pin = args.ubicacion;
  if (!pin || !Number.isFinite(pin.lat) || !Number.isFinite(pin.lng)) throw new OrderValidationError(PM_SIN_ZONAS_PEDIR_PIN_MENSAJE);

  const activas = (await repo.listBranchesForOrganizationAdmin(branch.organizationId)).filter((b) => b.status === "active");
  const masCercana = rankBranchesByKm(pin.lat, pin.lng, activas)[0];
  if (!masCercana) throw new OrderValidationError(PM_SIN_ZONAS_PEDIR_PIN_MENSAJE);
  if (masCercana.branch.propertyId !== branch.propertyId) {
    throw new OrderValidationError(
      `La ubicación compartida queda más cerca de ${masCercana.branch.name} que de ${branch.name}: no se puede enviar el pedido a domicilio desde esta sucursal. ` +
        `Dé al cliente el teléfono de ${masCercana.branch.name} (H17) u ofrezca recoger en ${branch.name}.`,
    );
  }
}
