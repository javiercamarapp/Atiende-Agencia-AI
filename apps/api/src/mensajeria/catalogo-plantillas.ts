// PL-31: acceso al catalogo de plantillas HSM por organizacion (core.whatsapp_plantilla, migracion 0049) desde el despachador de
// WhatsApp. La lectura corre en una sesion de SISTEMA (auth.uid() es null) dentro de la UNICA transaccion del despachador: todo
// acceso va dentro de `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT) para que una base sin la migracion (SQLSTATE
// 42P01/42883/42703) NO deje la transaccion abortada ni rompa el envio: cae a "no aprobada en el catalogo" y decide la lista global.
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { CatalogoPlantillas } from "@atiende/whatsapp-gateway";

/** Aviso estructurado SIN datos del cliente: el catalogo aun no esta migrado. */
function avisarCatalogoNoMigrado(): void {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", evento: "plantillas_whatsapp_no_migradas", contexto: "whatsapp_plantilla_aprobada" }));
}

/** Catalogo para `WhatsAppOutboundDispatcher.dispatchPending(..., { plantillas })`. Una consulta fallida distinta de "migracion
 *  pendiente" se propaga: el despachador la trata como no aprobada en el catalogo (lista global) y deja el error en el log. */
export function crearCatalogoPlantillas(db: TenantDbSession): CatalogoPlantillas {
  return {
    estaAprobada: (organizationId, templateName) =>
      runWithSavepointFallback<boolean>({
        session: db,
        primary: async () => {
          const { rows } = await db.query<{ aprobada: boolean }>("select core.whatsapp_plantilla_aprobada($1, $2) as aprobada;", [organizationId, templateName]);
          return rows[0]?.aprobada === true;
        },
        isRecoverable: (err) => isMigrationPendingError(err),
        fallback: async () => {
          avisarCatalogoNoMigrado();
          return false;
        },
      }),
  };
}
