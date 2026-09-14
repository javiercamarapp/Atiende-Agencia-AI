import type { EstadoBorrador } from "./tipos.ts";

/**
 * Cola de aprobación humana obligatoria — port de rentas/packages/domain/src/
 * mensajeria/colaAprobacion.ts (H-059, D-006: "sin ruta de envío directo para
 * procesos automáticos"). Máquina de estados pura — persistencia real vía
 * ./repository.ts (migración `009_rentas_mensajeria_schema.sql`); estas funciones
 * solo deciden transiciones válidas y lanzan errores tipados ante cualquier intento
 * de saltarse la aprobación.
 *
 *   pendiente_aprobacion → aprobado   (exige `aprobadoPor` humano)
 *   pendiente_aprobacion → rechazado  (exige `rechazadoPor` humano + motivo)
 *   aprobado             → enviado    (única transición que representa un envío
 *                                      real; SOLO alcanzable desde `aprobado`)
 *
 * No existe NINGUNA función en este módulo (ni en el resto del paquete) que
 * transicione directamente `pendiente_aprobacion → enviado`. Un proceso automático
 * (worker/scheduler) que intente enviar sin pasar por `aprobarBorrador` primero debe
 * llamar `intentarEnvioAutomatico`, que SIEMPRE lanza `AprobacionRequeridaError` si el
 * borrador no está `aprobado` — esta función existe precisamente para que ese intento
 * deje un error tipado + un punto de auditoría explícito ("borrador no se envía sin
 * aprobación: intento automático → error tipado y auditoría", ver
 * apps/api/tests/rentas-mensajeria.spec.ts), en vez de fallar de forma silenciosa o
 * ambigua.
 */

export class AprobacionRequeridaError extends Error {
  constructor(
    readonly borradorId: string,
    readonly estadoActual: EstadoBorrador,
  ) {
    super(`Borrador ${borradorId} no puede enviarse: estado actual "${estadoActual}", se requiere "aprobado" por un humano autorizado antes de cualquier envío`);
    this.name = "AprobacionRequeridaError";
  }
}

export class TransicionBorradorInvalidaError extends Error {
  constructor(
    readonly borradorId: string,
    readonly estadoActual: EstadoBorrador,
    readonly transicion: string,
  ) {
    super(`Borrador ${borradorId} en estado "${estadoActual}" no admite la transición "${transicion}"`);
    this.name = "TransicionBorradorInvalidaError";
  }
}

export interface BorradorEstado {
  readonly id: string;
  readonly estado: EstadoBorrador;
}

export interface ResultadoAprobarBorrador {
  readonly estado: "aprobado";
  readonly aprobadoPor: string;
  readonly aprobadoEn: string;
}

export interface ResultadoRechazarBorrador {
  readonly estado: "rechazado";
  readonly rechazadoPor: string;
  readonly rechazadoEn: string;
  readonly motivo: string;
}

export interface ResultadoMarcarEnviado {
  readonly estado: "enviado";
}

export function aprobarBorrador(borrador: BorradorEstado, aprobadoPorUsuarioId: string): ResultadoAprobarBorrador {
  if (borrador.estado !== "pendiente_aprobacion") {
    throw new TransicionBorradorInvalidaError(borrador.id, borrador.estado, "aprobar");
  }
  return { estado: "aprobado", aprobadoPor: aprobadoPorUsuarioId, aprobadoEn: new Date().toISOString() };
}

export function rechazarBorrador(borrador: BorradorEstado, rechazadoPorUsuarioId: string, motivo: string): ResultadoRechazarBorrador {
  if (borrador.estado !== "pendiente_aprobacion") {
    throw new TransicionBorradorInvalidaError(borrador.id, borrador.estado, "rechazar");
  }
  if (!motivo.trim()) {
    throw new TransicionBorradorInvalidaError(borrador.id, borrador.estado, "rechazar sin motivo");
  }
  return { estado: "rechazado", rechazadoPor: rechazadoPorUsuarioId, rechazadoEn: new Date().toISOString(), motivo };
}

/** Única función que representa un envío real — exige `estado === "aprobado"`. Quien
 * la invoca (apps/api) debe además poder probar que `aprobadoPor` está poblado antes
 * de tocar el `CanalMensajeria` (ver ./canalMensajeria.ts). */
export function marcarEnviadoTrasAprobacion(borrador: BorradorEstado): ResultadoMarcarEnviado {
  if (borrador.estado !== "aprobado") {
    throw new AprobacionRequeridaError(borrador.id, borrador.estado);
  }
  return { estado: "enviado" };
}

/**
 * Punto de entrada explícito para cualquier intento de envío AUTOMÁTICO (worker de
 * mensajes programados, reintento, etc.) — nunca para un envío disparado por un clic
 * humano de "aprobar" (eso usa `marcarEnviadoTrasAprobacion` directamente). SIEMPRE
 * lanza `AprobacionRequeridaError`, incluso si `borrador.estado === "aprobado"`: la
 * regla de negocio (D-006, "sin ruta de envío directo para procesos automáticos") es
 * más estricta que "requiere aprobación previa" — ningún proceso sin un humano
 * presionando el botón en ese instante puede enviar, sin importar el estado guardado.
 * apps/api llama a esta función desde cualquier endpoint/worker que simule un intento
 * automático (`POST /rentas/:propertyId/borradores/:id/intento-automatico`),
 * precisamente para dejar el error tipado + la entrada de auditoría exigidos.
 */
export function intentarEnvioAutomatico(borrador: BorradorEstado): never {
  throw new AprobacionRequeridaError(borrador.id, borrador.estado);
}
