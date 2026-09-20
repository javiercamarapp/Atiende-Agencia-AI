// FASE 3 (producto) — zona horaria por negocio, parte despachos. Punto ÚNICO donde
// las rutas HTTP de este vertical resuelven la zona horaria REAL de una property
// (migración 012, `despachos.property_config`) antes de calcular "hoy" — mismo
// principio que `@atiende/core-tenancy::resolverZonaHorariaNegocio` documenta para
// el resto del servidor: ningún caller debe repetir `repo.findPropertyConfig(...)`
// a mano, para que conectar/desconectar esta columna sea un cambio de un solo
// lugar. Compartido por `vencimientos.ts`/`cobranza.ts`/`cierre-mensual.ts` — los 3
// call-sites reales de "hoy" auditados en esta fase (ver el comentario de cabecera
// de `@atiende/core-tenancy::fecha-negocio.ts`).
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import type { DespachosRepository } from "@atiende/domain-despachos";

/** Resuelve la zona horaria real de una property de despachos -- `null` (sin fila
 * de configuración todavía, o base sin la migración 012 aplicada -- ver
 * `PostgresDespachosRepository.findPropertyConfig`, degrada a `null` en
 * 42P01/42703, NUNCA lanza) cae al default de plataforma
 * (`ZONA_HORARIA_NEGOCIO_DEFAULT`) vía `resolverZonaHorariaNegocio`. */
export async function resolverZonaHorariaDespachosProperty(repo: DespachosRepository, propertyId: string): Promise<string> {
  const config = await repo.findPropertyConfig(propertyId);
  return resolverZonaHorariaNegocio(config?.zonaHoraria);
}
