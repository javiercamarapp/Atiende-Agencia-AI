// Utilidades compartidas de las rutas del piloto automatico (paridad3 D-31 / D-P3-15 / D-P3-21, migracion 027).
import { ApiError } from "@atiende/core-auth";
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PilotoEntradaInvalidaError, PilotoNoDisponibleError, PilotoNoEncontradoError, PilotoSinAccesoError, PostgresPilotoRepository } from "@atiende/domain-despachos";
import type { PilotoRepository } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

export const pilotoDe = (deps: AppDeps, db: TenantDbSession): PilotoRepository => (deps.pilotoRepo ? deps.pilotoRepo(db) : new PostgresPilotoRepository(db));

/** Errores de dominio del piloto -> HTTP. La base ya devolvio mensajes sin detalles internos. */
export function traducirPiloto(err: unknown): never {
  if (err instanceof PilotoNoDisponibleError) throw Errors.serviceUnavailable("Esta función aún no está disponible en este ambiente: falta aplicar la migración 027.");
  if (err instanceof PilotoSinAccesoError) throw Errors.forbidden();
  if (err instanceof PilotoNoEncontradoError) throw Errors.notFound("No encontrado.");
  if (err instanceof PilotoEntradaInvalidaError) throw Errors.validation(err.message);
  throw err;
}

export type ResultadoSeguro<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly error: string };

function textoSeguro(err: unknown): string {
  if (err instanceof ApiError && err.status < 500) return err.message.slice(0, 200);
  if (err instanceof PilotoEntradaInvalidaError || err instanceof PilotoNoEncontradoError) return err.message.slice(0, 200);
  if (err instanceof Error && (err as { code?: string }).code === "22023") return err.message.replace(/^[a-z_]+:\s*/, "").slice(0, 200);
  return "error_interno";
}

/**
 * Corre un paso «de mejor esfuerzo» dentro de su propio SAVEPOINT: si falla por CUALQUIER motivo se revierte solo ese paso y el request sigue con la
 * transaccion utilizable (un try/catch sin SAVEPOINT dejaria la transaccion abortada y el COMMIT haria ROLLBACK del cierre ya hecho).
 */
export function pasoSeguro<T>(db: TenantDbSession, nombre: string, fn: () => Promise<T>): Promise<ResultadoSeguro<T>> {
  return runWithSavepointFallback<ResultadoSeguro<T>>({
    session: db,
    savepointName: `sp_paso_${nombre}`,
    primary: async () => ({ ok: true, valor: await fn() }),
    isRecoverable: () => true,
    // Solo los errores de negocio (ApiError 4xx), de dominio del piloto y los RAISE propios de las funciones (22023, mensaje redactado para el usuario) traen un
    // texto apto para mostrar; cualquier otro (texto crudo de Postgres con nombres de funciones o restricciones) se reduce a un codigo generico.
    fallback: async (err) => ({ ok: false, error: textoSeguro(err) }),
  });
}
