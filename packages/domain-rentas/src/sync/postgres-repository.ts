// PostgresRentasCalendarSyncRepository — adaptador de producción de
// `RentasCalendarSyncRepository`, sobre el `TenantDbSession` genérico de
// `@atiende/core-tenancy` (mismo contrato que `PostgresRentasRepository`). Ejecuta las
// queries reales contra `rentas.canal_feed_externo`/`rentas.evento_canal_importado`/
// `rentas.bloqueo_exportado` (migrations/008_ical_sync_schema.sql), y lecturas de solo
// lectura contra `rentas.ocupacion` (migrations/001_rentas_schema.sql) para
// export/recuperación de bookkeeping — nunca escribe esa tabla directamente: las
// escrituras de `rentas.ocupacion` SIEMPRE pasan por
// `crearReservaConfirmada`/`modificarFechasReserva`/`cancelarOcupacion` de
// `../aplicacion/reservas.ts` (ver ./motor.ts).
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { RangoFechas } from "../tipos.ts";
import type { UidActivoInterno } from "./reconciliacion.ts";
import { ESTADO_FEED_INICIAL, type EstadoFeedCanal } from "./cuarentena.ts";
import type { RentasCalendarSyncRepository } from "./repository.ts";
import type { BloqueoExportadoPrevio, EntradaUpsertBloqueoExportado, EntradaUpsertEventoImportado, FeedExternoRecord, NewFeedExternoInput, OcupacionActivaExportable, VersionPreviaAlmacenada } from "./tipos.ts";

interface FeedRow {
  id: string;
  organization_id: string;
  property_id: string;
  unidad_id: string;
  canal_id: string;
  canal_codigo: string;
  url_importacion: string;
  activo: boolean;
  ultima_sincronizacion_exitosa_en: string | null;
  en_cuarentena_desde: string | null;
  intentos_fallidos_consecutivos: number;
  motivo_cuarentena: string | null;
  etag_import: string | null;
  ultima_modificacion_http_import: string | null;
  drift_ultima_reconciliacion_completa: number;
  ultimo_resumen: unknown;
}

function filaAFeedRecord(f: FeedRow): FeedExternoRecord {
  return {
    id: f.id,
    organizationId: f.organization_id,
    propertyId: f.property_id,
    unidadId: f.unidad_id,
    canalId: f.canal_id,
    canalCodigo: f.canal_codigo,
    urlImportacion: f.url_importacion,
    activo: f.activo,
    estadoSync: {
      ultimaSincronizacionExitosaEn: f.ultima_sincronizacion_exitosa_en,
      enCuarentenaDesde: f.en_cuarentena_desde,
      intentosFallidosConsecutivos: f.intentos_fallidos_consecutivos,
      motivoCuarentena: f.motivo_cuarentena,
    },
    etagImport: f.etag_import,
    ultimaModificacionHttpImport: f.ultima_modificacion_http_import,
    driftUltimaReconciliacionCompleta: f.drift_ultima_reconciliacion_completa,
    ultimoResumen: f.ultimo_resumen,
  };
}

const SELECT_FEED = `SELECT cfe.id, cfe.organization_id, cfe.property_id, cfe.unidad_id, cfe.canal_id, c.codigo AS canal_codigo,
          cfe.url_importacion, cfe.activo, cfe.ultima_sincronizacion_exitosa_en, cfe.en_cuarentena_desde,
          cfe.intentos_fallidos_consecutivos, cfe.motivo_cuarentena, cfe.etag_import,
          cfe.ultima_modificacion_http_import, cfe.drift_ultima_reconciliacion_completa, cfe.ultimo_resumen
   FROM rentas.canal_feed_externo cfe
   JOIN rentas.canal c ON c.id = cfe.canal_id`;

export class PostgresRentasCalendarSyncRepository implements RentasCalendarSyncRepository {
  constructor(private readonly db: TenantDbSession) {}

  async findZonaHorariaPropiedad(propertyId: string): Promise<string> {
    const fila = await this.db.query<{ zona_horaria: string }>(`SELECT zona_horaria FROM rentas.property_config WHERE property_id = $1`, [propertyId]);
    return fila.rows[0]?.zona_horaria ?? "UTC";
  }

  async connectFeed(input: NewFeedExternoInput): Promise<{ id: string }> {
    const fila = await this.db.query<{ id: string }>(
      `INSERT INTO rentas.canal_feed_externo (organization_id, property_id, unidad_id, canal_id, url_importacion, activo)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (unidad_id, canal_id) DO UPDATE SET url_importacion = EXCLUDED.url_importacion, activo = true, updated_at = now()
       RETURNING id`,
      [input.organizationId, input.propertyId, input.unidadId, input.canalId, input.urlImportacion],
    );
    return { id: fila.rows[0]!.id };
  }

  async disconnectFeed(propertyId: string, unidadId: string, canalId: string): Promise<boolean> {
    const fila = await this.db.query<{ id: string }>(
      `UPDATE rentas.canal_feed_externo SET activo = false, updated_at = now()
       WHERE property_id = $1 AND unidad_id = $2 AND canal_id = $3 AND activo
       RETURNING id`,
      [propertyId, unidadId, canalId],
    );
    return fila.rows.length > 0;
  }

  async findFeed(propertyId: string, unidadId: string, canalId: string): Promise<FeedExternoRecord | null> {
    const fila = await this.db.query<FeedRow>(`${SELECT_FEED} WHERE cfe.property_id = $1 AND cfe.unidad_id = $2 AND cfe.canal_id = $3`, [propertyId, unidadId, canalId]);
    return fila.rows[0] ? filaAFeedRecord(fila.rows[0]) : null;
  }

  async findFeedById(propertyId: string, feedId: string): Promise<FeedExternoRecord | null> {
    const fila = await this.db.query<FeedRow>(`${SELECT_FEED} WHERE cfe.property_id = $1 AND cfe.id = $2`, [propertyId, feedId]);
    return fila.rows[0] ? filaAFeedRecord(fila.rows[0]) : null;
  }

  async listFeedsForUnidad(propertyId: string, unidadId: string): Promise<FeedExternoRecord[]> {
    const filas = await this.db.query<FeedRow>(`${SELECT_FEED} WHERE cfe.property_id = $1 AND cfe.unidad_id = $2 ORDER BY c.codigo`, [propertyId, unidadId]);
    return filas.rows.map(filaAFeedRecord);
  }

  async listFeedsActivos(): Promise<FeedExternoRecord[]> {
    const filas = await this.db.query<FeedRow>(`${SELECT_FEED} WHERE cfe.activo`);
    return filas.rows.map(filaAFeedRecord);
  }

  async persistFeedSyncState(feedId: string, estado: EstadoFeedCanal, etag: string | null, ultimaModificacionHttp: string | null, drift: number | undefined, ultimoResumen: unknown): Promise<void> {
    await this.db.query(
      `UPDATE rentas.canal_feed_externo SET
         ultima_sincronizacion_exitosa_en = $2, en_cuarentena_desde = $3, intentos_fallidos_consecutivos = $4,
         motivo_cuarentena = $5, etag_import = $6, ultima_modificacion_http_import = $7,
         drift_ultima_reconciliacion_completa = COALESCE($8, drift_ultima_reconciliacion_completa),
         ultimo_resumen = $9::jsonb, updated_at = now()
       WHERE id = $1`,
      [feedId, estado.ultimaSincronizacionExitosaEn, estado.enCuarentenaDesde, estado.intentosFallidosConsecutivos, estado.motivoCuarentena, etag, ultimaModificacionHttp, drift ?? null, JSON.stringify(ultimoResumen ?? null)],
    );
  }

  async findVersionPrevia(unidadId: string, canalId: string, uid: string): Promise<VersionPreviaAlmacenada | null> {
    // LEFT JOIN trae el rango vigente de la ocupación asociada (cuando existe) para
    // la heurística de "UID reciclado" sin SEQUENCE comparable (ver
    // ./resolucion-version.ts).
    const fila = await this.db.query<{ sequence: number | null; dtstamp: string; hash_contenido: string; ocupacion_id: string | null; rango_inicio: string | null; rango_fin: string | null }>(
      `SELECT eci.sequence, eci.dtstamp::text AS dtstamp, eci.hash_contenido, eci.ocupacion_id,
              lower(o.rango)::text AS rango_inicio, upper(o.rango)::text AS rango_fin
       FROM rentas.evento_canal_importado eci
       LEFT JOIN rentas.ocupacion o ON o.id = eci.ocupacion_id
       WHERE eci.unidad_id = $1 AND eci.canal_id = $2 AND eci.uid_evento = $3`,
      [unidadId, canalId, uid],
    );
    const f = fila.rows[0];
    if (!f) return null;
    return {
      sequence: f.sequence,
      dtstamp: f.dtstamp,
      hashContenido: f.hash_contenido,
      ocupacionId: f.ocupacion_id,
      rango: f.rango_inicio !== null && f.rango_fin !== null ? { inicio: f.rango_inicio, fin: f.rango_fin } : null,
    };
  }

  // Hallazgo de auditoría (a3, ALTA, verificado contra Postgres real) — el INSERT
  // original omitía `organization_id`/`property_id`, columnas NOT NULL sin default de
  // `rentas.evento_canal_importado` (supabase/migrations/20240101000057_008_ical_sync_
  // schema.sql:56-75; solo esa migración y la 094 tocan la tabla, y la 094 solo agrega
  // policies/grants). Contra Postgres real, TODO upsert con `sobrescribirVersion=true`
  // (el camino real de "aplicar"/"eco") disparaba 23502 antes siquiera de evaluar el
  // `ON CONFLICT` — el import de rentas NUNCA funcionó contra la base real, solo contra
  // el repositorio en memoria de los tests (que no valida NOT NULL). Fix: derivar el
  // tenant de la unidad con un JOIN, igual que ya hace `crearReservaConfirmada`
  // (aplicacion/reservas.ts) al leer `rentas.unidad` en la MISMA sesión de sistema —
  // esa lectura ya tiene RLS/GRANT reales (escape hatch `auth.uid() is null`,
  // supabase/migrations/20240101000094_015_cron_publico_rls_escape_hatch.sql). Nunca se
  // vuelven a escribir en el UPDATE del `ON CONFLICT`: el tenant de una unidad no
  // cambia, así que solo se fija en el INSERT inicial.
  async upsertEventoImportado(unidadId: string, canalId: string, entrada: EntradaUpsertEventoImportado): Promise<void> {
    if (entrada.sobrescribirVersion) {
      // Hallazgo de revisión de PR #175 (no bloqueante) — un `INSERT ... SELECT ...
      // FROM rentas.unidad u WHERE u.id = $1` inserta CERO filas, sin ningún error,
      // si la unidad no es visible para la sesión (RLS) o no existe (antes era un
      // `SELECT` sin `FROM`, que siempre producía exactamente 1 fila). Hoy esto no se
      // da en el cron real (sesión de sistema, policy de `SELECT` de `rentas.unidad`
      // ya abierta por la migración 094, FK `feed -> unidad`), pero el fallo sería
      // silencioso: el evento quedaría contado como "aplicado" (la reserva de
      // `crearReservaConfirmada` ya se creó, en la MISMA transacción, ANTES de esta
      // llamada) mientras el bookkeeping de `evento_canal_importado` nunca se
      // escribe — el ciclo siguiente repetiría la recuperación de bookkeeping para
      // siempre (`buscarOcupacionActivaParaRecuperarBookkeeping`) sin converger
      // jamás. `RETURNING id` + lanzar si no vino ninguna fila convierte ese
      // silencio en un error real de Postgres, que el SAVEPOINT por evento de
      // `motor.ts` ya aísla como cualquier otro fallo de este repositorio.
      const fila = await this.db.query<{ id: string }>(
        `INSERT INTO rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
         SELECT u.organization_id, u.property_id, $1, $2, $3, $4, $5, $6, $7, $8
         FROM rentas.unidad u
         WHERE u.id = $1
         ON CONFLICT (unidad_id, canal_id, uid_evento) DO UPDATE SET
           sequence = EXCLUDED.sequence, dtstamp = EXCLUDED.dtstamp, hash_contenido = EXCLUDED.hash_contenido,
           ocupacion_id = EXCLUDED.ocupacion_id, ultima_accion = EXCLUDED.ultima_accion, updated_at = now()
         RETURNING id`,
        [unidadId, canalId, entrada.uid, entrada.sequence, entrada.dtstamp, entrada.hashContenido, entrada.ocupacionId, entrada.ultimaAccion],
      );
      if (fila.rows.length === 0) {
        throw new Error(`upsertEventoImportado: 0 filas insertadas/actualizadas para unidad_id=${unidadId} (¿unidad inexistente o no visible para la sesión?)`);
      }
    } else {
      await this.db.query(`UPDATE rentas.evento_canal_importado SET ultima_accion = $4, updated_at = now() WHERE unidad_id = $1 AND canal_id = $2 AND uid_evento = $3`, [unidadId, canalId, entrada.uid, entrada.ultimaAccion]);
    }
  }

  async listUidsActivosInternos(unidadId: string, canalId: string): Promise<UidActivoInterno[]> {
    const fila = await this.db.query<{ uid_canal: string; ocupacion_id: string }>(
      `SELECT eci.uid_evento AS uid_canal, eci.ocupacion_id
       FROM rentas.evento_canal_importado eci
       JOIN rentas.ocupacion o ON o.id = eci.ocupacion_id
       WHERE eci.unidad_id = $1 AND eci.canal_id = $2 AND o.estado <> 'cancelado'`,
      [unidadId, canalId],
    );
    return fila.rows.map((r) => ({ ocupacionId: r.ocupacion_id, uidCanal: r.uid_canal }));
  }

  async buscarOcupacionActivaParaRecuperarBookkeeping(unidadId: string, canalId: string, externalId: string, rango: RangoFechas): Promise<string | null> {
    const fila = await this.db.query<{ id: string }>(
      `SELECT id FROM rentas.ocupacion
       WHERE unidad_id = $1 AND canal_origen_id = $2 AND external_id = $3 AND estado <> 'cancelado'
         AND rango = daterange($4, $5, '[)')
       ORDER BY created_at ASC
       LIMIT 1`,
      [unidadId, canalId, externalId, rango.inicio, rango.fin],
    );
    return fila.rows[0]?.id ?? null;
  }

  async contarOcupacionesActivasDelCanal(unidadId: string, canalId: string): Promise<number> {
    const fila = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM rentas.ocupacion
       WHERE unidad_id = $1 AND canal_origen_id = $2 AND estado <> 'cancelado' AND bloqueante AND capa = 'reserva'`,
      [unidadId, canalId],
    );
    return Number(fila.rows[0]!.n);
  }

  async listHashesExportadosRecientes(unidadId: string): Promise<string[]> {
    const fila = await this.db.query<{ hash_contenido: string }>(
      `SELECT be.hash_contenido FROM rentas.bloqueo_exportado be
       JOIN rentas.ocupacion o ON o.id = be.ocupacion_id
       WHERE o.unidad_id = $1`,
      [unidadId],
    );
    return fila.rows.map((r) => r.hash_contenido);
  }

  async listCanalesExportadosDeRango(unidadId: string, rango: RangoFechas): Promise<string[]> {
    const fila = await this.db.query<{ canal_id: string }>(
      `SELECT be.canal_id FROM rentas.bloqueo_exportado be
       JOIN rentas.ocupacion o ON o.id = be.ocupacion_id
       WHERE o.unidad_id = $1 AND o.rango = daterange($2, $3, '[)')`,
      [unidadId, rango.inicio, rango.fin],
    );
    return fila.rows.map((r) => r.canal_id);
  }

  async listOcupacionesActivasBloqueantes(unidadId: string): Promise<OcupacionActivaExportable[]> {
    const fila = await this.db.query<{ id: string; inicio: string; fin: string; razon: string }>(
      `SELECT id, lower(rango)::text AS inicio, upper(rango)::text AS fin, razon
       FROM rentas.ocupacion
       WHERE unidad_id = $1 AND estado <> 'cancelado' AND bloqueante`,
      [unidadId],
    );
    return fila.rows;
  }

  /** Batch de la antigua `findBloqueoExportadoPrevio` -- hallazgo de auditoría (rubro
   * 10: "3+2N queries por request", ver ./repository.ts). Una sola consulta agregada
   * (`WHERE ocupacion_id = ANY($1)`) para TODAS las ocupaciones activas de la unidad,
   * en vez de una query por ocupación dentro del bucle de ./motor.ts. */
  async findBloqueosExportadosPrevios(ocupacionIds: readonly string[], canalId: string): Promise<Map<string, BloqueoExportadoPrevio>> {
    if (ocupacionIds.length === 0) return new Map();
    const fila = await this.db.query<{ ocupacion_id: string; hash_contenido: string; sequence: number }>(
      `SELECT ocupacion_id, hash_contenido, sequence FROM rentas.bloqueo_exportado WHERE ocupacion_id = ANY($1) AND canal_id = $2`,
      [ocupacionIds, canalId],
    );
    const resultado = new Map<string, BloqueoExportadoPrevio>();
    for (const row of fila.rows) resultado.set(row.ocupacion_id, { hashContenido: row.hash_contenido, sequence: row.sequence });
    return resultado;
  }

  /** Batch de la antigua `upsertBloqueoExportado` -- mismo hallazgo que
   * `findBloqueosExportadosPrevios` de arriba. Un solo INSERT ... ON CONFLICT
   * multi-fila (vía `unnest` de los 4 arreglos paralelos) para TODOS los bloqueos
   * exportados del ciclo, en vez de un upsert por bloqueo. No-op si `entradas` viene
   * vacío -- una unidad sin ocupaciones activas bloqueantes no ejecuta esta query. */
  async upsertBloqueosExportadosBatch(organizationId: string, propertyId: string, canalId: string, entradas: readonly EntradaUpsertBloqueoExportado[]): Promise<void> {
    if (entradas.length === 0) return;
    await this.db.query(
      `INSERT INTO rentas.bloqueo_exportado (organization_id, property_id, ocupacion_id, canal_id, uid_exportado, hash_contenido, sequence, exportado_en)
       SELECT $1, $2, t.ocupacion_id, $3, t.uid_exportado, t.hash_contenido, t.sequence, now()
       FROM unnest($4::uuid[], $5::text[], $6::text[], $7::int[]) AS t(ocupacion_id, uid_exportado, hash_contenido, sequence)
       ON CONFLICT (ocupacion_id, canal_id) DO UPDATE SET
         uid_exportado = EXCLUDED.uid_exportado, hash_contenido = EXCLUDED.hash_contenido, sequence = EXCLUDED.sequence, exportado_en = now()`,
      [
        organizationId,
        propertyId,
        canalId,
        entradas.map((e) => e.ocupacionId),
        entradas.map((e) => e.uidExportado),
        entradas.map((e) => e.hashContenido),
        entradas.map((e) => e.sequence),
      ],
    );
  }
}

export { ESTADO_FEED_INICIAL };
