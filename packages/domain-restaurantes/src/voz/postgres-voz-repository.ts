// Adaptador Postgres de `VozRepository`. REGLA DURA de compatibilidad con la base SIN migrar:
// mergear despliega el codigo al instante y la migracion 025 no se aplica sola. Toda consulta
// corre dentro de la transaccion UNICA de un request (`withAppSession`), donde un error de
// Postgres deja la transaccion abortada (25P02) y el COMMIT seria un ROLLBACK silencioso; por eso
// TODA operacion usa `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT) antes de
// degradar: lecturas -> `disponible: false`, escrituras -> `VozNoDisponibleError` (503).
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { VozRepository } from "./repository.ts";
import {
  VOZ_PROVEEDOR_PRINCIPAL,
  proveedorDeFila,
  VOZ_RESULTADOS,
  VozNoDisponibleError,
  VozRechazadaError,
} from "./types.ts";
import type {
  VozCanal,
  VozCerrarConversacionInput,
  VozConfig,
  VozConfigEntrada,
  VozConversacionesFiltro,
  VozConversacionesPagina,
  VozConversacionResumen,
  VozIniciarConversacionInput,
  VozLectura,
  VozPreviewSesion,
  VozProveedorId,
  VozRegistrarTurnoInput,
  VozResultado,
  VozRolTurno,
  VozTurno,
} from "./types.ts";
import { VOZ_POR_DEFECTO } from "./catalogo-voces.ts";

export const VOZ_CONFIG_POR_DEFECTO: VozConfig = {
  habilitado: false,
  proveedor: VOZ_PROVEEDOR_PRINCIPAL,
  voiceId: VOZ_POR_DEFECTO,
  comportamiento: "",
  mensajeInicial: "",
  configurada: false,
};

function code(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Objeto de la migracion 025 inexistente: tabla, columna o funcion. */
function esBaseSinMigrar(err: unknown): boolean {
  const c = code(err);
  return c === "42P01" || c === "42703" || c === "42883";
}

/** Para escrituras: ademas de "sin migrar", 42501 (pertenencia / no-sistema) y 23505
 * (external_id de otra sucursal) son rechazos de negocio conocidos. */
function esErrorEscrituraConocido(err: unknown): boolean {
  const c = code(err);
  return esBaseSinMigrar(err) || c === "42501" || c === "23505";
}

function aErrorDeEscritura(err: unknown): never {
  if (esBaseSinMigrar(err)) {
    advertirNoDisponible(err);
    throw new VozNoDisponibleError();
  }
  throw new VozRechazadaError();
}

let advertido = false;
function advertirNoDisponible(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresVozRepository: las tablas/funciones de voz todavía no existen en esta base (SQLSTATE 42P01/42703/42883) -- " +
      "aplica packages/domain-restaurantes/migrations/025_voz_config_conversaciones.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

interface ConfigRow {
  habilitado: boolean;
  proveedor: string;
  voice_id: string;
  comportamiento: string;
  mensaje_inicial: string;
}

function mapConfig(row: ConfigRow): VozConfig {
  return {
    habilitado: row.habilitado === true,
    proveedor: proveedorDeFila(row.proveedor),
    voiceId: row.voice_id,
    comportamiento: row.comportamiento ?? "",
    mensajeInicial: row.mensaje_inicial ?? "",
    configurada: true,
  };
}

interface ConversacionRow {
  id: string;
  property_id: string;
  external_id: string;
  canal: string;
  proveedor: string;
  voice_id: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  duration_s: number | null;
  costo_estimado_micro_usd: string | number;
  latencia_p95_ms: number | null;
  resultado: string | null;
  order_id: string | null;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function mapConversacion(row: ConversacionRow): VozConversacionResumen {
  return {
    id: row.id,
    propertyId: row.property_id,
    externalId: row.external_id,
    canal: row.canal as VozCanal,
    proveedor: proveedorDeFila(row.proveedor),
    voiceId: row.voice_id,
    startedAt: iso(row.started_at),
    endedAt: row.ended_at === null ? null : iso(row.ended_at),
    durationS: row.duration_s,
    costoEstimadoMicroUsd: Number(row.costo_estimado_micro_usd),
    latenciaP95Ms: row.latencia_p95_ms,
    resultado: (VOZ_RESULTADOS as readonly string[]).includes(row.resultado ?? "") ? (row.resultado as VozResultado) : null,
    orderId: row.order_id,
  };
}

const CONVERSACION_COLS =
  "id, property_id, external_id, canal, proveedor, voice_id, started_at, ended_at, duration_s, costo_estimado_micro_usd, latencia_p95_ms, resultado, order_id";

export class PostgresVozRepository implements VozRepository {
  constructor(private readonly db: TenantDbSession) {}

  async getConfig(propertyId: string): Promise<VozLectura<VozConfig>> {
    return runWithSavepointFallback<VozLectura<VozConfig>>({
      session: this.db,
      savepointName: "sp_voz_config_read",
      primary: async () => {
        const { rows } = await this.db.query<ConfigRow>(
          `select habilitado, proveedor, voice_id, comportamiento, mensaje_inicial from restaurantes.branch_voice_config where property_id = $1;`,
          [propertyId],
        );
        return { disponible: true, valor: rows[0] ? mapConfig(rows[0]) : VOZ_CONFIG_POR_DEFECTO };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: VOZ_CONFIG_POR_DEFECTO };
      },
    });
  }

  async upsertConfig(organizationId: string, propertyId: string, config: VozConfigEntrada): Promise<VozConfig> {
    return runWithSavepointFallback<VozConfig>({
      session: this.db,
      savepointName: "sp_voz_config_write",
      primary: async () => {
        const { rows } = await this.db.query<ConfigRow>(
          `insert into restaurantes.branch_voice_config (property_id, organization_id, habilitado, proveedor, voice_id, comportamiento, mensaje_inicial, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, now())
           on conflict (property_id) do update set
             habilitado = excluded.habilitado,
             proveedor = excluded.proveedor,
             voice_id = excluded.voice_id,
             comportamiento = excluded.comportamiento,
             mensaje_inicial = excluded.mensaje_inicial,
             updated_at = excluded.updated_at
           returning habilitado, proveedor, voice_id, comportamiento, mensaje_inicial;`,
          [propertyId, organizationId, config.habilitado, config.proveedor, config.voiceId, config.comportamiento, config.mensajeInicial],
        );
        return mapConfig(rows[0]!);
      },
      isRecoverable: esErrorEscrituraConocido,
      fallback: aErrorDeEscritura,
    });
  }

  async crearPreviewSession(input: { organizationId: string; propertyId: string; createdBy: string; proveedor: VozProveedorId; voiceId: string; ttlSegundos: number }): Promise<VozPreviewSesion> {
    return runWithSavepointFallback<VozPreviewSesion>({
      session: this.db,
      savepointName: "sp_voz_preview_write",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string; expires_at: Date | string }>(
          `insert into restaurantes.voice_preview_sessions (organization_id, property_id, created_by, proveedor, voice_id, created_at, expires_at)
           values ($1, $2, $3, $4, $5, now(), now() + make_interval(secs => $6::int))
           returning id, expires_at;`,
          [input.organizationId, input.propertyId, input.createdBy, input.proveedor, input.voiceId, input.ttlSegundos],
        );
        return { id: rows[0]!.id, expiresAt: iso(rows[0]!.expires_at) };
      },
      isRecoverable: esErrorEscrituraConocido,
      fallback: aErrorDeEscritura,
    });
  }

  async listConversaciones(organizationId: string, propertyId: string, filtro: VozConversacionesFiltro): Promise<VozLectura<VozConversacionesPagina>> {
    const limit = Math.min(100, Math.max(1, filtro.limit ?? 25));
    const offset = Math.max(0, filtro.offset ?? 0);
    return runWithSavepointFallback<VozLectura<VozConversacionesPagina>>({
      session: this.db,
      savepointName: "sp_voz_conversaciones_read",
      primary: async () => {
        const params: unknown[] = [organizationId, propertyId];
        let cond = "organization_id = $1 and property_id = $2";
        if (filtro.resultado) {
          params.push(filtro.resultado);
          cond += ` and resultado = $${params.length}`;
        }
        const total = await this.db.query<{ total: number }>(`select count(*)::int as total from restaurantes.voice_conversation where ${cond};`, params);
        const { rows } = await this.db.query<ConversacionRow>(
          `select ${CONVERSACION_COLS} from restaurantes.voice_conversation where ${cond} order by started_at desc, id desc limit $${params.length + 1} offset $${params.length + 2};`,
          [...params, limit, offset],
        );
        return { disponible: true, valor: { items: rows.map(mapConversacion), total: total.rows[0]?.total ?? 0 } };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: { items: [], total: 0 } };
      },
    });
  }

  async getConversacion(organizationId: string, propertyId: string, conversationId: string): Promise<VozLectura<{ conversacion: VozConversacionResumen; turnos: readonly VozTurno[] } | null>> {
    return runWithSavepointFallback<VozLectura<{ conversacion: VozConversacionResumen; turnos: readonly VozTurno[] } | null>>({
      session: this.db,
      savepointName: "sp_voz_conversacion_read",
      primary: async () => {
        const conv = await this.db.query<ConversacionRow>(
          `select ${CONVERSACION_COLS} from restaurantes.voice_conversation where id = $1 and organization_id = $2 and property_id = $3;`,
          [conversationId, organizationId, propertyId],
        );
        if (!conv.rows[0]) return { disponible: true, valor: null };
        const turnos = await this.db.query<{ seq: number; rol: string; texto: string; duracion_ms: number | null; latencia_ms: number | null; costo_estimado_micro_usd: string | number; created_at: Date | string }>(
          `select seq, rol, texto, duracion_ms, latencia_ms, costo_estimado_micro_usd, created_at from restaurantes.voice_turn where conversation_id = $1 and organization_id = $2 order by seq;`,
          [conversationId, organizationId],
        );
        return {
          disponible: true,
          valor: {
            conversacion: mapConversacion(conv.rows[0]),
            turnos: turnos.rows.map((t) => ({
              seq: t.seq,
              rol: t.rol as VozRolTurno,
              texto: t.texto,
              duracionMs: t.duracion_ms,
              latenciaMs: t.latencia_ms,
              costoEstimadoMicroUsd: Number(t.costo_estimado_micro_usd),
              createdAt: iso(t.created_at),
            })),
          },
        };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: null };
      },
    });
  }

  async iniciarConversacion(input: VozIniciarConversacionInput): Promise<string> {
    return runWithSavepointFallback<string>({
      session: this.db,
      savepointName: "sp_voz_iniciar_conversacion",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(
          `select restaurantes.voz_iniciar_conversacion($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::timestamptz) as id;`,
          [input.organizationId, input.propertyId, input.externalId, input.canal, input.proveedor, input.voiceId, input.callerHash, input.startedAt],
        );
        return rows[0]!.id;
      },
      isRecoverable: esErrorEscrituraConocido,
      fallback: aErrorDeEscritura,
    });
  }

  async registrarTurno(input: VozRegistrarTurnoInput): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_voz_registrar_turno",
      primary: async () => {
        const { rows } = await this.db.query<{ insertado: boolean }>(
          `select restaurantes.voz_registrar_turno($1::uuid, $2::uuid, $3::int, $4, $5, $6::int, $7::int, $8::bigint) as insertado;`,
          [input.organizationId, input.conversationId, input.seq, input.rol, input.texto, input.duracionMs, input.latenciaMs, input.costoMicroUsd],
        );
        return rows[0]!.insertado === true;
      },
      isRecoverable: esErrorEscrituraConocido,
      fallback: aErrorDeEscritura,
    });
  }

  async cerrarConversacion(input: VozCerrarConversacionInput): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_voz_cerrar_conversacion",
      primary: async () => {
        const { rows } = await this.db.query<{ cerrada: boolean }>(
          `select restaurantes.voz_cerrar_conversacion($1::uuid, $2::uuid, $3, $4::timestamptz, $5::uuid) as cerrada;`,
          [input.organizationId, input.conversationId, input.resultado, input.endedAt, input.orderId],
        );
        return rows[0]!.cerrada === true;
      },
      isRecoverable: esErrorEscrituraConocido,
      fallback: aErrorDeEscritura,
    });
  }

  async cerrarHuerfanas(opciones: { inactivasMinutos: number; limite: number }): Promise<number> {
    return runWithSavepointFallback<number>({
      session: this.db,
      savepointName: "sp_voz_cerrar_huerfanas",
      primary: async () => {
        const { rows } = await this.db.query<{ cerradas: number | string }>(`select restaurantes.voz_cerrar_huerfanas($1::integer, $2::integer) as cerradas;`, [opciones.inactivasMinutos, opciones.limite]);
        return Number(rows[0]!.cerradas);
      },
      isRecoverable: esBaseSinMigrar,
      fallback: aErrorDeEscritura,
    });
  }

  async consumirPreview(input: { sessionId: string; organizationId: string; propertyId: string }): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_voz_consumir_preview",
      primary: async () => {
        const { rows } = await this.db.query<{ consumida: boolean }>(`select restaurantes.voz_consumir_preview($1::uuid, $2::uuid, $3::uuid) as consumida;`, [input.sessionId, input.organizationId, input.propertyId]);
        return rows[0]!.consumida === true;
      },
      isRecoverable: esErrorEscrituraConocido,
      fallback: aErrorDeEscritura,
    });
  }
}
