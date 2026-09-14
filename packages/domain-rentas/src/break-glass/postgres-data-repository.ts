// PostgresBreakGlassRentasDataRepository -- adaptador de producción de
// `BreakGlassRentasDataRepository`.
//
// ADVERTENCIA DE PRIVILEGIO (léase antes de wirear esto a producción real, mismo
// criterio que owner-portal/postgres-repository.ts): esta clase DEBE construirse sobre
// una sesión de privilegio administrativo (`ManagedPostgresEngine.admin`, o
// equivalente -- NUNCA la sesión RLS por-request de un superadmin autenticado vía
// `engine.withAppSession({ userId: actor.userId }, ...)`). El punto ENTERO de romper
// cristal es leer datos de un tenant al que el superadmin NO pertenece -- ninguna
// policy de `rentas.ocupacion`/`rentas.guest_minimo` lo dejaría pasar bajo RLS normal
// (correctamente: esas policies existen para aislar tenants entre sí). El acceso
// elevado real, deliberado y AUDITADO es exactamente lo que esta clase ejecuta -- la
// auditoría (PostgresBreakGlassAuditRepository, misma carpeta) es la contrapartida que
// hace que ese privilegio sea seguro de otorgar, no una casualidad de diseño.
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

  async listReservasTenant(organizationId: string): Promise<readonly BreakGlassReservaResumen[]> {
    const { rows } = await this.db.query<ReservaRow>(
      `select o.id as ocupacion_id, o.property_id, o.unidad_id,
              lower(o.rango)::text as check_in, upper(o.rango)::text as check_out,
              o.estado, g.nombre as huesped_nombre, g.contacto as huesped_contacto
       from rentas.ocupacion o
       left join rentas.guest_minimo g on g.id = o.huesped_minimo_id
       where o.organization_id = $1 and o.capa = 'reserva'
       order by lower(o.rango) desc;`,
      [organizationId],
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
