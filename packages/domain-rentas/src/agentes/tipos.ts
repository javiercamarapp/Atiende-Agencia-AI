import type { RentasVerticalRole } from "../roles.ts";

/**
 * Tipos base de automatización agéntica — port ACOTADO de rentas/packages/domain/src/
 * agentes/tipos.ts. El origen modelaba el rol como `RolAgente` (5 valores gruesos:
 * superadmin/admin_gestora/operador/contador/limpieza) + `NivelColaboradorAgente`
 * opcional (acceso_total/calendario_mensajeria/solo_calendario), SOLO relevante
 * cuando `rol === "operador"`. atiende-fusion YA APLANÓ esa misma distinción a nivel
 * de `RentasVerticalRole` (ver ../roles.ts: "operador:acceso_total" /
 * "operador:calendario_mensajeria" / "operador:solo_calendario" son roles de
 * vertical DISTINTOS, no un rol + un nivel) — la matriz de este paquete reutiliza
 * `RentasVerticalRole` directo, sin reintroducir el nivel de colaborador como un
 * segundo eje que ya no existe en este monorepo. `superadmin` tampoco se porta (fuera
 * de fase, ver ../roles.ts: depende de feat/fusion-superadmin-impersonacion).
 */
export interface ActorAgente {
  readonly usuarioId: string;
  readonly rol: RentasVerticalRole;
}

/** Definición de una tool del catálogo de agentes de rentas — subconjunto reducido
 * (sin `type`/wrapper) del JSON Schema que espera `LlmToolDefinition` de
 * `@atiende/agent-core` (ver ./catalogo.ts::toLlmToolDefinition). */
export interface ToolDefinicion {
  readonly nombre: string;
  readonly descripcion: string;
  readonly parametros: Record<string, unknown>;
  /** Resuelto en SERVIDOR (../matrizRoles.ts): el backend decide qué tool puede
   * invocar cada rol ANTES de construir la lista de tools que se pasa al modelo —
   * nunca como filtro posterior sobre lo que el modelo "decidió" pedir. */
  readonly rolesPermitidos: readonly RentasVerticalRole[];
}
