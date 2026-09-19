// SuperadminAccionesRepository — puerto de la TERCERA pieza del "cerebro" de
// backoffice del superadmin: acciones sugeridas con confirmación (máquina de
// estados de `core.superadmin_action_intent`) + las dos automatizaciones
// seguras (`core.desatascar_outbox_colgados_for_system`/`core.marcar_
// prospectos_sin_movimiento_for_system`) + las bitácoras que las respaldan.
// Ver `packages/db/migrations/0016_superadmin_acciones.sql` para el diseño
// completo.
//
// MISMO patrón que `SaludRepository`/`ResumenDiarioRepository`: objeto FIJO
// (no una fábrica por-request), consumido por `apps/api/src/production/
// superadmin-acciones-repository.ts` -- las automatizaciones abren sesión de
// SISTEMA (`userId: null`), TODO lo demás (crear/confirmar/cancelar intent,
// las 4 lecturas `*ForSuperadmin`) abre sesión COMO el caller autenticado.
import { randomUUID } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";

export type IntentTipo = "reencolar_mensaje_muerto" | "cerrar_prospecto" | "ejecutar_mantenimiento_ahora";
export type IntentEstado = "pending" | "executed" | "failed" | "expired" | "cancelled";

export interface SuperadminActionIntentRow {
  readonly id: string;
  readonly tipo: IntentTipo;
  readonly payload: Record<string, unknown>;
  readonly resumen: string;
  readonly estado: IntentEstado;
  readonly creadoPor: string | null;
  readonly creadoEn: string;
  readonly venceEn: string;
  readonly confirmadoEn: string | null;
  readonly ejecutadoEn: string | null;
  readonly resultado: unknown | null;
  readonly error: string | null;
}

export interface AutomationActionLogRow {
  readonly id: string;
  readonly tipo: "outbox_desatascado" | "prospecto_marcado_seguimiento";
  readonly tabla: string;
  readonly objetivoId: string;
  readonly detalle: Record<string, unknown>;
  readonly ejecutadoEn: string;
  readonly executedBy: "system";
}

/** Cola de mensajería de vertical -- mismo catálogo cerrado de 6 nombres que
 *  `SaludRepository::OutboxQueueHealthRow` usa por vertical. */
export type OutboxQueueName = "citas" | "hoteles" | "restaurantes" | "despachos" | "rentas" | "licitaciones";

export interface OutboxDeadMessageRow {
  readonly queueName: OutboxQueueName;
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly channel: string;
  readonly eventType: string;
  /** Último error que lo mató -- `null` cuando ninguna columna de error de
   *  esa vertical tiene valor. */
  readonly error: string | null;
  readonly createdAt: string;
}

export interface OutboxDeadMessageDetailRow extends OutboxDeadMessageRow {
  readonly payload: Record<string, unknown>;
}

export interface DesatascarOutboxResultRow {
  readonly queueName: OutboxQueueName;
  /** `false` = esta cola NO tiene forma cierta de saber si una fila
   *  `processing` está colgada (sin columna `claimed_at`) -- ver el
   *  comentario largo de `core._desatascar_outbox_colgados`. */
  readonly aplica: boolean;
  /** `null` cuando `aplica` es `false`. */
  readonly filasMovidas: number | null;
  readonly motivo: string | null;
}

export interface MarcarProspectoResultRow {
  readonly prospectoId: string;
  readonly empresa: string;
}

export interface SuperadminAccionesRepository {
  // ── Automatizaciones (sesión de SISTEMA) ──────────────────────────────
  desatascarOutboxColgadosForSystem(umbralMinutos: number): Promise<readonly DesatascarOutboxResultRow[]>;
  marcarProspectosSinMovimientoForSystem(umbralDias: number): Promise<readonly MarcarProspectoResultRow[]>;

  // ── Máquina de estados del intent (sesión del caller) ─────────────────
  /** Primer POST -- crea el intent, NUNCA ejecuta nada. Lanza si `tipo`/
   *  `payload` son inválidos (ver el CHECK de la migración). */
  crearIntent(callerId: string, tipo: IntentTipo, payload: Record<string, unknown>, resumen: string, venceEnMinutos: number): Promise<SuperadminActionIntentRow>;
  /** Segundo POST -- confirma y ejecuta (o marca `failed` con el motivo).
   *  Devuelve el intent TAL CUAL cuando ya no es confirmable (vencido/
   *  ajeno/reutilizado) -- la capa HTTP decide el código a partir de
   *  `estado`, ver `apps/api/src/routes/superadmin-acciones.ts`. Lanza SOLO
   *  cuando el intent no existe o no pertenece a este caller (ver la
   *  migración). */
  confirmarIntent(callerId: string, intentId: string): Promise<SuperadminActionIntentRow>;
  /** Lanza si el intent no es cancelable (ya no está `pending`, venció, o
   *  no pertenece a este caller). */
  cancelarIntent(callerId: string, intentId: string): Promise<SuperadminActionIntentRow>;

  // ── Lecturas para el back office (sesión del caller) ──────────────────
  listIntentsForSuperadmin(callerId: string, limit: number): Promise<readonly SuperadminActionIntentRow[]>;
  listAutomationActionLogForSuperadmin(callerId: string, limit: number): Promise<readonly AutomationActionLogRow[]>;
  listOutboxMensajesMuertosForSuperadmin(callerId: string, limit: number): Promise<readonly OutboxDeadMessageRow[]>;
  /** `null` = no existe un mensaje `dead` con ese id en esa cola (ya lo
   *  movieron, o nunca existió). */
  getOutboxDeadMessageForSuperadmin(callerId: string, queue: OutboxQueueName, mensajeId: string): Promise<OutboxDeadMessageDetailRow | null>;
}

// ═══════════════════════════════════════════════════════════════════════════
// PostgresSuperadminAccionesRepository
// ═══════════════════════════════════════════════════════════════════════════

interface IntentRawRow {
  readonly id: string;
  readonly tipo: IntentTipo;
  readonly payload: Record<string, unknown>;
  readonly resumen: string;
  readonly estado: IntentEstado;
  readonly creado_por: string | null;
  readonly creado_en: string;
  readonly vence_en: string;
  readonly confirmado_en: string | null;
  readonly ejecutado_en: string | null;
  readonly resultado: unknown | null;
  readonly error: string | null;
}

function mapIntent(row: IntentRawRow): SuperadminActionIntentRow {
  return {
    id: row.id,
    tipo: row.tipo,
    payload: row.payload ?? {},
    resumen: row.resumen,
    estado: row.estado,
    creadoPor: row.creado_por,
    creadoEn: row.creado_en,
    venceEn: row.vence_en,
    confirmadoEn: row.confirmado_en,
    ejecutadoEn: row.ejecutado_en,
    resultado: row.resultado,
    error: row.error,
  };
}

interface AutomationLogRawRow {
  readonly id: string;
  readonly tipo: AutomationActionLogRow["tipo"];
  readonly tabla: string;
  readonly objetivo_id: string;
  readonly detalle: Record<string, unknown>;
  readonly ejecutado_en: string;
  readonly executed_by: "system";
}

function mapAutomationLog(row: AutomationLogRawRow): AutomationActionLogRow {
  return {
    id: row.id,
    tipo: row.tipo,
    tabla: row.tabla,
    objetivoId: row.objetivo_id,
    detalle: row.detalle ?? {},
    ejecutadoEn: row.ejecutado_en,
    executedBy: row.executed_by,
  };
}

interface OutboxDeadMessageRawRow {
  readonly queue_name: OutboxQueueName;
  readonly id: string;
  readonly organization_id: string;
  readonly organization_name: string;
  readonly channel: string;
  readonly event_type: string;
  readonly error: string | null;
  readonly created_at: string;
}

function mapOutboxDeadMessage(row: OutboxDeadMessageRawRow): OutboxDeadMessageRow {
  return {
    queueName: row.queue_name,
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    channel: row.channel,
    eventType: row.event_type,
    error: row.error,
    createdAt: row.created_at,
  };
}

interface DesatascarRawRow {
  readonly queue_name: OutboxQueueName;
  readonly aplica: boolean;
  readonly filas_movidas: string | null;
  readonly motivo: string | null;
}

interface MarcarRawRow {
  readonly prospecto_id: string;
  readonly empresa: string;
}

export class PostgresSuperadminAccionesRepository implements SuperadminAccionesRepository {
  constructor(private readonly db: TenantDbSession) {}

  async desatascarOutboxColgadosForSystem(umbralMinutos: number): Promise<readonly DesatascarOutboxResultRow[]> {
    const { rows } = await this.db.query<DesatascarRawRow>(`select queue_name, aplica, filas_movidas, motivo from core.desatascar_outbox_colgados_for_system($1);`, [umbralMinutos]);
    return rows.map((r) => ({ queueName: r.queue_name, aplica: r.aplica, filasMovidas: r.filas_movidas === null ? null : Number(r.filas_movidas), motivo: r.motivo }));
  }

  async marcarProspectosSinMovimientoForSystem(umbralDias: number): Promise<readonly MarcarProspectoResultRow[]> {
    const { rows } = await this.db.query<MarcarRawRow>(`select prospecto_id, empresa from core.marcar_prospectos_sin_movimiento_for_system($1);`, [umbralDias]);
    return rows.map((r) => ({ prospectoId: r.prospecto_id, empresa: r.empresa }));
  }

  async crearIntent(callerId: string, tipo: IntentTipo, payload: Record<string, unknown>, resumen: string, venceEnMinutos: number): Promise<SuperadminActionIntentRow> {
    const { rows } = await this.db.query<IntentRawRow>(
      `select id, tipo, payload, resumen, estado, creado_por, creado_en, vence_en, confirmado_en, ejecutado_en, resultado, error
       from core.crear_superadmin_action_intent_for_superadmin($1, $2, $3, $4, $5);`,
      [callerId, tipo, JSON.stringify(payload), resumen, venceEnMinutos],
    );
    const row = rows[0];
    if (!row) throw new Error("crear_superadmin_action_intent_for_superadmin no devolvió ninguna fila.");
    return mapIntent(row);
  }

  async confirmarIntent(callerId: string, intentId: string): Promise<SuperadminActionIntentRow> {
    const { rows } = await this.db.query<IntentRawRow>(
      `select id, tipo, payload, resumen, estado, creado_por, creado_en, vence_en, confirmado_en, ejecutado_en, resultado, error
       from core.confirmar_superadmin_action_intent_for_superadmin($1, $2);`,
      [callerId, intentId],
    );
    const row = rows[0];
    if (!row) throw new Error("confirmar_superadmin_action_intent_for_superadmin no devolvió ninguna fila.");
    return mapIntent(row);
  }

  async cancelarIntent(callerId: string, intentId: string): Promise<SuperadminActionIntentRow> {
    const { rows } = await this.db.query<IntentRawRow>(
      `select id, tipo, payload, resumen, estado, creado_por, creado_en, vence_en, confirmado_en, ejecutado_en, resultado, error
       from core.cancelar_superadmin_action_intent_for_superadmin($1, $2);`,
      [callerId, intentId],
    );
    const row = rows[0];
    if (!row) throw new Error("cancelar_superadmin_action_intent_for_superadmin no devolvió ninguna fila.");
    return mapIntent(row);
  }

  async listIntentsForSuperadmin(callerId: string, limit: number): Promise<readonly SuperadminActionIntentRow[]> {
    const { rows } = await this.db.query<IntentRawRow>(
      `select id, tipo, payload, resumen, estado, creado_por, creado_en, vence_en, confirmado_en, ejecutado_en, resultado, error
       from core.list_superadmin_action_intents_for_superadmin($1, $2);`,
      [callerId, limit],
    );
    return rows.map(mapIntent);
  }

  async listAutomationActionLogForSuperadmin(callerId: string, limit: number): Promise<readonly AutomationActionLogRow[]> {
    const { rows } = await this.db.query<AutomationLogRawRow>(
      `select id, tipo, tabla, objetivo_id, detalle, ejecutado_en, executed_by
       from core.list_automation_action_log_for_superadmin($1, $2);`,
      [callerId, limit],
    );
    return rows.map(mapAutomationLog);
  }

  async listOutboxMensajesMuertosForSuperadmin(callerId: string, limit: number): Promise<readonly OutboxDeadMessageRow[]> {
    const { rows } = await this.db.query<OutboxDeadMessageRawRow>(
      `select queue_name, id, organization_id, organization_name, channel, event_type, error, created_at
       from core.list_outbox_mensajes_muertos_for_superadmin($1, $2);`,
      [callerId, limit],
    );
    return rows.map(mapOutboxDeadMessage);
  }

  async getOutboxDeadMessageForSuperadmin(callerId: string, queue: OutboxQueueName, mensajeId: string): Promise<OutboxDeadMessageDetailRow | null> {
    const { rows } = await this.db.query<OutboxDeadMessageRawRow & { payload: Record<string, unknown> }>(
      `select queue_name, id, organization_id, organization_name, channel, event_type, payload, error, created_at
       from core.get_outbox_dead_message_for_superadmin($1, $2, $3);`,
      [callerId, queue, mensajeId],
    );
    const row = rows[0];
    if (!row) return null;
    return { ...mapOutboxDeadMessage(row), payload: row.payload ?? {} };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// InMemorySuperadminAccionesRepository — referencia real (no un mock) para
// tests, MISMO criterio que `InMemorySaludRepository`: mantiene su propio set
// de superadmins (`addPlatformSuperadmin`) porque las funciones SQL reales
// verifican `is_platform_superadmin` por dentro, y su propio catálogo de
// mensajes muertos sembrados (`seedOutboxDeadMessage`) porque este repo no
// simula las 6 tablas reales de outbox -- MISMO criterio que
// `seedOutboxHealth`.
//
// Replica la máquina de estados real (incluida la confirmación atómica --
// aquí es trivialmente atómica porque JS es de un solo hilo, no hay
// condición de carrera real que simular, a diferencia del caso concurrente
// real que solo Postgres puede probar, ver `scripts/verify-superadmin-
// acciones/`).
// ═══════════════════════════════════════════════════════════════════════════

const CATALOGO_TIPOS: readonly IntentTipo[] = ["reencolar_mensaje_muerto", "cerrar_prospecto", "ejecutar_mantenimiento_ahora"];

export class InMemorySuperadminAccionesRepository implements SuperadminAccionesRepository {
  private readonly isSuperadmin = new Set<string>();
  private readonly intents = new Map<string, SuperadminActionIntentRow>();
  private readonly automationLog: AutomationActionLogRow[] = [];
  private readonly deadMessages = new Map<string, OutboxDeadMessageDetailRow>();
  private now: () => Date = () => new Date();
  /** `cerrar_prospecto` REUTILIZA `core.update_prospecto_for_superadmin` (la
   *  MISMA función que el editor de prospectos) -- en producción eso pasa
   *  DENTRO de la función SQL `confirmar_superadmin_action_intent_for_
   *  superadmin`; en memoria, `core.prospecto` vive en
   *  `InMemoryCoreRepository` (un objeto DISTINTO), así que este callback es
   *  el equivalente de esa misma reutilización -- `apps/api/tests/fixtures.ts`
   *  lo conecta a `coreRepo.updateProspectoForSuperadmin`. `null` = sin
   *  conectar (el intent `cerrar_prospecto` queda `failed`, nunca finge un
   *  éxito). */
  private ejecutarCerrarProspecto: ((callerId: string, prospectoId: string, estado: string) => Promise<{ readonly id: string; readonly estado: string }>) | null = null;
  /** Solo para tests -- simula la migración `0016_superadmin_acciones.sql`
   *  SIN APLICAR: `desatascarOutboxColgadosForSystem`/`marcarProspectosSin
   *  MovimientoForSystem` (el cron `/internal/superadmin/mantenimiento`)
   *  lanzan con `.code = "42883"`, igual que el driver `pg` real reporta
   *  `undefined_function` -- fixture del hallazgo de auditoría a1 (rubro C). */
  private migracionPendiente = false;

  addPlatformSuperadmin(staffId: string): void {
    this.isSuperadmin.add(staffId);
  }

  setMigracionPendiente(pendiente: boolean): void {
    this.migracionPendiente = pendiente;
  }

  private checarMigracionPendiente(nombreFuncion: string): void {
    if (!this.migracionPendiente) return;
    const err = new Error(`function ${nombreFuncion} does not exist`) as Error & { code: string };
    err.code = "42883";
    throw err;
  }

  /** Solo para tests -- fija el reloj que usa esta instancia (crear/vencer
   *  intents), mismo criterio que el resto de motores puros de este repo
   *  (`salud/motor.ts`/`resumen-diario/motor.ts` reciben `ahora` explícito). */
  setClock(now: () => Date): void {
    this.now = now;
  }

  /** Solo para tests/wiring -- ver el comentario del campo. */
  setEjecutarCerrarProspecto(fn: (callerId: string, prospectoId: string, estado: string) => Promise<{ readonly id: string; readonly estado: string }>): void {
    this.ejecutarCerrarProspecto = fn;
  }

  /** Solo para tests -- siembra un mensaje `dead` reencolable de una cola. */
  seedOutboxDeadMessage(row: OutboxDeadMessageDetailRow): void {
    this.deadMessages.set(`${row.queueName}:${row.id}`, row);
  }

  private key(queue: OutboxQueueName, id: string): string {
    return `${queue}:${id}`;
  }

  async desatascarOutboxColgadosForSystem(): Promise<readonly DesatascarOutboxResultRow[]> {
    this.checarMigracionPendiente("core.desatascar_outbox_colgados_for_system(integer)");
    // El repo en memoria no simula las 6 tablas reales de outbox (mismo
    // criterio que `InMemorySaludRepository.getOutboxHealthForSuperadmin`) --
    // devuelve el catálogo de "qué aplica" tal cual, con 0 filas movidas
    // (nunca inventa una fila real). El comportamiento real solo lo prueba
    // `scripts/verify-superadmin-acciones/` contra Postgres real.
    return [
      { queueName: "citas", aplica: true, filasMovidas: 0, motivo: null },
      { queueName: "hoteles", aplica: true, filasMovidas: 0, motivo: null },
      { queueName: "restaurantes", aplica: true, filasMovidas: 0, motivo: null },
      { queueName: "rentas", aplica: true, filasMovidas: 0, motivo: null },
      { queueName: "despachos", aplica: false, filasMovidas: null, motivo: "sin columna claimed_at: no se puede saber con certeza desde cuándo una fila processing está colgada" },
      { queueName: "licitaciones", aplica: false, filasMovidas: null, motivo: "sin columna claimed_at: no se puede saber con certeza desde cuándo una fila processing está colgada" },
    ];
  }

  async marcarProspectosSinMovimientoForSystem(): Promise<readonly MarcarProspectoResultRow[]> {
    this.checarMigracionPendiente("core.marcar_prospectos_sin_movimiento_for_system(integer)");
    // Mismo criterio que `desatascarOutboxColgadosForSystem` -- este repo no
    // trae su propia copia de `core.prospecto` (eso vive en
    // `InMemoryCoreRepository`); el comportamiento real de "qué se marca" se
    // prueba en `scripts/verify-superadmin-acciones/`, no aquí.
    return [];
  }

  async crearIntent(callerId: string, tipo: IntentTipo, payload: Record<string, unknown>, resumen: string, venceEnMinutos: number): Promise<SuperadminActionIntentRow> {
    if (!this.isSuperadmin.has(callerId)) throw new Error("forbidden");
    if (!CATALOGO_TIPOS.includes(tipo)) throw new Error(`tipo de acción desconocido o no disponible: ${tipo}`);
    if (!resumen || resumen.trim().length === 0) throw new Error("p_resumen no puede estar vacío");
    const minutos = Math.max(1, Math.min(venceEnMinutos || 5, 30));
    const now = this.now();
    const row: SuperadminActionIntentRow = {
      id: randomUUID(),
      tipo,
      payload,
      resumen,
      estado: "pending",
      creadoPor: callerId,
      creadoEn: now.toISOString(),
      venceEn: new Date(now.getTime() + minutos * 60_000).toISOString(),
      confirmadoEn: null,
      ejecutadoEn: null,
      resultado: null,
      error: null,
    };
    this.intents.set(row.id, row);
    return row;
  }

  async confirmarIntent(callerId: string, intentId: string): Promise<SuperadminActionIntentRow> {
    if (!this.isSuperadmin.has(callerId)) throw new Error("forbidden");
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error("intent no encontrado");
    if (intent.creadoPor !== callerId) throw new Error("este intent no fue creado por este superadmin");

    if (intent.estado !== "pending") return intent;
    if (new Date(intent.venceEn).getTime() <= this.now().getTime()) {
      const expired = { ...intent, estado: "expired" as const };
      this.intents.set(intentId, expired);
      return expired;
    }

    try {
      const resultado = await this.ejecutar(callerId, intent);
      const executed: SuperadminActionIntentRow = { ...intent, estado: "executed", confirmadoEn: this.now().toISOString(), ejecutadoEn: this.now().toISOString(), resultado, error: null };
      this.intents.set(intentId, executed);
      return executed;
    } catch (err) {
      const failed: SuperadminActionIntentRow = { ...intent, estado: "failed", confirmadoEn: this.now().toISOString(), ejecutadoEn: this.now().toISOString(), error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500) };
      this.intents.set(intentId, failed);
      return failed;
    }
  }

  private async ejecutar(callerId: string, intent: SuperadminActionIntentRow): Promise<unknown> {
    if (intent.tipo === "reencolar_mensaje_muerto") {
      const queue = intent.payload.queue as OutboxQueueName;
      const mensajeId = intent.payload.mensajeId as string;
      const key = this.key(queue, mensajeId);
      const dead = this.deadMessages.get(key);
      if (!dead) throw new Error(`el mensaje ${mensajeId} de la cola ${queue} ya no está en estado dead (lo movieron, ya se reencoló antes, o ya no existe)`);
      this.deadMessages.delete(key);
      return { reencolado: true, queue, mensajeId };
    }
    if (intent.tipo === "cerrar_prospecto") {
      if (!this.ejecutarCerrarProspecto) throw new Error("cerrar_prospecto: InMemorySuperadminAccionesRepository.setEjecutarCerrarProspecto no fue conectado (ver apps/api/tests/fixtures.ts)");
      const prospectoId = intent.payload.prospectoId as string;
      const estado = intent.payload.estado as string;
      const prospecto = await this.ejecutarCerrarProspecto(callerId, prospectoId, estado);
      return { prospectoId: prospecto.id, estado: prospecto.estado };
    }
    if (intent.tipo === "ejecutar_mantenimiento_ahora") {
      const outbox = await this.desatascarOutboxColgadosForSystem();
      const prospectos = await this.marcarProspectosSinMovimientoForSystem();
      return { outbox, prospectos };
    }
    throw new Error(`tipo de intent no ejecutable: ${intent.tipo}`);
  }

  async cancelarIntent(callerId: string, intentId: string): Promise<SuperadminActionIntentRow> {
    if (!this.isSuperadmin.has(callerId)) throw new Error("forbidden");
    const intent = this.intents.get(intentId);
    if (!intent || intent.estado !== "pending" || intent.creadoPor !== callerId) {
      throw new Error("intent no cancelable (ya no está pending, venció, o no pertenece a este caller)");
    }
    const cancelled: SuperadminActionIntentRow = { ...intent, estado: "cancelled" };
    this.intents.set(intentId, cancelled);
    return cancelled;
  }

  async listIntentsForSuperadmin(callerId: string, limit: number): Promise<readonly SuperadminActionIntentRow[]> {
    if (!this.isSuperadmin.has(callerId)) return [];
    return [...this.intents.values()].sort((a, b) => b.creadoEn.localeCompare(a.creadoEn)).slice(0, limit);
  }

  async listAutomationActionLogForSuperadmin(callerId: string, limit: number): Promise<readonly AutomationActionLogRow[]> {
    if (!this.isSuperadmin.has(callerId)) return [];
    return [...this.automationLog].sort((a, b) => b.ejecutadoEn.localeCompare(a.ejecutadoEn)).slice(0, limit);
  }

  async listOutboxMensajesMuertosForSuperadmin(callerId: string, limit: number): Promise<readonly OutboxDeadMessageRow[]> {
    if (!this.isSuperadmin.has(callerId)) return [];
    return [...this.deadMessages.values()].slice(0, limit);
  }

  async getOutboxDeadMessageForSuperadmin(callerId: string, queue: OutboxQueueName, mensajeId: string): Promise<OutboxDeadMessageDetailRow | null> {
    if (!this.isSuperadmin.has(callerId)) return null;
    return this.deadMessages.get(this.key(queue, mensajeId)) ?? null;
  }
}
