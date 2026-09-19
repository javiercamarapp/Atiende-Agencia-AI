// PostgresBreakGlassRentasDataRepository -- adaptador de producción de
// `BreakGlassRentasDataRepository`.
//
// CORRECCIÓN (ver ../../migrations/018_break_glass_wiring.sql, sección 3): la
// versión original de este archivo advertía que debía construirse sobre
// `ManagedPostgresEngine.admin` para "saltarse" las policies normales de
// `rentas.ocupacion`/`rentas.guest_minimo`. Verificado contra el código real antes
// de corregirlo (no asumido): `admin` NO es `service_role` -- es el MISMO rol de
// mínimo privilegio que `withAppSession`, sin ningún `bypassrls` (ver el comentario
// de cabecera de `packages/db/src/managed-postgres-engine.ts`, y la confirmación
// explícita en `apps/api/src/production/deps.ts`: "la confirmación de que
// engine.admin NO es service_role"). Una lectura de `rentas.ocupacion` bajo
// `admin` sigue sujeta a las policies normales de esa tabla (solo staff con
// membership real) -- así que, tal como estaba, este adaptador SIEMPRE habría
// devuelto CERO filas contra Postgres real, sin importar quién llamara: el
// mecanismo nunca pudo haber funcionado.
//
// SESIÓN REQUERIDA (ya corregido): la sesión del PROPIO superadmin
// (`engine.withAppSession({ userId: actor.userId }, ...)`) -- MISMO patrón que
// `PostgresBreakGlassAuditRepository` (misma carpeta) y que
// `ProductionRentasOwnerPortalRepository` (ver el comentario de cabecera de ese
// archivo para el precedente exacto: una función `security definer`, dueña de su
// propia autorización completa, sobre la sesión por-request normal -- nunca
// `engine.admin`/`service_role`). `rentas.list_reservas_for_break_glass` (la
// función que este adaptador invoca) es quien de verdad "salta" las policies de
// `rentas.ocupacion` -- corre con el privilegio del DUEÑO de la función (quien
// aplicó la migración), no con el de `authenticated` -- pero solo después de
// verificar, DENTRO de la función, que `auth.uid() = p_caller_id`, que
// `p_caller_id` es superadmin real, y que existe una `rentas.break_glass_session`
// VIGENTE (sin cerrar, sin vencer) para exactamente ese actor+organización.
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { BreakGlassRentasDataRepository } from "./data-repository.ts";
import type { BreakGlassReservaResumen } from "./tipos.ts";

interface ReservaRow {
  ocupacion_id: string;
  property_id: string;
  unidad_id: string;
  check_in: string;
  check_out: string;
  estado: string;
  huesped_nombre: string | null;
  huesped_contacto: string | null;
}

export class PostgresBreakGlassRentasDataRepository implements BreakGlassRentasDataRepository {
  constructor(private readonly db: TenantDbSession) {}

  async listReservasTenant(organizationId: string, callerId: string): Promise<readonly BreakGlassReservaResumen[]> {
    const { rows } = await this.db.query<ReservaRow>(
      `select * from rentas.list_reservas_for_break_glass($1, $2);`,
      [callerId, organizationId],
    );
    return rows.map((r) => ({
      ocupacionId: r.ocupacion_id,
      propertyId: r.property_id,
      unidadId: r.unidad_id,
      checkIn: r.check_in,
      checkOut: r.check_out,
      estado: r.estado,
      huespedNombre: r.huesped_nombre,
      huespedContacto: r.huesped_contacto,
    }));
  }
}
