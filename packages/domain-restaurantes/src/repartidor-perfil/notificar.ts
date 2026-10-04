// Aviso in-app de licencia por vencer / vencida (R-15). Emite al owner/admin (destinatarios que resuelve la base) a traves del
// productor unico `emitirNotificacion`. Sin PII: el texto sale del catalogo y el unico parametro es el numero de dias. Dedupe MENSUAL
// por repartidor: la clave es `<usuario>-<AAAA-MM>` con el mes UTC del reloj (UNA sola referencia: el guardado usa el dia local de la sucursal y el barrido el UTC, y cerca del cambio de mes darian claves distintas), asi un sondeo repetido no vuelve a avisar en el mismo mes.
// Best-effort: `emitirNotificacion` nunca lanza (SAVEPOINT interno), asi que un fallo del aviso no revierte el guardado del perfil.
import { emitirNotificacion } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { LICENCIA_AVISO_DIAS, diasParaVencer, hoyUtc } from "./perfil.ts";

/** Emite el aviso que corresponda segun los dias restantes; devuelve true si se emitio a alguien nuevo. `hoy` = YYYY-MM-DD. */
export async function notificarLicenciaRepartidor(db: TenantDbSession, input: { readonly organizationId: string; readonly userId: string; readonly diasRestantes: number; readonly hoy: string }): Promise<boolean> {
  if (input.diasRestantes >= LICENCIA_AVISO_DIAS) return false;
  const vencida = input.diasRestantes < 0;
  const r = await emitirNotificacion(db, {
    evento: vencida ? "restaurantes.repartidor.licencia_vencida" : "restaurantes.repartidor.licencia_por_vencer",
    organizationId: input.organizationId,
    clave: `${input.userId}-${hoyUtc(new Date()).slice(0, 7)}`,
    parametros: vencida ? { dias: Math.abs(input.diasRestantes) } : { dias: input.diasRestantes },
    entidadTipo: "repartidor_perfil",
    entidadId: input.userId,
  });
  return r.estado === "emitida";
}

/** Atajo para el guardado: calcula los dias a partir de la vigencia recien guardada. */
export async function notificarLicenciaSiCorresponde(db: TenantDbSession, organizationId: string, userId: string, vigencia: string | null, hoy: string): Promise<boolean> {
  if (vigencia === null) return false;
  return notificarLicenciaRepartidor(db, { organizationId, userId, diasRestantes: diasParaVencer(vigencia, hoy), hoy });
}
