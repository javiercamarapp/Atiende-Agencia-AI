// Rn-07 -- adaptador Postgres de las solicitudes ARCO de rentas, sobre el TenantDbSession del request (staff, RLS real).
// Base sin migrar (028 pendiente: 42883/42P01/42703): lecturas -> `disponible:false`, escrituras -> `unavailable` (503 en la
// ruta), siempre bajo SAVEPOINT porque la sesion es UNA transaccion por request. Los errores de negocio de la funcion SQL
// (42501, P0002, 22023, 55000) tambien se traducen bajo SAVEPOINT para no dejar la transaccion abortada.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { RentasPrivacidadRepository } from "./repository.ts";
import type { ArcoCanal, ArcoDerecho, ArcoEstado, ArcoEstadoDestino, EntradaSolicitudArco, EventoArco, FiltroSolicitudesArco, PaginaSolicitudesArco, ResultadoCambioEstadoArco, ResultadoRegistroArco, SolicitudArco } from "./tipos.ts";

interface SolicitudRow {
  id: string;
  derecho: ArcoDerecho;
  canal: ArcoCanal;
  estado: ArcoEstado;
  solicitante_nombre: string;
  solicitante_contacto: string;
  detalle: string | null;
  recibida_en: string;
  respuesta_vence_en: string;
  ejecucion_vence_en: string;
  resuelta_en: string | null;
  nota_resolucion: string | null;
  atendida_por: string | null;
  total: string;
}

const COLUMNAS = `id, derecho, canal, estado, solicitante_nombre, solicitante_contacto, detalle, recibida_en::text, respuesta_vence_en::text, ejecucion_vence_en::text,
  resuelta_en::text, nota_resolucion, atendida_por`;

const aSolicitud = (r: SolicitudRow): SolicitudArco => ({
  id: r.id,
  derecho: r.derecho,
  canal: r.canal,
  estado: r.estado,
  solicitanteNombre: r.solicitante_nombre,
  solicitanteContacto: r.solicitante_contacto,
  detalle: r.detalle,
  recibidaEn: r.recibida_en,
  respuestaVenceEn: r.respuesta_vence_en,
  ejecucionVenceEn: r.ejecucion_vence_en,
  resueltaEn: r.resuelta_en,
  notaResolucion: r.nota_resolucion,
  atendidaPor: r.atendida_por,
});

function codigoPg(err: unknown): string | undefined {
  return typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
}

const ERRORES_DE_NEGOCIO = new Set(["42501", "P0002", "22023", "55000"]);

export class PostgresRentasPrivacidadRepository implements RentasPrivacidadRepository {
  constructor(private readonly db: TenantDbSession) {}

  listar(organizationId: string, filtro: FiltroSolicitudesArco, pagina: { limit: number; offset: number }): Promise<PaginaSolicitudesArco> {
    return runWithSavepointFallback<PaginaSolicitudesArco>({
      session: this.db,
      savepointName: "sp_arco_listar",
      primary: async () => {
        const { rows } = await this.db.query<SolicitudRow>(
          `select ${COLUMNAS}, count(*) over () as total
             from rentas.arco_solicitud
            where organization_id = $1 and ($2::text is null or estado = $2) and ($3::text is null or derecho = $3)
            order by (estado in ('resuelta', 'rechazada')), recibida_en desc, seq desc
            limit $4 offset $5;`,
          [organizationId, filtro.estado ?? null, filtro.derecho ?? null, pagina.limit, pagina.offset],
        );
        const total = rows[0] ? Number(rows[0].total) : 0;
        const siguiente = pagina.offset + rows.length;
        return { disponible: true, total, items: rows.map(aSolicitud), nextOffset: siguiente < total ? siguiente : null };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false, total: 0, items: [], nextOffset: null }),
    });
  }

  listarEventos(organizationId: string, solicitudId: string): Promise<readonly EventoArco[] | null> {
    return runWithSavepointFallback<readonly EventoArco[] | null>({
      session: this.db,
      savepointName: "sp_arco_eventos",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string; solicitud_id: string; evento: EventoArco["evento"]; desde_estado: string | null; hacia_estado: string; nota: string | null; actor_id: string | null; creado_en: string }>(
          `select id, solicitud_id, evento, desde_estado, hacia_estado, nota, actor_id, creado_en::text
             from rentas.arco_evento where organization_id = $1 and solicitud_id = $2 order by creado_en, id;`,
          [organizationId, solicitudId],
        );
        return rows.map((r) => ({ id: r.id, solicitudId: r.solicitud_id, evento: r.evento, desde: r.desde_estado, hacia: r.hacia_estado, nota: r.nota, actorId: r.actor_id, creadoEn: r.creado_en }));
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => null,
    });
  }

  registrar(organizationId: string, e: EntradaSolicitudArco): Promise<ResultadoRegistroArco> {
    return runWithSavepointFallback<ResultadoRegistroArco>({
      session: this.db,
      savepointName: "sp_arco_registrar",
      primary: async () => {
        const { rows } = await this.db.query<{ out_id: string; out_creada: boolean }>(
          `select out_id, out_creada from rentas.arco_registrar($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz);`,
          [organizationId, e.derecho, e.canal, e.solicitanteNombre, e.solicitanteContacto, e.detalle, e.recibidaEn],
        );
        const r = rows[0];
        if (!r) return { outcome: "invalid_input" };
        return { outcome: r.out_creada ? "created" : "existing", id: r.out_id };
      },
      isRecoverable: (err) => isMigrationPendingError(err) || ERRORES_DE_NEGOCIO.has(codigoPg(err) ?? ""),
      fallback: async (err) => {
        if (isMigrationPendingError(err)) return { outcome: "unavailable" };
        const c = codigoPg(err);
        return { outcome: c === "22023" ? "invalid_input" : "forbidden" };
      },
    });
  }

  cambiarEstado(organizationId: string, solicitudId: string, estado: ArcoEstadoDestino, nota: string | null): Promise<ResultadoCambioEstadoArco> {
    return runWithSavepointFallback<ResultadoCambioEstadoArco>({
      session: this.db,
      savepointName: "sp_arco_estado",
      primary: async () => {
        const { rows } = await this.db.query<{ estado: ArcoEstado }>(`select rentas.arco_cambiar_estado($1::uuid, $2::uuid, $3, $4) as estado;`, [organizationId, solicitudId, estado, nota]);
        return { outcome: "updated", id: solicitudId, estado: rows[0]?.estado ?? estado };
      },
      isRecoverable: (err) => isMigrationPendingError(err) || ERRORES_DE_NEGOCIO.has(codigoPg(err) ?? ""),
      fallback: async (err) => {
        if (isMigrationPendingError(err)) return { outcome: "unavailable" };
        switch (codigoPg(err)) {
          case "P0002":
            return { outcome: "not_found" };
          case "55000":
            return { outcome: "invalid_transition" };
          case "22023":
            return { outcome: "invalid_input" };
          default:
            return { outcome: "forbidden" };
        }
      },
    });
  }
}
