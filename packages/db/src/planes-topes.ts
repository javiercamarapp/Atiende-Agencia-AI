// Medidor mensual de mensajes, tope por plan y avisos de fin de prueba (PL-16) -- puerto TypeScript contra las funciones
// `security definer` de packages/db/migrations/0045_planes_topes_prueba_portal.sql.
//
// SESIONES: decidirEnvio / registrarMensaje / reclamarAvisosPrueba / destinatariosAvisoPrueba / marcarAvisoPrueba son SOLO-SISTEMA
// (el llamador las invoca en `withAppSession({ userId: null })`: dispatcher y cron). leerUsoOrganizacion y
// listarUsoSuperadmin son caller-bound (`withAppSession({ userId: callerId })`).
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (regla dura del repo): cada operacion corre bajo `runWithSavepointFallback`. Un SQLSTATE
// 42883/42P01/42703 revierte SOLO el savepoint (la transaccion de la sesion sigue viva) y devuelve `{ disponible: false }`:
//   - decidirEnvio => permitir (sin medidor NO se bloquea ningun envio: la facturacion nunca deja a un cliente sin respuesta);
//   - registrarMensaje => no se cuenta nada;
//   - lecturas => "no disponible aun".
// Nunca 500 ni exito simulado. Cualquier otro error de Postgres se repropaga (sesion ya recuperada).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import { isMigrationPendingError } from "./sql-errors.ts";

export type AccionTopeMensajes = "avisar" | "cobrar" | "pausar";
export type CruceUmbral = "ninguno" | "aviso80" | "excedido";

export interface DecisionEnvio {
  /** false = la base no tiene la migracion 0045: se permite el envio y no se mide nada. */
  readonly disponible: boolean;
  readonly permitir: boolean;
  readonly motivo: string | null;
  readonly usado: number | null;
  readonly limite: number | null;
}

export interface RegistroMensaje {
  readonly disponible: boolean;
  /** false = esa referencia ya estaba registrada (idempotencia). */
  readonly registrado: boolean;
  readonly periodo: string | null;
  readonly cruce: CruceUmbral;
  readonly usado: number | null;
  readonly limite: number | null;
  readonly accion: AccionTopeMensajes | null;
  readonly excedente: number | null;
  /** Slug de la organizacion (codigo, no PII): lo usan los avisos de plataforma para identificarla. */
  readonly slug: string | null;
}

export interface UsoMensajes {
  readonly usado: number;
  readonly limite: number | null;
  readonly accion: AccionTopeMensajes | null;
  readonly excedente: number;
  readonly proactivosOmitidos: number;
}

export interface UsoOrganizacion {
  readonly organizationId: string;
  readonly slug: string;
  readonly vertical: string;
  readonly periodo: string;
  readonly zonaHoraria: string;
  readonly mensajes: UsoMensajes;
  readonly plan: { readonly id: string; readonly nombre: string } | null;
  readonly prueba: { readonly activa: boolean; readonly terminaEn: string | null; readonly diasRestantes: number | null };
}

export type LecturaUso =
  | { readonly disponible: true; readonly uso: UsoOrganizacion | null }
  | { readonly disponible: false };

export interface UsoSuperadminRow {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly slug: string;
  readonly vertical: string;
  readonly periodo: string;
  readonly planId: string | null;
  readonly limite: number | null;
  readonly accion: AccionTopeMensajes | null;
  readonly usado: number;
  readonly excedente: number;
  readonly proactivosOmitidos: number;
}

export type ListadoUsoSuperadmin = { readonly disponible: true; readonly filas: readonly UsoSuperadminRow[] } | { readonly disponible: false };

export interface AvisoPrueba {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly vertical: string;
  readonly slug: string;
  readonly diasAntes: 7 | 3 | 1;
  readonly trialEndsAt: string;
  readonly esReintento: boolean;
}

export type EstadoCorreoAviso = "enviado" | "sin_destinatarios" | "no_configurado" | "error";

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateText(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

const DECISION_NO_DISPONIBLE: DecisionEnvio = { disponible: false, permitir: true, motivo: null, usado: null, limite: null };
const REGISTRO_NO_DISPONIBLE: RegistroMensaje = { disponible: false, registrado: false, periodo: null, cruce: "ninguno", usado: null, limite: null, accion: null, excedente: null, slug: null };

/** Decide si un envio puede salir. Solo bloquea un proactivo NO critico en un plan con accion `pausar` y tope consumido. */
export async function decidirEnvio(
  session: TenantDbSession,
  input: { readonly organizationId: string; readonly proactivo: boolean; readonly critico?: boolean; readonly at?: Date },
): Promise<DecisionEnvio> {
  return runWithSavepointFallback<DecisionEnvio>({
    session,
    primary: async () => {
      const { rows } = await session.query<{ r: Record<string, unknown> }>(
        "select core.message_quota_check($1::uuid, $2::boolean, $3::boolean, $4::timestamptz) as r;",
        [input.organizationId, input.proactivo, input.critico ?? false, (input.at ?? new Date()).toISOString()],
      );
      const r = rows[0]?.r ?? {};
      return { disponible: true, permitir: r.permitir !== false, motivo: typeof r.motivo === "string" ? r.motivo : null, usado: num(r.usado), limite: num(r.limite) };
    },
    isRecoverable: isMigrationPendingError,
    fallback: async () => DECISION_NO_DISPONIBLE,
  });
}

/** Registra un mensaje atendido (o un proactivo omitido) de forma idempotente por (refTipo, refId). */
export async function registrarMensaje(
  session: TenantDbSession,
  input: {
    readonly organizationId: string;
    readonly refTipo: string;
    readonly refId: string;
    readonly occurredAt?: Date;
    readonly proactivo?: boolean;
    readonly omitido?: boolean;
    readonly motivo?: string | null;
  },
): Promise<RegistroMensaje> {
  return runWithSavepointFallback<RegistroMensaje>({
    session,
    primary: async () => {
      const { rows } = await session.query<{ r: Record<string, unknown> }>(
        "select core.message_usage_record($1::uuid, $2, $3, $4::timestamptz, $5::boolean, $6::boolean, $7) as r;",
        [input.organizationId, input.refTipo, input.refId, (input.occurredAt ?? new Date()).toISOString(), input.proactivo ?? false, input.omitido ?? false, input.motivo ?? null],
      );
      const r = rows[0]?.r ?? {};
      const cruce = r.cruce === "aviso80" || r.cruce === "excedido" ? r.cruce : "ninguno";
      const accion = r.accion === "avisar" || r.accion === "cobrar" || r.accion === "pausar" ? r.accion : null;
      return { disponible: true, registrado: r.registrado === true, periodo: typeof r.periodo === "string" ? r.periodo : null, cruce, usado: num(r.usado), limite: num(r.limite), accion, excedente: num(r.excedente), slug: typeof r.slug === "string" ? r.slug : null };
    },
    isRecoverable: isMigrationPendingError,
    fallback: async () => REGISTRO_NO_DISPONIBLE,
  });
}

function mapUso(r: Record<string, unknown>): UsoOrganizacion {
  const m = (r.mensajes ?? {}) as Record<string, unknown>;
  const p = r.plan as Record<string, unknown> | null | undefined;
  const t = (r.prueba ?? {}) as Record<string, unknown>;
  const accion = m.accion === "avisar" || m.accion === "cobrar" || m.accion === "pausar" ? m.accion : null;
  return {
    organizationId: String(r.organizationId),
    slug: String(r.slug),
    vertical: String(r.vertical),
    periodo: dateText(r.periodo),
    zonaHoraria: String(r.zonaHoraria),
    mensajes: { usado: num(m.usado) ?? 0, limite: num(m.limite), accion, excedente: num(m.excedente) ?? 0, proactivosOmitidos: num(m.proactivosOmitidos) ?? 0 },
    plan: p ? { id: String(p.id), nombre: String(p.nombre) } : null,
    prueba: { activa: t.activa === true, terminaEn: typeof t.terminaEn === "string" ? iso(t.terminaEn) : null, diasRestantes: num(t.diasRestantes) },
  };
}

/** Consumo del mes de UNA organizacion. `uso: null` = el llamador no es miembro ni superadmin (el API responde 403/404). */
export async function leerUsoOrganizacion(session: TenantDbSession, callerId: string, organizationId: string): Promise<LecturaUso> {
  return runWithSavepointFallback<LecturaUso>({
    session,
    primary: async () => {
      const { rows } = await session.query<{ r: Record<string, unknown> | null }>("select core.message_usage_for_org($1::uuid, $2::uuid) as r;", [callerId, organizationId]);
      const r = rows[0]?.r ?? null;
      return { disponible: true, uso: r ? mapUso(r) : null };
    },
    isRecoverable: isMigrationPendingError,
    fallback: async () => ({ disponible: false }),
  });
}

/** Consumo del mes de todas las organizaciones (SA-10 lo pinta; esta tarea solo expone el dato). */
export async function listarUsoSuperadmin(session: TenantDbSession, callerId: string, limit = 200): Promise<ListadoUsoSuperadmin> {
  return runWithSavepointFallback<ListadoUsoSuperadmin>({
    session,
    primary: async () => {
      const { rows } = await session.query<Record<string, unknown>>("select * from core.superadmin_list_message_usage($1::uuid, $2::int);", [callerId, limit]);
      return {
        disponible: true,
        filas: rows.map((r) => ({
          organizationId: String(r.organization_id),
          organizationName: String(r.organization_name),
          slug: String(r.slug),
          vertical: String(r.vertical),
          periodo: dateText(r.periodo),
          planId: typeof r.plan_id === "string" ? r.plan_id : null,
          limite: num(r.limite),
          accion: r.accion === "avisar" || r.accion === "cobrar" || r.accion === "pausar" ? r.accion : null,
          usado: num(r.usado) ?? 0,
          excedente: num(r.excedente) ?? 0,
          proactivosOmitidos: num(r.proactivos_omitidos) ?? 0,
        })),
      };
    },
    isRecoverable: isMigrationPendingError,
    fallback: async () => ({ disponible: false }),
  });
}

/** Reclama los avisos de fin de prueba de HOY (7/3/1 dias) y los reintentos de correo pendientes. Cada aviso exitoso sale una vez. */
export type ReclamoAvisosPrueba = { readonly disponible: boolean; readonly avisos: readonly AvisoPrueba[] };

export async function reclamarAvisosPrueba(session: TenantDbSession, now: Date = new Date()): Promise<ReclamoAvisosPrueba> {
  return runWithSavepointFallback<ReclamoAvisosPrueba>({
    session,
    primary: async () => {
      const { rows } = await session.query<Record<string, unknown>>("select * from core.trial_notice_claim($1::timestamptz);", [now.toISOString()]);
      const avisos = rows.map((r): AvisoPrueba => ({
        organizationId: String(r.organization_id),
        organizationName: String(r.organization_name),
        vertical: String(r.vertical),
        slug: String(r.slug),
        diasAntes: Number(r.dias_antes) as 7 | 3 | 1,
        trialEndsAt: iso(r.trial_ends_at),
        esReintento: r.es_reintento === true,
      }));
      return { disponible: true, avisos };
    },
    isRecoverable: isMigrationPendingError,
    fallback: async () => ({ disponible: false, avisos: [] }),
  });
}

/** Correos de owner/admin de la organizacion (solo para enviar el aviso; nunca se guardan ni se registran). */
export async function destinatariosAvisoPrueba(session: TenantDbSession, organizationId: string): Promise<readonly string[]> {
  const { rows } = await session.query<{ email: string }>("select email from core.trial_notice_recipients($1::uuid);", [organizationId]);
  return rows.map((r) => r.email);
}

export async function marcarAvisoPrueba(session: TenantDbSession, aviso: Pick<AvisoPrueba, "organizationId" | "diasAntes" | "trialEndsAt">, estado: EstadoCorreoAviso): Promise<void> {
  await session.query("select core.trial_notice_mark($1::uuid, $2::int, $3::timestamptz, $4);", [aviso.organizationId, aviso.diasAntes, aviso.trialEndsAt, estado]);
}
