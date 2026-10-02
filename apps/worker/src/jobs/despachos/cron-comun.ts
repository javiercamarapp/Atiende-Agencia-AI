// Tipos compartidos de los barridos de sistema de despachos (D-26/D-27/D-28). Cada UNIDAD de trabajo (un CFDI, un cliente, un
// grupo de alertas) corre en su PROPIA transaccion: un error SQL real en una unidad la deja abortada (25P02) y su COMMIT haria
// ROLLBACK; con una transaccion por unidad el fallo queda aislado y el resto del barrido sigue (ver r4-fix-crons-transaccion-por-unidad).
import type { CronSatRepository } from "@atiende/domain-despachos";

/** Estructuralmente compatible con `EmitirNotificacionInput` de @atiende/db (el worker no depende de ese paquete). */
export interface NotificacionCron {
  readonly evento: string;
  readonly organizationId: string;
  readonly propertyId?: string | null;
  readonly clave: string;
  readonly parametros?: Readonly<Record<string, string | number>>;
  readonly entidadTipo?: string | null;
  readonly entidadId?: string | null;
}
export type NotificarCron = (n: NotificacionCron) => Promise<unknown>;

export interface UnidadCronSat {
  readonly repo: CronSatRepository;
  /** Emite en la MISMA transaccion de la unidad (best-effort: emitirNotificacion nunca lanza ni aborta la transaccion). */
  readonly notificar: NotificarCron;
}
/** Abre una transaccion de sistema propia para `fn` (en las pruebas, reutiliza el doble en memoria). */
export type WithUnidadCronSat = <T>(fn: (u: UnidadCronSat) => Promise<T>) => Promise<T>;

export function mensajeDeError(err: unknown): string {
  const texto = err instanceof Error ? err.message : String(err);
  return texto.length > 300 ? `${texto.slice(0, 299)}…` : texto;
}
