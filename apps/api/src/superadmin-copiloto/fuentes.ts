// Fuentes de datos del Copiloto de superadmin (CHAT-16). Un puerto (`FuentesPlataforma`) con una lectura por cada herramienta del catalogo
// de plataforma: SOLO LECTURA, y cada una llama UNICAMENTE a funciones `core.*_for_superadmin` YA existentes a traves de los repositorios
// que el back office ya usa (nunca SQL libre, nunca una sesion de sistema: cada funcion exige `auth.uid() = p_caller_id`, asi que corre con
// la identidad del superadmin que pregunta). Lo unico propio de este archivo es:
//   * convertir "migracion pendiente" o cualquier fallo en un vacio honesto (`{ ok: false, razon }`): el Copiloto dice "no tengo el dato",
//     jamas inventa una cifra ni responde 500;
//   * correr cada lectura dentro de la sesion del turno bajo SAVEPOINT (`runWithSavepointFallback`): un error de Postgres en una fuente
//     (p. ej. una funcion que la base sin migrar aun no tiene, SQLSTATE 42883/42P01/42703) revierte SOLO ese savepoint y deja la
//     transaccion del turno utilizable para las demas herramientas y para la bitacora (si no, el siguiente SQL fallaria con 25P02);
//   * nunca exponer contenido de conversaciones de organizaciones ni PII de clientes finales: los repositorios elegidos solo devuelven
//     agregados, estados y nombres de organizacion (las herramientas ademas recortan columnas con datos de contacto).
import type { TenantDbSession } from "@atiende/core-tenancy";
import type {
  AgentRunRow,
  AuthzAuditLogRow,
  BillingSnapshotRow,
  CfoOrgRow,
  ConsolaAgenteActividadRow,
  ConsolaConversacionesWaRow,
  ConsolaOperacionRow,
  ConsolaOrganizacionRow,
  ContratoVersionRow,
  CronHeartbeatRow,
  InfraCostRow,
  LicitacionesFuenteRunRow,
  LlmPlatformBudgetRow,
  LlmUsageByOrganizationRow,
  LlmUsageByOrgRoleMonthRow,
  LlmUsageByProviderModelRow,
  LlmUsageSummaryRow,
  OutboxDeadMessageRow,
  OutboxQueueHealthRow,
  PlanAssignmentRow,
  PlanRow,
  PlatformSwitchRow,
  ProspectoRow,
  SecurityEventRow,
  SuperadminOrganizationBillingRow,
  SuperadminOrganizationRow,
} from "@atiende/db";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { AppDeps } from "../deps.ts";

export type RazonFuente = "no_migrado" | "error" | "sin_repositorio";
export type Fuente<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly razon: RazonFuente };

export interface OrganizacionPlataforma extends SuperadminOrganizationRow {
  readonly staffCount: number;
}

/** Fila agregada del uso del Copiloto (core.get_copiloto_uso_for_superadmin): sin usuarios ni texto. */
export interface CopilotoUsoRow {
  readonly vertical: string;
  readonly outcome: string;
  readonly route: string | null;
  readonly consultas: number;
  readonly filas: number;
  readonly duracionMs: number;
  readonly costoMicroUsd: number;
}

/** Fila agregada por organizacion (core.get_operaciones_por_organizacion_for_superadmin): SOLO conteos y sumas, nunca datos de clientes finales. `null` = la vertical no guarda ese dato. */
export interface OperacionOrganizacionRow {
  readonly organizationId: string;
  readonly vertical: string;
  readonly operaciones: number | null;
  /** MXN; solo restaurantes (pedidos) y hoteles (reservas). */
  readonly ingresos: number | null;
  readonly escalaciones: number | null;
  readonly abiertos: number | null;
  readonly vencidos: number | null;
  readonly razon: "fuente_no_migrada" | null;
}

export type AccionAccesoCfo = "consulta" | "denegado";
export type ResultadoAccesoCfo = "ok" | "no_migrado" | "error";

export interface FuentesPlataforma {
  organizaciones(): Promise<Fuente<readonly OrganizacionPlataforma[]>>;
  llmResumen(desde: string, hasta: string): Promise<Fuente<LlmUsageSummaryRow>>;
  llmPorOrganizacion(desde: string, hasta: string): Promise<Fuente<readonly LlmUsageByOrganizationRow[]>>;
  llmPorModelo(desde: string, hasta: string): Promise<Fuente<readonly LlmUsageByProviderModelRow[]>>;
  llmPorRolMes(desde: string, hasta: string): Promise<Fuente<readonly LlmUsageByOrgRoleMonthRow[]>>;
  presupuestoPlataforma(): Promise<Fuente<LlmPlatformBudgetRow>>;
  /** Gasto del mes en curso del propio Copiloto de plataforma (micro-USD), de la bitacora (migracion 0048). */
  copilotoGastoMes(): Promise<Fuente<number>>;
  copilotoUso(desde: string, hasta: string): Promise<Fuente<readonly CopilotoUsoRow[]>>;
  consolaOrganizaciones(): Promise<Fuente<readonly ConsolaOrganizacionRow[]>>;
  consolaOperaciones(desde: string, hasta: string): Promise<Fuente<readonly ConsolaOperacionRow[]>>;
  consolaConversacionesWa(): Promise<Fuente<readonly ConsolaConversacionesWaRow[]>>;
  consolaAgentesActividad(hoy: string): Promise<Fuente<readonly ConsolaAgenteActividadRow[]>>;
  interruptores(): Promise<Fuente<readonly PlatformSwitchRow[]>>;
  corridasAgentes(limite: number): Promise<Fuente<readonly AgentRunRow[]>>;
  heartbeats(): Promise<Fuente<readonly CronHeartbeatRow[]>>;
  colas(): Promise<Fuente<readonly OutboxQueueHealthRow[]>>;
  colasMuertos(limite: number): Promise<Fuente<readonly OutboxDeadMessageRow[]>>;
  fuentesLicitaciones(): Promise<Fuente<readonly LicitacionesFuenteRunRow[]>>;
  denegaciones(limite: number): Promise<Fuente<readonly AuthzAuditLogRow[]>>;
  eventosSeguridad(limite: number): Promise<Fuente<readonly SecurityEventRow[]>>;
  planes(): Promise<Fuente<readonly PlanRow[]>>;
  asignaciones(limite: number): Promise<Fuente<readonly PlanAssignmentRow[]>>;
  prospectos(): Promise<Fuente<readonly ProspectoRow[]>>;
  // ---- Copiloto CFO (SA-33): solo con step-up o rol `finanzas`; cada llamada deja fila en core.cfo_access_log ----
  /** `mes` = `YYYY-MM`. */
  cfoFilas(mes: string): Promise<Fuente<readonly CfoOrgRow[]>>;
  cfoFotos(desde: string, hasta: string): Promise<Fuente<readonly BillingSnapshotRow[]>>;
  infra(desde: string, hasta: string): Promise<Fuente<readonly InfraCostRow[]>>;
  contratos(): Promise<Fuente<readonly ContratoVersionRow[]>>;
  /** Facturacion por organizacion (core.list_organization_billing_for_superadmin): estado de la suscripcion, asientos y fin del periodo. Sin correos ni ids de Stripe en el catalogo. */
  facturacion(): Promise<Fuente<readonly SuperadminOrganizationBillingRow[]>>;
  // ---- Lecturas por organizacion (seguimiento de CHAT-17): agregados sin datos personales, con bitacora por organizacion ----
  /** `desde`/`hasta`/`hoy` = `YYYY-MM-DD` (dia de la plataforma). Con `organizationId` solo esa; sin el, TODAS (las sin actividad salen con 0). */
  operacionesPorOrganizacion(desde: string, hasta: string, hoy: string, organizationId?: string | null): Promise<Fuente<readonly OperacionOrganizacionRow[]>>;
  /** Una fila en core.superadmin_org_access_log por organizacion consultada (transaccion PROPIA, confirmada ANTES de leer el dato). */
  registrarAccesoOrganizaciones(organizationIds: readonly string[], herramienta: string, filtros: Readonly<Record<string, unknown>>): Promise<ResultadoAccesoCfo>;
  /** Registra el acceso en core.cfo_access_log (transaccion PROPIA, confirmada antes de leer el dato). */
  registrarAccesoCfo(accion: AccionAccesoCfo, recurso: string, filtros: Readonly<Record<string, unknown>>): Promise<ResultadoAccesoCfo>;
}

function razonDe(err: unknown): RazonFuente {
  return isMigrationPendingError(err) ? "no_migrado" : "error";
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const SIN_REPO: Fuente<never> = { ok: false, razon: "sin_repositorio" };

/**
 * Fuentes de produccion: cada lectura usa la sesion del turno (`db`, ya abierta con la identidad del superadmin) bajo SAVEPOINT cuando el
 * repositorio es de sesion, o el repositorio fijo del back office (que abre su propia sesion con el `callerId`) dentro de un try/catch.
 */
export function fuentesDeProduccion(deps: AppDeps, db: TenantDbSession, callerId: string): FuentesPlataforma {
  /**
   * Lectura con repositorio ligado a la sesion del turno: SAVEPOINT + degradacion a "no disponible". La sesion del turno es UNA sola transaccion: dos
   * SAVEPOINT concurrentes se intercalan en la cola FIFO del cliente (SP A, SP B, QA, QB, RELEASE A, RELEASE B) y el RELEASE de A destruye tambien B, con lo que
   * RELEASE B falla (3B001) y la transaccion queda abortada. Por eso las lecturas en sesion se encolan en una cadena: aunque la herramienta las lance con
   * Promise.all, se ejecutan una tras otra y cada SAVEPOINT se abre y se cierra antes de que empiece el siguiente.
   */
  let colaSesion: Promise<unknown> = Promise.resolve();
  const enSesion = <T>(leer: () => Promise<Fuente<T>>): Promise<Fuente<T>> => {
    const turno = colaSesion.then(() =>
      runWithSavepointFallback<Fuente<T>>({ session: db, primary: leer, isRecoverable: () => true, fallback: async (err) => ({ ok: false, razon: razonDe(err) }) }),
    );
    colaSesion = turno.catch(() => undefined);
    return turno;
  };
  /** Lectura con un repositorio fijo (su propia sesion): un fallo no toca la transaccion del turno. */
  const propio = async <T>(leer: () => Promise<T>): Promise<Fuente<T>> => {
    try {
      return { ok: true, data: await leer() };
    } catch (err) {
      return { ok: false, razon: razonDe(err) };
    }
  };
  /** Repositorios que devuelven `availability`. */
  const conDisponibilidad = <T>(r: { readonly availability: "available" | "not_migrated" }, data: () => T): Fuente<T> =>
    r.availability === "not_migrated" ? { ok: false, razon: "no_migrado" } : { ok: true, data: data() };

  return {
    async organizaciones() {
      return propio(async () => {
        const [organizations, staff] = await Promise.all([deps.coreRepo.listAllOrganizationsForSuperadmin(callerId), deps.coreRepo.countStaffByOrganizationForSuperadmin(callerId)]);
        return organizations.map((o) => ({ ...o, staffCount: staff.get(o.id) ?? 0 }));
      });
    },
    llmResumen: (desde, hasta) => propio(() => deps.llmUsageRepo.getUsageSummaryForSuperadmin(callerId, desde, hasta)),
    llmPorOrganizacion: (desde, hasta) => propio(() => deps.llmUsageRepo.listUsageByOrganizationForSuperadmin(callerId, desde, hasta)),
    llmPorModelo: (desde, hasta) => propio(() => deps.llmUsageRepo.listUsageByProviderModelForSuperadmin(callerId, desde, hasta, null)),
    llmPorRolMes: (desde, hasta) => propio(() => deps.llmUsageRepo.listUsageByOrgRoleMonthForSuperadmin(callerId, desde, hasta)),
    presupuestoPlataforma: () => propio(() => deps.llmUsageRepo.getPlatformBudgetForSuperadmin(callerId)),
    copilotoGastoMes: () =>
      enSesion(async () => {
        const { rows } = await db.query<{ gasto: string | number | null }>(`select core.get_copiloto_plataforma_gasto_mes($1::uuid) as gasto;`, [callerId]);
        return { ok: true as const, data: num(rows[0]?.gasto) };
      }),
    copilotoUso: (desde, hasta) =>
      enSesion(async () => {
        const { rows } = await db.query<{ vertical: string; outcome: string; route: string | null; consultas: string | number; filas: string | number; duracion_ms: string | number; costo_micro_usd: string | number }>(
          `select vertical, outcome, route, consultas, filas, duracion_ms, costo_micro_usd from core.get_copiloto_uso_for_superadmin($1::uuid, $2::date, $3::date);`,
          [callerId, desde, hasta],
        );
        return {
          ok: true as const,
          data: rows.map((r) => ({ vertical: r.vertical, outcome: r.outcome, route: r.route, consultas: num(r.consultas), filas: num(r.filas), duracionMs: num(r.duracion_ms), costoMicroUsd: num(r.costo_micro_usd) })),
        };
      }),
    consolaOrganizaciones: () => (deps.consolaRepo ? enSesion(() => deps.consolaRepo!(db).organizaciones(callerId)) : Promise.resolve(SIN_REPO)),
    consolaOperaciones: (desde, hasta) => (deps.consolaRepo ? enSesion(() => deps.consolaRepo!(db).operaciones(callerId, desde, hasta)) : Promise.resolve(SIN_REPO)),
    consolaConversacionesWa: () => (deps.consolaRepo ? enSesion(() => deps.consolaRepo!(db).conversacionesWa(callerId)) : Promise.resolve(SIN_REPO)),
    consolaAgentesActividad: (hoy) => (deps.consolaRepo ? enSesion(() => deps.consolaRepo!(db).agentesActividad(callerId, hoy)) : Promise.resolve(SIN_REPO)),
    interruptores: () =>
      deps.platformSwitchRepo
        ? enSesion(async () => {
            const r = await deps.platformSwitchRepo!(db).list(callerId);
            return conDisponibilidad(r, () => r.switches);
          })
        : Promise.resolve(SIN_REPO),
    corridasAgentes: (limite) => (deps.agentRunRepo ? enSesion(() => deps.agentRunRepo!(db).listarCorridas(callerId, { limite })) : Promise.resolve(SIN_REPO)),
    heartbeats: () => propio(() => deps.saludRepo.listCronHeartbeatsForSuperadmin(callerId)),
    colas: () => propio(() => deps.saludRepo.getOutboxHealthForSuperadmin(callerId)),
    colasMuertos: (limite) => propio(() => deps.accionesRepo.listOutboxMensajesMuertosForSuperadmin(callerId, limite)),
    fuentesLicitaciones: () => propio(() => deps.saludRepo.listLicitacionesFuenteRunsForSuperadmin(callerId)),
    denegaciones: (limite) =>
      enSesion(async () => {
        const r = await deps.authzAuditRepo(db).list(callerId, limite, 0);
        return conDisponibilidad(r, () => r.entries);
      }),
    eventosSeguridad: (limite) =>
      deps.mfaRepo
        ? enSesion(async () => {
            const r = await deps.mfaRepo!(db).listEvents(callerId, null, limite);
            return conDisponibilidad(r, () => r.events);
          })
        : Promise.resolve(SIN_REPO),
    planes: () =>
      deps.costosPlanesRepo
        ? enSesion(async () => {
            const r = await deps.costosPlanesRepo!(db).listPlans(callerId);
            return conDisponibilidad(r, () => r.plans);
          })
        : Promise.resolve(SIN_REPO),
    asignaciones: (limite) =>
      deps.costosPlanesRepo
        ? enSesion(async () => {
            const r = await deps.costosPlanesRepo!(db).listAssignments(callerId, limite);
            return conDisponibilidad(r, () => r.assignments);
          })
        : Promise.resolve(SIN_REPO),
    prospectos: () => propio(() => deps.coreRepo.listProspectosForSuperadmin(callerId)),
    cfoFilas: (mes) =>
      deps.cfoRepo
        ? enSesion(async () => {
            const r = await deps.cfoRepo!(db).getDashboardRows(callerId, `${mes}-01`);
            return conDisponibilidad(r, () => r.rows);
          })
        : Promise.resolve(SIN_REPO),
    cfoFotos: (desde, hasta) =>
      deps.cfoRepo
        ? enSesion(async () => {
            const r = await deps.cfoRepo!(db).listSnapshots(callerId, desde, hasta);
            return conDisponibilidad(r, () => r.snapshots);
          })
        : Promise.resolve(SIN_REPO),
    infra: (desde, hasta) =>
      deps.pylRepo
        ? enSesion(async () => {
            const r = await deps.pylRepo!(db).listInfraCosts(callerId, desde, hasta);
            return conDisponibilidad(r, () => r.costs);
          })
        : Promise.resolve(SIN_REPO),
    contratos: () =>
      deps.contratosRepo
        ? enSesion(async () => {
            const r = await deps.contratosRepo!(db).listVersions(callerId, null, 500);
            return conDisponibilidad(r, () => r.versions);
          })
        : Promise.resolve(SIN_REPO),
    facturacion: () => propio(() => deps.coreRepo.listOrganizationBillingForSuperadmin(callerId)),
    operacionesPorOrganizacion: (desde, hasta, hoy, organizationId) =>
      enSesion(async () => {
        const { rows } = await db.query<{
          organization_id: string;
          vertical: string;
          operaciones: string | number | null;
          ingresos: string | number | null;
          escalaciones: string | number | null;
          abiertos: string | number | null;
          vencidos: string | number | null;
          razon: string | null;
        }>(
          `select organization_id, vertical, operaciones, ingresos, escalaciones, abiertos, vencidos, razon
             from core.get_operaciones_por_organizacion_for_superadmin($1::uuid, $2::date, $3::date, $4::date, $5::uuid);`,
          [callerId, desde, hasta, hoy, organizationId ?? null],
        );
        const nulo = (v: string | number | null): number | null => (v === null ? null : num(v));
        return {
          ok: true as const,
          data: rows.map((r) => ({
            organizationId: r.organization_id,
            vertical: r.vertical,
            operaciones: nulo(r.operaciones),
            ingresos: nulo(r.ingresos),
            escalaciones: nulo(r.escalaciones),
            abiertos: nulo(r.abiertos),
            vencidos: nulo(r.vencidos),
            razon: r.razon === "fuente_no_migrada" ? ("fuente_no_migrada" as const) : null,
          })),
        };
      }),
    async registrarAccesoOrganizaciones(organizationIds, herramienta, filtros) {
      if (organizationIds.length === 0) return "ok";
      try {
        // Transaccion PROPIA (como la huella CFO): la fila queda confirmada antes de leer y sobrevive a cualquier fallo posterior del turno.
        await deps.engine.withAppSession({ userId: callerId }, async (s) => {
          for (let i = 0; i < organizationIds.length; i += 1000) {
            await s.query(`select core.log_superadmin_org_access($1::uuid, $2::uuid[], $3::text, $4::jsonb);`, [callerId, organizationIds.slice(i, i + 1000), herramienta, JSON.stringify(filtros)]);
          }
        });
        return "ok";
      } catch (err) {
        return isMigrationPendingError(err) ? "no_migrado" : "error";
      }
    },
    async registrarAccesoCfo(accion, recurso, filtros) {
      const repo = deps.cfoZoneRepo;
      // Sin repositorio de la zona CFO no hay rol restringido ni bitacora (mismo criterio que zona-cfo.ts: comportamiento anterior).
      if (!repo) return "no_migrado";
      try {
        // Transaccion PROPIA: la huella queda confirmada antes de leer el dato y sobrevive a cualquier fallo posterior del turno.
        const r = await deps.engine.withAppSession({ userId: callerId }, (s) => repo(s).logAccess(callerId, accion, recurso, filtros));
        return r.availability === "not_migrated" ? "no_migrado" : "ok";
      } catch {
        return "error";
      }
    },
  };
}
