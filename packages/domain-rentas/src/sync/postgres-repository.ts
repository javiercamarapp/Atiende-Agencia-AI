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
import { isMigrationPendingError, isUndefinedFunctionError, runWithSavepointFallback } from "@atiende/db";
import type { RangoFechas } from "../tipos.ts";
import type { UidActivoInterno } from "./reconciliacion.ts";
import { ESTADO_FEED_INICIAL, type EstadoFeedCanal } from "./cuarentena.ts";
import type { RentasCalendarSyncRepository } from "./repository.ts";
import type { EventoBitacora, OpcionesReclamo, ResultadoReclamo, TipoEventoBitacora, SeveridadBitacora } from "./lease.ts";
import type { AccionConflicto } from "./conflictos.ts";
import type { AlertaSyncRecord, ConflictoMonitorRecord, EntradaHistorialConflicto, EstadoConflicto, FeedMonitorRecord, FiltroEstadoConflictos, HistorialConflicto, ListadoBitacora, ListadoConflictos, ResultadoDecisionConflicto, ResultadoMarcarResuelto } from "./monitor.ts";
import type {
  BloqueoExportadoPrevio,
  EntradaUpsertBloqueoExportado,
  EntradaUpsertEventoImportado,
  FeedExternoRecord,
  FeedTokenEstado,
  NewFeedExternoInput,
  OcupacionActivaExportable,
  ResultadoListarFeedTokens,
  ResultadoReclamoManual,
  ResultadoResolverFeedToken,
  ResultadoRotarFeedToken,
  RotarFeedTokenInput,
  VersionPreviaAlmacenada,
} from "./tipos.ts";

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

  // -------------------------------------------------------------------------
  // Rn-01: claim/lease por feed, backoff y bitácora (migrations/024). Cada método corre
  // protegido por SAVEPOINT (runWithSavepointFallback): contra una base sin la migración
  // el 42883/42P01/42703 NUNCA deja abortada la transacción compartida (si no, el COMMIT
  // de `withAppSession` lanzaría AbortedTransactionCommitError).
  // -------------------------------------------------------------------------
  async reclamarFeeds(opciones: OpcionesReclamo): Promise<ResultadoReclamo> {
    return runWithSavepointFallback<ResultadoReclamo>({
      session: this.db,
      savepointName: "sp_rentas_ical_claim",
      primary: async () => {
        const reclamo = await this.db.query<{ feed_id: string; lease_token: string }>(`SELECT feed_id, lease_token FROM rentas.claim_ical_feeds($1, $2, $3)`, [opciones.limite, opciones.leaseSegundos, opciones.intervaloMinimoSegundos]);
        if (reclamo.rows.length === 0) return { disponible: true, feeds: [] };
        const tokens = new Map(reclamo.rows.map((r) => [r.feed_id, r.lease_token]));
        const filas = await this.db.query<FeedRow>(`${SELECT_FEED} WHERE cfe.id = ANY($1::uuid[]) ORDER BY cfe.ultimo_intento_en NULLS FIRST, cfe.id`, [[...tokens.keys()]]);
        return { disponible: true, feeds: filas.rows.map((f) => ({ feed: filaAFeedRecord(f), leaseToken: tokens.get(f.id)! })) };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "rentas.claim_ical_feeds"),
      fallback: async () => ({ disponible: false }),
    });
  }

  async liberarFeed(feedId: string, leaseToken: string, exito: boolean): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_rentas_ical_liberar",
      primary: async () => {
        const fila = await this.db.query<{ liberado: boolean }>(`SELECT rentas.liberar_ical_feed($1, $2, $3) AS liberado`, [feedId, leaseToken, exito]);
        return fila.rows[0]?.liberado === true;
      },
      isRecoverable: (err) => isMigrationPendingError(err, "rentas.liberar_ical_feed"),
      fallback: async () => false,
    });
  }

  async registrarEventoBitacora(feedId: string, evento: EventoBitacora): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_rentas_ical_bitacora",
      primary: async () => {
        await this.db.query(`SELECT rentas.registrar_ical_sync_evento($1, $2, $3, $4, $5, $6)`, [feedId, evento.tipo, evento.severidad, evento.detalle, evento.eventosAplicados, evento.conflictos]);
        return true;
      },
      isRecoverable: (err) => isMigrationPendingError(err, "rentas.registrar_ical_sync_evento"),
      fallback: async () => false,
    });
  }

  async reiniciarBackoffFeed(feedId: string): Promise<void> {
    await runWithSavepointFallback<void>({
      session: this.db,
      savepointName: "sp_rentas_ical_reinicio_backoff",
      primary: async () => {
        await this.db.query(`UPDATE rentas.canal_feed_externo SET proximo_intento_en = NULL WHERE id = $1`, [feedId]);
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Rn-01/Rn-02: monitor (lecturas con la sesión RLS del staff por request).
  // -------------------------------------------------------------------------
  async listarFeedsMonitor(propertyId: string): Promise<FeedMonitorRecord[]> {
    interface MonitorRow {
      id: string;
      unidad_id: string;
      unidad_nombre: string | null;
      canal_codigo: string;
      activo: boolean;
      ultima_sincronizacion_exitosa_en: string | null;
      en_cuarentena_desde: string | null;
      intentos_fallidos_consecutivos: number;
      motivo_cuarentena: string | null;
      ultimo_intento_en: string | null;
      proximo_intento_en: string | null;
      lease_hasta: string | null;
    }
    const base = `SELECT cfe.id, cfe.unidad_id, u.name AS unidad_nombre, c.codigo AS canal_codigo, cfe.activo,
            cfe.ultima_sincronizacion_exitosa_en::text AS ultima_sincronizacion_exitosa_en, cfe.en_cuarentena_desde::text AS en_cuarentena_desde,
            cfe.intentos_fallidos_consecutivos, cfe.motivo_cuarentena`;
    const desde = `FROM rentas.canal_feed_externo cfe JOIN rentas.canal c ON c.id = cfe.canal_id JOIN rentas.unidad u ON u.id = cfe.unidad_id
       WHERE cfe.property_id = $1 ORDER BY u.name, c.codigo`;
    const filas = await runWithSavepointFallback<MonitorRow[]>({
      session: this.db,
      savepointName: "sp_rentas_ical_monitor_feeds",
      primary: async () =>
        (await this.db.query<MonitorRow>(`${base}, cfe.ultimo_intento_en::text AS ultimo_intento_en, cfe.proximo_intento_en::text AS proximo_intento_en, cfe.lease_hasta::text AS lease_hasta ${desde}`, [propertyId])).rows,
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () =>
        (await this.db.query<MonitorRow>(`${base}, NULL::text AS ultimo_intento_en, NULL::text AS proximo_intento_en, NULL::text AS lease_hasta ${desde}`, [propertyId])).rows,
    });
    return filas.map((f) => ({
      id: f.id,
      unidadId: f.unidad_id,
      unidadNombre: f.unidad_nombre,
      canalCodigo: f.canal_codigo,
      activo: f.activo,
      ultimaSincronizacionExitosaEn: f.ultima_sincronizacion_exitosa_en,
      enCuarentenaDesde: f.en_cuarentena_desde,
      intentosFallidosConsecutivos: f.intentos_fallidos_consecutivos,
      motivoCuarentena: f.motivo_cuarentena,
      ultimoIntentoEn: f.ultimo_intento_en,
      proximoIntentoEn: f.proximo_intento_en,
      leaseHasta: f.lease_hasta,
    }));
  }

  async listarConflictos(propertyId: string, opciones: { estado: FiltroEstadoConflictos; limite: number }): Promise<ListadoConflictos> {
    interface ConflictoRow {
      id: string;
      unidad_id: string;
      unidad_nombre: string | null;
      tipo: "capa_cruzada" | "overbooking_confirmado";
      detectado_en: string;
      resuelto_en: string | null;
      resuelto_por: string | null;
      resolucion: string | null;
      motivo_resolucion: string | null;
      a_id: string;
      a_inicio: string;
      a_fin: string;
      a_estado: string;
      a_capa: string;
      a_canal: string | null;
      b_id: string | null;
      b_inicio: string | null;
      b_fin: string | null;
      b_estado: string | null;
      b_capa: string | null;
      b_canal: string | null;
    }
    // Las columnas resolucion/motivo_resolucion existen desde la migración 026: contra una base
    // sin ella (42703) se repite la consulta con NULL::text (los cerrados salen como "resuelto").
    const consulta = (resolucion: string, motivo: string) => `SELECT k.id, k.unidad_id, u.name AS unidad_nombre, k.tipo, k.detectado_en::text AS detectado_en, k.resuelto_en::text AS resuelto_en, k.resuelto_por,
              ${resolucion} AS resolucion, ${motivo} AS motivo_resolucion,
              a.id AS a_id, lower(a.rango)::text AS a_inicio, upper(a.rango)::text AS a_fin, a.estado AS a_estado, a.capa AS a_capa, ca.codigo AS a_canal,
              b.id AS b_id, lower(b.rango)::text AS b_inicio, upper(b.rango)::text AS b_fin, b.estado AS b_estado, b.capa AS b_capa, cb.codigo AS b_canal
       FROM rentas.conflicto_calendario k
       JOIN rentas.unidad u ON u.id = k.unidad_id
       JOIN rentas.ocupacion a ON a.id = k.ocupacion_a_id
       LEFT JOIN rentas.canal ca ON ca.id = a.canal_origen_id
       LEFT JOIN rentas.ocupacion b ON b.id = k.ocupacion_b_id
       LEFT JOIN rentas.canal cb ON cb.id = b.canal_origen_id
       WHERE k.property_id = $1
         AND ($2::text = 'todos'
              OR ($2::text = 'abiertos' AND k.resuelto_en IS NULL)
              OR ($2::text = 'resueltos' AND k.resuelto_en IS NOT NULL AND ${resolucion} IS DISTINCT FROM 'ignorado')
              OR ($2::text = 'ignorados' AND ${resolucion} = 'ignorado'))
       ORDER BY (k.resuelto_en IS NOT NULL), k.detectado_en DESC, k.id
       LIMIT $3`;
    const params = [propertyId, opciones.estado, opciones.limite];
    const filas = await runWithSavepointFallback<ConflictoRow[]>({
      session: this.db,
      savepointName: "sp_rentas_conflictos_listar",
      primary: async () => (await this.db.query<ConflictoRow>(consulta("k.resolucion", "k.motivo_resolucion"), params)).rows,
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => (await this.db.query<ConflictoRow>(consulta("NULL::text", "NULL::text"), params)).rows,
    });
    const total = await this.db.query<{ total: string }>(`SELECT count(*)::text AS total FROM rentas.conflicto_calendario WHERE property_id = $1 AND resuelto_en IS NULL`, [propertyId]);
    const conflictos: ConflictoMonitorRecord[] = filas.map((f) => ({
      id: f.id,
      estado: (f.resuelto_en === null ? "abierto" : f.resolucion === "ignorado" ? "ignorado" : "resuelto") satisfies EstadoConflicto,
      motivoResolucion: f.motivo_resolucion,
      unidadId: f.unidad_id,
      unidadNombre: f.unidad_nombre,
      tipo: f.tipo,
      detectadoEn: f.detectado_en,
      resueltoEn: f.resuelto_en,
      resueltoPor: f.resuelto_por,
      ocupacionA: { id: f.a_id, inicio: f.a_inicio, fin: f.a_fin, estado: f.a_estado, capa: f.a_capa, canalCodigo: f.a_canal },
      ocupacionB: f.b_id && f.b_inicio && f.b_fin && f.b_estado && f.b_capa ? { id: f.b_id, inicio: f.b_inicio, fin: f.b_fin, estado: f.b_estado, capa: f.b_capa, canalCodigo: f.b_canal } : null,
    }));
    return { conflictos, totalAbiertos: Number(total.rows[0]?.total ?? 0) };
  }

  async decidirConflicto(propertyId: string, conflictoId: string, actorUserId: string, decision: { accion: AccionConflicto; motivo: string | null }): Promise<ResultadoDecisionConflicto> {
    // Las decisiones de negocio de la función (P0002 / 55000 / 42501) y la migración pendiente
    // (42883) son ambas "recuperables": se revierte al SAVEPOINT (la transacción compartida del
    // request sigue utilizable, sin 25P02) y el fallback las traduce. El actor sale de auth.uid()
    // dentro de la función; `actorUserId` solo se usa en el camino anterior a 026.
    return runWithSavepointFallback<ResultadoDecisionConflicto>({
      session: this.db,
      savepointName: "sp_rentas_conflicto_decidir",
      primary: async () => {
        const fila = await this.db.query<{ accion: AccionConflicto }>(`SELECT rentas.resolver_conflicto_calendario($1, $2, $3, $4) AS accion`, [propertyId, conflictoId, decision.accion, decision.motivo]);
        return fila.rows[0]?.accion ?? "no_encontrado";
      },
      isRecoverable: (err) => {
        const code = (err as { code?: string } | null)?.code;
        return code === "P0002" || code === "55000" || code === "42501" || isUndefinedFunctionError(err, "rentas.resolver_conflicto_calendario");
      },
      fallback: async (err) => {
        const code = (err as { code?: string } | null)?.code;
        if (code === "P0002") return "no_encontrado";
        if (code === "55000") return "solape_vigente";
        if (code === "42501") return "sin_permiso";
        // Base sin la migración 026: solo "resuelto" existe (sin motivo ni bitácora ni verificación de solape).
        if (decision.accion === "ignorado") return "no_disponible";
        return this.resolverConflictoAnterior026(propertyId, conflictoId, actorUserId);
      },
    });
  }

  /** Camino anterior a 026 (migración 024): UPDATE directo de (resuelto_en, resuelto_por). */
  private async resolverConflictoAnterior026(propertyId: string, conflictoId: string, actorUserId: string): Promise<ResultadoDecisionConflicto> {
    return runWithSavepointFallback<ResultadoDecisionConflicto>({
      session: this.db,
      savepointName: "sp_rentas_conflicto_resolver_024",
      primary: async () => {
        const fila = await this.db.query<{ id: string }>(
          `UPDATE rentas.conflicto_calendario SET resuelto_en = now(), resuelto_por = $3
           WHERE id = $2 AND property_id = $1 AND resuelto_en IS NULL RETURNING id`,
          [propertyId, conflictoId, actorUserId],
        );
        return fila.rows.length > 0 ? "resuelto" : "no_encontrado";
      },
      // Antes de la 024, `authenticated` no tiene UPDATE sobre conflicto_calendario
      // (SQLSTATE 42501 "permission denied"): una denegación de RLS NUNCA lanza (da 0
      // filas), así que 42501 aquí solo significa "migración pendiente".
      isRecoverable: (err) => (err as { code?: string } | null)?.code === "42501",
      fallback: async () => "no_disponible",
    });
  }

  async listarHistorialConflicto(propertyId: string, conflictoId: string): Promise<HistorialConflicto> {
    return runWithSavepointFallback<HistorialConflicto>({
      session: this.db,
      savepointName: "sp_rentas_conflicto_historial",
      primary: async () => {
        const filas = await this.db.query<{ id: string; accion: "resuelto" | "ignorado"; motivo: string | null; actor_user_id: string; creado_en: string }>(
          `SELECT id, accion, motivo, actor_user_id, creado_en::text AS creado_en
           FROM rentas.conflicto_calendario_bitacora
           WHERE property_id = $1 AND conflicto_id = $2
           ORDER BY creado_en, id`,
          [propertyId, conflictoId],
        );
        const entradas: EntradaHistorialConflicto[] = filas.rows.map((f) => ({ id: f.id, accion: f.accion, motivo: f.motivo, actorUserId: f.actor_user_id, creadoEn: f.creado_en }));
        return { disponible: true, entradas };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false, entradas: [] }),
    });
  }

  async listarBitacora(propertyId: string, opciones: { soloAlertasAbiertas: boolean; limite: number }): Promise<ListadoBitacora> {
    interface BitacoraRow {
      id: string;
      unidad_id: string;
      unidad_nombre: string | null;
      canal_codigo: string;
      tipo: TipoEventoBitacora;
      severidad: SeveridadBitacora;
      detalle: string;
      eventos_aplicados: number;
      conflictos: number;
      creado_en: string;
      atendida_en: string | null;
    }
    return runWithSavepointFallback<ListadoBitacora>({
      session: this.db,
      savepointName: "sp_rentas_ical_bitacora_leer",
      primary: async () => {
        const filas = await this.db.query<BitacoraRow>(
          `SELECT b.id, b.unidad_id, u.name AS unidad_nombre, c.codigo AS canal_codigo, b.tipo, b.severidad, b.detalle, b.eventos_aplicados, b.conflictos,
                  b.creado_en::text AS creado_en, b.atendida_en::text AS atendida_en
           FROM rentas.ical_sync_bitacora b
           JOIN rentas.unidad u ON u.id = b.unidad_id
           JOIN rentas.canal c ON c.id = b.canal_id
           WHERE b.property_id = $1 AND ($2::boolean = false OR (b.atendida_en IS NULL AND b.severidad IN ('aviso', 'critica')))
           ORDER BY b.creado_en DESC, b.id
           LIMIT $3`,
          [propertyId, opciones.soloAlertasAbiertas, opciones.limite],
        );
        const alertas: AlertaSyncRecord[] = filas.rows.map((f) => ({
          id: f.id,
          unidadId: f.unidad_id,
          unidadNombre: f.unidad_nombre,
          canalCodigo: f.canal_codigo,
          tipo: f.tipo,
          severidad: f.severidad,
          detalle: f.detalle,
          eventosAplicados: f.eventos_aplicados,
          conflictos: f.conflictos,
          creadoEn: f.creado_en,
          atendidaEn: f.atendida_en,
        }));
        return { disponible: true, alertas };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false, alertas: [] }),
    });
  }

  async atenderAlerta(propertyId: string, alertaId: string, actorUserId: string): Promise<ResultadoMarcarResuelto> {
    return runWithSavepointFallback<ResultadoMarcarResuelto>({
      session: this.db,
      savepointName: "sp_rentas_ical_alerta_atender",
      primary: async () => {
        const fila = await this.db.query<{ id: string }>(
          `UPDATE rentas.ical_sync_bitacora SET atendida_en = now(), atendida_por = $3
           WHERE id = $2 AND property_id = $1 AND atendida_en IS NULL RETURNING id`,
          [propertyId, alertaId, actorUserId],
        );
        return fila.rows.length > 0 ? "resuelto" : "no_encontrado";
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => "no_disponible",
    });
  }

  // ---- Rn-13: token rotable de la URL de exportación (migración 037) ----
  // Cada método corre protegido por SAVEPOINT: contra una base sin la migración devuelve `disponible: false`.
  // `rotarFeedToken` deriva organization/property de la unidad EN LA BASE (los del input no se envían).
  async rotarFeedToken(input: RotarFeedTokenInput): Promise<ResultadoRotarFeedToken> {
    return runWithSavepointFallback<ResultadoRotarFeedToken>({
      session: this.db,
      savepointName: "sp_rentas_feed_token_rotar",
      primary: async () => {
        const fila = await this.db.query<{ token_id: string; creado_en: string }>(
          `SELECT token_id, to_char(creado_en AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS creado_en
           FROM rentas.rotar_feed_export_token($1, $2, $3)`,
          [input.unidadId, input.canalId, input.tokenHash],
        );
        const r = fila.rows[0];
        if (!r) throw new Error("rotar_feed_export_token no devolvió el token creado.");
        return { disponible: true, tokenId: r.token_id, creadoEn: r.creado_en };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "rentas.rotar_feed_export_token"),
      fallback: async () => ({ disponible: false }),
    });
  }

  async listarFeedTokens(propertyId: string, unidadId?: string): Promise<ResultadoListarFeedTokens> {
    interface TokenRow {
      id: string;
      unidad_id: string;
      canal_id: string;
      canal_codigo: string;
      creado_en: string;
      ultimo_acceso_en: string | null;
    }
    return runWithSavepointFallback<ResultadoListarFeedTokens>({
      session: this.db,
      savepointName: "sp_rentas_feed_token_listar",
      primary: async () => {
        const filas = await this.db.query<TokenRow>(
          `SELECT t.id, t.unidad_id, t.canal_id, c.codigo AS canal_codigo,
                  to_char(t.creado_en AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS creado_en,
                  to_char(t.ultimo_acceso_en AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ultimo_acceso_en
           FROM rentas.feed_export_token t
           JOIN rentas.canal c ON c.id = t.canal_id
           WHERE t.property_id = $1 AND ($2::uuid IS NULL OR t.unidad_id = $2::uuid) AND t.revocado_en IS NULL
           ORDER BY t.unidad_id, c.codigo`,
          [propertyId, unidadId ?? null],
        );
        const tokens: FeedTokenEstado[] = filas.rows.map((f) => ({ tokenId: f.id, unidadId: f.unidad_id, canalId: f.canal_id, canalCodigo: f.canal_codigo, creadoEn: f.creado_en, ultimoAccesoEn: f.ultimo_acceso_en }));
        return { disponible: true, tokens };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false }),
    });
  }

  async resolverFeedToken(tokenHash: string): Promise<ResultadoResolverFeedToken> {
    interface ResueltoRow {
      token_id: string;
      token_hash: string;
      organization_id: string;
      property_id: string;
      unidad_id: string;
      canal_id: string;
      canal_codigo: string;
    }
    return runWithSavepointFallback<ResultadoResolverFeedToken>({
      session: this.db,
      savepointName: "sp_rentas_feed_token_resolver",
      primary: async () => {
        const filas = await this.db.query<ResueltoRow>(`SELECT token_id, token_hash, organization_id, property_id, unidad_id, canal_id, canal_codigo FROM rentas.resolver_feed_export_token($1)`, [tokenHash]);
        const r = filas.rows[0];
        if (!r) return { disponible: true, token: null };
        return {
          disponible: true,
          token: { tokenId: r.token_id, tokenHash: r.token_hash, organizationId: r.organization_id, propertyId: r.property_id, unidadId: r.unidad_id, canalId: r.canal_id, canalCodigo: r.canal_codigo },
        };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "rentas.resolver_feed_export_token"),
      fallback: async () => ({ disponible: false }),
    });
  }

  // ---- Rn-P3-23: "Sincronizar ahora" (migración 037) ----
  async reclamarFeedManual(feedId: string, leaseSegundos: number): Promise<ResultadoReclamoManual> {
    return runWithSavepointFallback<ResultadoReclamoManual>({
      session: this.db,
      savepointName: "sp_rentas_ical_claim_manual",
      primary: async () => {
        const filas = await this.db.query<{ feed_id: string; lease_token: string }>(`SELECT feed_id, lease_token FROM rentas.claim_ical_feed_manual($1, $2)`, [feedId, leaseSegundos]);
        return { disponible: true, leaseToken: filas.rows[0]?.lease_token ?? null };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "rentas.claim_ical_feed_manual"),
      fallback: async () => ({ disponible: false }),
    });
  }
}

export { ESTADO_FEED_INICIAL };
