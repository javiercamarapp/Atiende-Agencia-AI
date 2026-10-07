// R-11 (PM): pedidos PROGRAMADOS. Un cliente deja el pedido para una fecha y hora futuras; el pedido queda
// en `programado` (fuera de cocina) y se PROMUEVE solo a `pending` cuando falta poco para esa hora.
//
// Reglas (todas con un test de borde en tests/pedidos-programados*.spec.ts):
//  - La hora elegida debe llegar con zona (ISO 8601, `Z` u offset): el instante es absoluto. La zona del
//    NEGOCIO (America/Merida, America/Mexico_City, ...) solo se usa para validar el horario de la sucursal
//    en esa hora -- por eso un pedido para "01:00 del sabado" con un turno viernes 18:00-02:00 es valido
//    aunque en UTC ya sea otro dia -- y para mostrar la hora.
//  - Ventana: al menos `PROGRAMACION_MINIMA_MIN` minutos en el futuro (si no, es un pedido normal) y como
//    maximo `PROGRAMACION_MAXIMA_DIAS` dias.
//  - Horario: la sucursal debe estar abierta a esa hora (horario semanal + excepciones por fecha/puentes,
//    cruces de medianoche incluidos). Sin horario configurado no se restringe, igual que un pedido normal.
//  - Promocion: sin crons (decision de costo). Corre cuando el panel consulta los pedidos y por el endpoint
//    interno /internal/restaurantes/promover-programados. Idempotente por construccion (la promocion solo
//    toca filas en `programado`); un pedido cancelado nunca se promueve, ni uno de una sucursal desactivada.
import { OrderValidationError } from "./errors.ts";
import { etiquetaHoraLocal, mensajeProgramadoFueraDeHorario } from "./horarios.ts";
import { RestaurantesConfigUnavailableError } from "./repository.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Order } from "./types.ts";

/** Minutos antes de la hora programada en que el pedido pasa a `pending` (entra a cocina). */
export const ANTICIPACION_PROMOCION_MIN = 30;
/** Un pedido programado debe quedar al menos tan adelante como la anticipacion de promocion (si no, seria inmediato). */
export const PROGRAMACION_MINIMA_MIN = ANTICIPACION_PROMOCION_MIN;
export const PROGRAMACION_MAXIMA_DIAS = 7;

const ISO_CON_ZONA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Valida el texto de la hora programada y la devuelve normalizada a ISO UTC. Lanza `OrderValidationError`. */
export function parsearProgramadoPara(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 40 || !ISO_CON_ZONA.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new OrderValidationError("La hora programada debe ser una fecha y hora ISO 8601 con zona horaria (por ejemplo 2026-10-03T14:00:00-06:00).");
  }
  return new Date(raw).toISOString();
}

/** Ventana permitida para programar. `programadoPara` ya normalizado por `parsearProgramadoPara`. */
export function validarVentanaProgramacion(programadoPara: string, ahora: Date): void {
  const minutos = (Date.parse(programadoPara) - ahora.getTime()) / 60_000;
  if (minutos < PROGRAMACION_MINIMA_MIN) {
    throw new OrderValidationError(
      `Un pedido programado debe ser para dentro de al menos ${PROGRAMACION_MINIMA_MIN} minutos; para antes, haga un pedido normal (sin programado_para) y, si es para recoger, mande la hora en hora_recogida.`,
    );
  }
  if (minutos > PROGRAMACION_MAXIMA_DIAS * 24 * 60) {
    throw new OrderValidationError(`Un pedido solo se puede programar con ${PROGRAMACION_MAXIMA_DIAS} días de anticipación como máximo.`);
  }
}

/** Mensaje de horario para `aplicarReglasDeSucursal`: nombra la hora elegida en la zona de la sucursal. */
export function mensajeCerradoProgramado(nombreSucursal: string, programadoPara: string): (apertura: Parameters<typeof mensajeProgramadoFueraDeHorario>[2], zona: string) => string {
  return (apertura, zona) => mensajeProgramadoFueraDeHorario(nombreSucursal, etiquetaHoraLocal(new Date(programadoPara), zona), apertura);
}

/** La base debe tener la migracion 034: contra una base vieja, `create_order_idempotent` ignoraria la hora y
 * crearia el pedido INMEDIATO (el cliente creeria que lo programo). Mejor un 503 honesto. */
export async function assertProgramacionDisponible(repo: RestaurantesRepository): Promise<void> {
  if (!(await repo.supportsScheduledOrders())) throw new RestaurantesConfigUnavailableError();
}

export interface PromocionProgramados {
  /** `false` = la base aun no tiene la migracion 034: no hay pedidos programados que promover. */
  readonly disponible: boolean;
  readonly promovidos: readonly Order[];
}

/**
 * Promueve a `pending` los pedidos programados de UNA organizacion cuya hora esta dentro de la anticipacion.
 * Idempotente; segura de llamar en cada consulta del panel. `propertyIds: null` = toda la organizacion.
 * Contra la base sin migrar devuelve `disponible:false` (SAVEPOINT en el repositorio), nunca lanza.
 */
export async function promoverProgramadosVencidos(
  repo: RestaurantesRepository,
  organizationId: string,
  options: { readonly propertyIds?: readonly string[] | null; readonly now?: Date; readonly anticipacionMin?: number } = {},
): Promise<PromocionProgramados> {
  // Solo sucursales ACTIVAS: un programado de una sucursal dada de baja se queda en `programado` (visible en el panel)
  // en vez de entrar en silencio a cocina. La migracion 041 hace lo mismo en SQL; este filtro protege tambien contra
  // una base que todavia no la tiene (camino del panel, acotado a una organizacion).
  const activas = new Set((await repo.listBranchesForOrganization(organizationId)).map((b) => b.propertyId));
  const propertyIds = [...(options.propertyIds ?? activas)].filter((id) => activas.has(id));
  const result = await repo.promoteDueScheduledOrders(organizationId, {
    now: options.now ?? new Date(),
    anticipacionMin: options.anticipacionMin ?? ANTICIPACION_PROMOCION_MIN,
    propertyIds,
  });
  return { disponible: result.disponible, promovidos: result.promoted };
}

/** Barrido de TODAS las organizaciones (sesion de sistema, endpoint interno con secreto). */
export async function promoverProgramadosTodasLasOrganizaciones(repo: RestaurantesRepository, options: { readonly now?: Date; readonly anticipacionMin?: number } = {}): Promise<PromocionProgramados> {
  const result = await repo.promoteDueScheduledOrders(null, {
    now: options.now ?? new Date(),
    anticipacionMin: options.anticipacionMin ?? ANTICIPACION_PROMOCION_MIN,
    propertyIds: null,
  });
  return { disponible: result.disponible, promovidos: result.promoted };
}
