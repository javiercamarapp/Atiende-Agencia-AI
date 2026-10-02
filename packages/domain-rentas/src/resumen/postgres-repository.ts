// Rn-26 -- adaptador Postgres del Resumen operativo. Solo SELECT de agregados sobre el TenantDbSession del request (RLS
// real: core.has_property_access en cada tabla; rentas.acceso_reserva además exige can_manage_acceso). Sin PII: ni
// nombres, ni contactos, ni texto de mensajes.
//
// Compatibilidad con la base sin migrar: cada método corre bajo SAVEPOINT (runWithSavepointFallback). La sesión es UNA
// transacción por request; un 42P01/42703/42883 sin SAVEPOINT la dejaría abortada (25P02) y rompería los demás bloques
// del Resumen. Un error de otra clase se repropaga (no se enmascara).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { AccesoResumen, BorradoresResumen, LlegadasSalidasHoy, RentasResumenRepository, TareasResumen } from "./repository.ts";

/** 42501 = el rol no puede leer la tabla (p. ej. acceso_reserva solo la ve la administración): bloque no disponible, no 500. */
function esDegradable(err: unknown): boolean {
  return isMigrationPendingError(err) || (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42501");
}

export class PostgresRentasResumenRepository implements RentasResumenRepository {
  constructor(private readonly db: TenantDbSession) {}

  private conRespaldo<T>(primary: () => Promise<T>): Promise<T | null> {
    return runWithSavepointFallback<T | null>({ session: this.db, primary, isRecoverable: esDegradable, fallback: async () => null });
  }

  llegadasSalidas(propertyId: string, fecha: string): Promise<LlegadasSalidasHoy | null> {
    return this.conRespaldo(async () => {
      const r = await this.db.query<{ llegadas: string; salidas: string }>(
        `select count(*) filter (where lower(o.rango) = $2::date)::text as llegadas,
                count(*) filter (where upper(o.rango) = $2::date)::text as salidas
         from rentas.ocupacion o
         where o.property_id = $1 and o.capa = 'reserva' and o.estado = 'confirmado'
           and (lower(o.rango) = $2::date or upper(o.rango) = $2::date);`,
        [propertyId, fecha],
      );
      return { llegadas: Number(r.rows[0]?.llegadas ?? 0), salidas: Number(r.rows[0]?.salidas ?? 0) };
    });
  }

  borradores(propertyId: string): Promise<BorradoresResumen | null> {
    return this.conRespaldo(async () => {
      const r = await this.db.query<{ pendientes: string; ultimo_ia: string | null }>(
        `select count(*) filter (where b.estado = 'pendiente_aprobacion')::text as pendientes,
                max(b.creado_en) filter (where b.generado_por = 'agente_llm')::text as ultimo_ia
         from rentas.borrador_mensaje b
         join rentas.conversacion c on c.id = b.conversacion_id
         where c.property_id = $1;`,
        [propertyId],
      );
      const fila = r.rows[0];
      return { pendientes: Number(fila?.pendientes ?? 0), ultimoBorradorIaEn: fila?.ultimo_ia ? new Date(fila.ultimo_ia).toISOString() : null };
    });
  }

  tareas(propertyId: string, ahoraIso: string): Promise<TareasResumen | null> {
    return this.conRespaldo(async () => {
      const r = await this.db.query<{ pendientes: string; vencidas: string; ultima_checkout: string | null }>(
        `select count(*) filter (where t.estado not in ('completada', 'cancelada'))::text as pendientes,
                count(*) filter (where t.estado not in ('completada', 'cancelada') and t.sla_vence_en is not null and t.sla_vence_en < $2::timestamptz)::text as vencidas,
                max(t.creado_en) filter (where t.ocupacion_unidad_id is not null)::text as ultima_checkout
         from rentas.tarea_operativa t
         where t.property_id = $1;`,
        [propertyId, ahoraIso],
      );
      const fila = r.rows[0];
      return {
        pendientes: Number(fila?.pendientes ?? 0),
        vencidas: Number(fila?.vencidas ?? 0),
        ultimaTareaPorCheckoutEn: fila?.ultima_checkout ? new Date(fila.ultima_checkout).toISOString() : null,
      };
    });
  }

  acceso(propertyId: string): Promise<AccesoResumen | null> {
    return this.conRespaldo(async () => {
      const politica = await this.db.query<{ activo: boolean }>(`select activo from rentas.acceso_politica where property_id = $1;`, [propertyId]);
      const lib = await this.db.query<{ ultima: string | null }>(`select max(liberado_en)::text as ultima from rentas.acceso_reserva where property_id = $1;`, [propertyId]);
      const ultima = lib.rows[0]?.ultima;
      return { politicaActiva: politica.rows[0]?.activo === true, ultimaLiberacionEn: ultima ? new Date(ultima).toISOString() : null };
    });
  }
}
