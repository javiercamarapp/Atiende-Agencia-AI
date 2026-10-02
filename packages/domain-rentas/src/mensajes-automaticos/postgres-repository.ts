// Rn-24 / Rn-25 -- adaptador Postgres del puerto de mensajes automaticos, sobre el TenantDbSession
// del request (staff, RLS real) o de la sesion de sistema del cron (auth.uid() NULL).
//
// Base sin migrar (migracion 029 pendiente: SQLSTATE 42883/42P01/42703): las operaciones de STAFF
// devuelven `disponible: false` (la ruta responde "aun no disponible", nunca un 500). Como la sesion
// es UNA transaccion por request y Postgres la deja ABORTADA tras el error (25P02), esa degradacion
// corre bajo SAVEPOINT (runWithSavepointFallback). Las operaciones de SISTEMA no degradan aqui: dejan
// subir el error y el cron (una transaccion por reserva, ver ./ejecutor.ts) decide.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { CanalMensajeriaCodigo } from "../mensajeria/tipos.ts";
import type { RentasMensajesAutomaticosRepository } from "./repository.ts";
import type { CandidatoMensajeAutomatico, EntradaProgramacion, EventoAutomatico, ProgramacionMensaje, ResultadoMensajesAutomaticos } from "./tipos.ts";

interface ProgramacionRow {
  property_id: string;
  evento: EventoAutomatico;
  plantilla_id: string;
  offset_horas: number;
  activo: boolean;
  actualizado_en: Date | string;
}

const COLUMNAS_PROGRAMACION = "property_id, evento, plantilla_id, offset_horas, activo, actualizado_en";

const aProgramacion = (r: ProgramacionRow): ProgramacionMensaje => ({
  propertyId: r.property_id,
  evento: r.evento,
  plantillaId: r.plantilla_id,
  offsetHoras: r.offset_horas,
  activo: r.activo,
  actualizadoEn: r.actualizado_en instanceof Date ? r.actualizado_en.toISOString() : String(r.actualizado_en),
});

interface CandidatoRow {
  ocupacion_id: string;
  organization_id: string;
  property_id: string;
  unidad_id: string;
  evento: EventoAutomatico;
  offset_horas: number;
  plantilla_id: string;
  plantilla_cuerpo: string;
  plantilla_aprobada: boolean;
  plantilla_activa: boolean;
  canal_codigo: CanalMensajeriaCodigo;
  check_in: string;
  check_out: string;
  huesped_nombre: string | null;
  propiedad_nombre: string;
  unidad_nombre: string;
  zona_horaria: string;
}

export class PostgresRentasMensajesAutomaticosRepository implements RentasMensajesAutomaticosRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async conDegradacion<T>(nombre: string, primary: () => Promise<T>): Promise<ResultadoMensajesAutomaticos<T>> {
    return runWithSavepointFallback<ResultadoMensajesAutomaticos<T>>({
      session: this.db,
      savepointName: `sp_mensajes_auto_${nombre}`,
      primary: async () => ({ disponible: true, valor: await primary() }),
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false }),
    });
  }

  listarProgramaciones(propertyId: string): Promise<ResultadoMensajesAutomaticos<readonly ProgramacionMensaje[]>> {
    return this.conDegradacion("listar", async () => {
      const { rows } = await this.db.query<ProgramacionRow>(`select ${COLUMNAS_PROGRAMACION} from rentas.mensaje_automatico_config where property_id = $1 order by evento asc;`, [propertyId]);
      return rows.map(aProgramacion);
    });
  }

  guardarProgramacion(e: EntradaProgramacion): Promise<ResultadoMensajesAutomaticos<ProgramacionMensaje>> {
    return this.conDegradacion("guardar", async () => {
      const { rows } = await this.db.query<ProgramacionRow>(
        `insert into rentas.mensaje_automatico_config (organization_id, property_id, evento, plantilla_id, offset_horas, activo, actualizado_por)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (property_id, evento) do update set
           plantilla_id = excluded.plantilla_id, offset_horas = excluded.offset_horas, activo = excluded.activo,
           actualizado_por = excluded.actualizado_por, actualizado_en = now()
         returning ${COLUMNAS_PROGRAMACION};`,
        [e.organizationId, e.propertyId, e.evento, e.plantillaId, e.offsetHoras, e.activo, e.actorId],
      );
      return aProgramacion(rows[0]!);
    });
  }

  async listarCandidatos(ahora: Date, limite: number): Promise<readonly CandidatoMensajeAutomatico[]> {
    const { rows } = await this.db.query<CandidatoRow>(`select ocupacion_id, organization_id, property_id, unidad_id, evento, offset_horas, plantilla_id, plantilla_cuerpo, plantilla_aprobada, plantilla_activa, canal_codigo,
              to_char(check_in, 'YYYY-MM-DD') as check_in, to_char(check_out, 'YYYY-MM-DD') as check_out, huesped_nombre, propiedad_nombre, unidad_nombre, zona_horaria
         from rentas.sistema_listar_mensajes_automaticos($1::timestamptz, $2::int);`, [ahora.toISOString(), limite]);
    return rows.map((r) => ({
      ocupacionId: r.ocupacion_id,
      organizationId: r.organization_id,
      propertyId: r.property_id,
      unidadId: r.unidad_id,
      evento: r.evento,
      offsetHoras: r.offset_horas,
      plantillaId: r.plantilla_id,
      plantillaCuerpo: r.plantilla_cuerpo,
      plantillaAprobada: r.plantilla_aprobada,
      plantillaActiva: r.plantilla_activa,
      canal: r.canal_codigo,
      checkIn: r.check_in,
      checkOut: r.check_out,
      huespedNombre: r.huesped_nombre,
      propiedadNombre: r.propiedad_nombre,
      unidadNombre: r.unidad_nombre,
      zonaHoraria: r.zona_horaria,
    }));
  }

  async crearBorradorAutomatico(e: { ocupacionId: string; evento: EventoAutomatico; plantillaId: string; texto: string }): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string | null }>(`select rentas.sistema_crear_borrador_automatico($1::uuid, $2, $3::uuid, $4) as id;`, [e.ocupacionId, e.evento, e.plantillaId, e.texto]);
    return rows[0]?.id ?? null;
  }

  async registrarOmitido(e: { ocupacionId: string; evento: EventoAutomatico; plantillaId: string }): Promise<boolean> {
    const { rows } = await this.db.query<{ ok: boolean }>(`select rentas.sistema_registrar_mensaje_omitido($1::uuid, $2, $3::uuid) as ok;`, [e.ocupacionId, e.evento, e.plantillaId]);
    return rows[0]?.ok === true;
  }
}
