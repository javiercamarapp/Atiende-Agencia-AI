// Rn-18 / Rn-19 -- helpers HTTP compartidos por las rutas de reglas de comision y de catalogo.
import type { RentasCatalogoRepository, ResultadoCatalogo } from "@atiende/domain-rentas";
import { PostgresRentasCatalogoRepository } from "@atiende/domain-rentas";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { ApiError } from "@atiende/core-auth";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";


/** Repositorio del catalogo: el inyectado por los tests o el adaptador Postgres sobre la sesion del request. */
export function catalogoRepo(deps: AppDeps, db: TenantDbSession): RentasCatalogoRepository {
  return deps.rentasCatalogoRepo ? deps.rentasCatalogoRepo(db) : new PostgresRentasCatalogoRepository(db);
}

/**
 * Traduce el resultado de una escritura a una respuesta HTTP:
 *  - `no_disponible` (la migracion 027 aun no esta aplicada en esta base) -> 503 honesto, nunca un 500;
 *  - `rechazado` (regla de negocio de la funcion SQL) -> 403/400/409/404 con su mensaje.
 */
export function valorOError<T>(res: ResultadoCatalogo<T>, accion: string, migracion = "027"): T {
  if (res.estado === "ok") return res.valor;
  if (res.estado === "no_disponible") {
    throw Errors.serviceUnavailable(`${accion} todavía no está disponible en esta base de datos (falta aplicar la migración ${migracion} de rentas).`);
  }
  throw errorDeRechazo(res.motivo, res.mensaje);
}

function errorDeRechazo(motivo: string, mensaje: string): ApiError {
  switch (motivo) {
    case "sin_permiso":
      return Errors.forbidden(mensaje);
    case "invalido":
      return Errors.validation(mensaje);
    case "no_encontrado":
      return Errors.notFound(mensaje);
    default:
      // duplicado y regla_integridad: el estado actual no permite la operacion.
      return Errors.conflict(mensaje);
  }
}
