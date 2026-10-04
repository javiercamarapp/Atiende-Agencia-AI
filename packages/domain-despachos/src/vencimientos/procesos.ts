// Procesos de vencimientos que escriben en la base y deben sobrevivir a la base SIN migrar (D-26). Viven en el
// dominio (no en la ruta) para probarlos con `AbortAwareFakeSession`: la transacción de un request es UNA sola y un
// error de Postgres la deja abortada (25P02), así que todo fallback usa SAVEPOINT / ROLLBACK TO SAVEPOINT.
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { DespachosRepository } from "../repository.ts";
import type { DeadlineEscalationRecord, FiscalDeadlineRecord } from "../types.ts";
import { tryEnqueueEscalationEmail } from "./email-notifications.ts";
import { diasHabilesHasta } from "./calendario-fiscal.ts";
import { TIPOS_VENCIMIENTO_BASE, decidirEscalamientoHabil } from "./engine.ts";
import type { DecisionEscalamiento, NivelEscalamiento, NuevoVencimiento, TipoVencimiento } from "./engine.ts";

/** Orden de severidad de los niveles de escalamiento (nivel_4 = vencido). */
const RANGO_NIVEL: Readonly<Record<NivelEscalamiento, number>> = { nivel_1: 1, nivel_2: 2, nivel_3: 3, nivel_4: 4 };

/** SQLSTATE 23514 (check_violation): contra la base sin migrar, 'Balanza' y 'Anual' no caben en el CHECK de `tipo`. */
export function esCheckViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === "23514");
}

export interface ResultadoCrearVencimientos {
  readonly creados: readonly FiscalDeadlineRecord[];
  /** Tipos que la base aún no admite (falta la migración 019 o 024 según el tipo): no se crearon, no se finge lo contrario. */
  readonly omitidos: readonly TipoVencimiento[];
}

/** Persiste las obligaciones calculadas de un periodo. Idempotente y CORRECTIVO: una fila pendiente calculada
 * antes con otra fecha (p. ej. el día 17 fijo del motor anterior) se actualiza al día hábil correcto; las
 * completadas no se tocan. Los tipos agregados por la migración 019 se insertan dentro de un SAVEPOINT: si el
 * CHECK los rechaza (base sin migrar) se omiten y el resto del lote sigue intacto. */
export async function crearVencimientosDelPeriodo(
  repo: DespachosRepository,
  session: TenantDbSession,
  contexto: { readonly organizationId: string; readonly propertyId: string },
  nuevos: readonly NuevoVencimiento[],
): Promise<ResultadoCrearVencimientos> {
  const creados: FiscalDeadlineRecord[] = [];
  const omitidos: TipoVencimiento[] = [];
  for (const n of nuevos) {
    const input = { ...contexto, tipo: n.tipo, periodo: n.periodo, fechaLimite: n.fechaLimite, prioridad: n.prioridad };
    let creado: FiscalDeadlineRecord | null;
    if (TIPOS_VENCIMIENTO_BASE.includes(n.tipo)) {
      creado = await repo.createDeadline(input);
    } else {
      creado = await runWithSavepointFallback<FiscalDeadlineRecord | null>({
        session,
        savepointName: "sp_calcular_vencimiento_tipo_nuevo",
        primary: () => repo.createDeadline(input),
        isRecoverable: esCheckViolation,
        fallback: async () => null,
      });
    }
    if (!creado) {
      omitidos.push(n.tipo);
      continue;
    }
    if (creado.estado !== "completado" && creado.fechaLimite !== n.fechaLimite) {
      creado = (await repo.updateDeadlineFechaLimite(creado.id, n.fechaLimite, n.prioridad)) ?? creado;
    }
    creados.push(creado);
  }
  return { creados, omitidos };
}

/** Inserta el escalamiento, marca el vencimiento 'escalado' y encola el aviso por correo (best-effort: un fallo
 * al notificar nunca revierte el escalamiento ya registrado). Compartido por el escalamiento manual y el barrido. */
export async function registrarEscalamiento(repo: DespachosRepository, deadline: FiscalDeadlineRecord, decision: DecisionEscalamiento, dias: number, opciones: { readonly habiles?: boolean } = {}) {
  const escalation: DeadlineEscalationRecord = await repo.insertEscalation(deadline.id, decision.level, new Date().toISOString(), decision.notes);
  await repo.updateDeadlineEstado(deadline.id, "escalado");
  const organization = await repo.findOrganizationById(deadline.organizationId);
  const notificacion = await tryEnqueueEscalationEmail(repo, deadline, decision, organization?.name ?? "tu despacho", dias, opciones);
  return { escalation, notificacion };
}

export interface ResultadoBarridoVencimientos {
  readonly evaluados: number;
  readonly escalados: readonly { readonly id: string; readonly tipo: TipoVencimiento; readonly periodo: string; readonly nivel: NivelEscalamiento; readonly correosEncolados: number }[];
  readonly yaEscalados: number;
  readonly aunNoToca: number;
  readonly fallidos: readonly { readonly id: string; readonly tipo: TipoVencimiento; readonly periodo: string }[];
}

/** Escala los vencimientos no completados de la property que vencen en 7, 3 o 1 día(s) HÁBIL(ES) (o hoy, o ya vencieron) y que aún no
 * tienen un escalamiento de ese nivel o mayor (idempotente; D-P3-33: antes avisaba por días naturales, solo hoy o mañana). Cada vencimiento corre en su propio SAVEPOINT: uno con
 * datos raros no revierte los ya escalados de la misma transacción. */
export async function barrerEscalamientosVencimientos(
  repo: DespachosRepository,
  session: TenantDbSession,
  propertyId: string,
  hoy: string,
): Promise<ResultadoBarridoVencimientos> {
  const pendientes = (await repo.listDeadlines(propertyId)).filter((d) => d.estado !== "completado");
  const escalados: Array<ResultadoBarridoVencimientos["escalados"][number]> = [];
  const fallidos: Array<ResultadoBarridoVencimientos["fallidos"][number]> = [];
  let yaEscalados = 0;
  let aunNoToca = 0;

  for (const deadline of pendientes) {
    const dias = diasHabilesHasta(hoy, deadline.fechaLimite);
    const decision = decidirEscalamientoHabil(deadline.tipo, deadline.fechaLimite, dias);
    if (decision === null) {
      aunNoToca += 1;
      continue;
    }
    const previos = await repo.listEscalations(deadline.id);
    const mayorPrevio = previos.reduce((max, e) => Math.max(max, RANGO_NIVEL[e.level]), 0);
    if (mayorPrevio >= RANGO_NIVEL[decision.level]) {
      yaEscalados += 1;
      continue;
    }
    try {
      const r = await runWithSavepointFallback<Awaited<ReturnType<typeof registrarEscalamiento>>>({
        session,
        savepointName: "sp_barrido_vencimiento",
        primary: () => registrarEscalamiento(repo, deadline, decision, dias, { habiles: true }),
        isRecoverable: () => true,
        fallback: async (err) => {
          throw err;
        },
      });
      escalados.push({ id: deadline.id, tipo: deadline.tipo, periodo: deadline.periodo, nivel: r.escalation.level, correosEncolados: r.notificacion?.enqueued ?? 0 });
    } catch {
      fallidos.push({ id: deadline.id, tipo: deadline.tipo, periodo: deadline.periodo });
    }
  }

  // Aviso in-app (campana) a los contadores/owner/admin: UNA por property por dia y por clase, con la cantidad
  // de vencimientos recien escalados (nivel_1..nivel_3 = por vencer en 7/3/1 dias habiles; nivel_4 = ya vencieron). Dentro de un
  // SAVEPOINT (emitirNotificacion): contra la base sin migrar no revierte los escalamientos ya registrados.
  // Mismo `organizationId` que el del vencimiento (nunca el del request): el barrido es de UNA property.
  const organizationId = pendientes[0]?.organizationId;
  const porVencer = escalados.filter((e) => e.nivel !== "nivel_4").length;
  const vencidos = escalados.filter((e) => e.nivel === "nivel_4").length;
  if (organizationId && porVencer > 0) {
    await emitirNotificacion(session, { evento: "despachos.fiscal.vencimiento_proximo", organizationId, propertyId, clave: `${propertyId}:${hoy}`, parametros: { cantidad: porVencer } });
  }
  if (organizationId && vencidos > 0) {
    await emitirNotificacion(session, { evento: "despachos.fiscal.vencimiento_vencido", organizationId, propertyId, clave: `${propertyId}:${hoy}`, parametros: { cantidad: vencidos } });
  }
  return { evaluados: pendientes.length, escalados, yaEscalados, aunNoToca, fallidos };
}
