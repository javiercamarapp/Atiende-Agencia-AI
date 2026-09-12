// ApprovalWorkflow — Fase 2 pieza 1: máquina de aprobaciones granular
// (AE-02/AE-11 del origen). Reemplaza a `expediente-approval.ts` (Fase 1),
// que solo reproducía la invalidación por hash de insumos divergente y
// dejaba explícitamente diferida la máquina de estados completa de
// invalidación por-sección/por-documento con autoría (ver cabecera anterior
// de ese archivo). Puerto ~literal de
// licitaciones/packages/expediente/src/approval-workflow.ts, adaptado a los
// tipos ya existentes de domain-licitaciones (`LicitacionesRole` en vez de
// `WorkflowRole`; `InputsHash`/`HashedInputs` ya viven en sealed-inputs.ts).
//
// Decisión de integración clave (ver diseño Fase 2 §2.1): `PackageAssembler`
// NO cambia. `buildManifest()` solo consume `input.approvals` filtrando por
// `scope === "expediente" && scopeRef === "expediente" && status ===
// "vigente" && inputsHash === currentInputsHash` -- ignora silenciosamente
// cualquier aprobación de scope "seccion"/"documento". La máquina granular es
// una capa de control INTERNA al flujo de revisión; el gate final de "ready"
// sigue siendo exactamente el mismo.
//
// Simplificación deliberada de jerarquía (ver diseño §2.2): a diferencia del
// origen (3 niveles: expediente -> documento:<id> -> seccion:<doc>:<id>),
// domain-licitaciones modela un árbol de 2 niveles: "expediente" ->
// "seccion:<section_key>", usando `proposal_section.section_key` (ya
// existente en Fase 1) como unidad atómica real. El tipo `ApprovalScope`
// conserva el valor "documento" (y el CHECK de la migración 004 lo permite)
// para no cerrar la puerta a una fase futura que sí modele documentos
// compuestos de varias secciones, pero ningún flujo de Fase 2 construye una
// aprobación de ese scope todavía.
import { DECISION_ROLES } from "./roles.ts";
import type { LicitacionesRole } from "./roles.ts";
import { isoNow } from "./types.ts";
import { requireValidHashedInputs, type HashedInputs, type InputsHash } from "./sealed-inputs.ts";
import { ApprovalRejectedError } from "./errors.ts";

export type ApprovalScope = "seccion" | "documento" | "expediente";

/**
 * Roles que pueden aprobar -- EXACTAMENTE `DECISION_ROLES` de roles.ts
 * (owner/admin/analyst), nunca un conjunto propio inventado aquí. El origen
 * usa `["reviewer", "admin", "owner"]` porque su enum de roles no tiene
 * "analyst"; domain-licitaciones SÍ lo tiene (ver roles.ts) y ya estableció
 * en Fase 1 que aprobar el expediente exige `DECISION_ROLES`
 * (`cierre.ts::assertVerticalRole(c, DECISION_ROLES)`, aplicado ANTES de
 * llegar aquí). Si esta constante divergiera de `DECISION_ROLES`, un actor
 * que la ruta ya autorizó (p. ej. "analyst") sería rechazado igual por esta
 * máquina interna -- exactamente el bug que produjo esta nota.
 */
export const APPROVER_ROLES: ReadonlySet<LicitacionesRole> = new Set(DECISION_ROLES);
/** Roles que pueden enviar a revisión (deben haber escrito o ser dueños del expediente) -- WRITE_ROLES sin "reviewer" (revisar no es lo mismo que someter a revisión). */
export const SUBMITTER_ROLES: ReadonlySet<LicitacionesRole> = new Set(["owner", "admin", "analyst", "writer"]);

export interface Approval {
  readonly id: string;
  readonly scope: ApprovalScope;
  /** Ruta jerárquica del alcance: "expediente" o "seccion:<section_key>". */
  readonly scopeRef: string;
  readonly approvedBy: string;
  readonly approvedByRole: LicitacionesRole;
  readonly approvedAt: string;
  /** Hash de insumos BRANDED (EX-EXP-17, ya portado en Fase 1): solo se almacena el `InputsHash`, nunca el `ExpedienteInputs` completo. */
  readonly inputsHash: InputsHash;
  readonly status: "vigente" | "invalidada";
  readonly invalidatedAt?: string;
  readonly invalidatedReason?: string;
}

export interface ChangeDetected {
  readonly id: string;
  readonly scope: ApprovalScope;
  readonly scopeRef: string;
  readonly reason: string;
  readonly detectedAt: string;
  readonly invalidatedApprovalIds: readonly string[];
}

let approvalCounter = 0;
let changeCounter = 0;

/**
 * Alcances jerárquicos SIMPLIFICADOS a 2 niveles (ver cabecera del módulo):
 * "expediente" es la raíz y cubre todo; cualquier otro `scopeRef` (p. ej.
 * "seccion:economic:carta") es una hoja cuyo único ancestro es "expediente".
 * Devuelve, de más general a más específico, todos los `scopeRef` de
 * aprobación que cubrirían a `scopeRef`.
 */
function ancestorsOf(scopeRef: string): string[] {
  if (scopeRef === "expediente") return ["expediente"];
  return ["expediente", scopeRef];
}

/** `true` si una aprobación con alcance `approvalScopeRef` cubre el alcance `targetScopeRef` (mismo alcance, o "expediente" cubriendo cualquier sección). */
function isAncestorOrSame(approvalScopeRef: string, targetScopeRef: string): boolean {
  return ancestorsOf(targetScopeRef).includes(approvalScopeRef);
}

export interface ApprovalWorkflowSnapshot {
  readonly approvals?: readonly Approval[];
  /** `scopeRef` -> conjunto de `actorId` que han redactado/editado contenido de ese alcance (AE-11). */
  readonly sectionAuthors?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Máquina de aprobaciones granular. Instanciable de dos formas:
 *  - "en vivo", acumulando estado a través de varias llamadas dentro del
 *    mismo proceso (igual que el origen, útil en tests que ejercitan una
 *    secuencia completa requestReview -> recordEdit -> approve).
 *  - "hidratada" desde el estado ya persistido en Postgres
 *    (`PostgresLicitacionesRepository` reconstruye una instancia con las
 *    `approvals`/`sectionAuthors` actuales de la propuesta antes de cada
 *    operación, y persiste solo el resultado) -- ver `repository.ts::approve`/
 *    `recordChange`/`activeApprovalsCovering`.
 */
export class ApprovalWorkflow {
  private readonly submitters = new Map<string, string>(); // scopeRef -> actorId que envió a revisión
  private readonly approvals: Approval[];
  private readonly changes: ChangeDetected[] = [];
  /**
   * AE-11: `scopeRef` -> conjunto de `actorId` que han redactado/editado
   * contenido de ese alcance. A diferencia del origen (donde `recordEdit` es
   * una llamada manual opcional), en domain-licitaciones esta autoría se
   * alimenta OBLIGATORIA y AUTOMÁTICAMENTE desde el adaptador de repositorio
   * cada vez que se persiste contenido de una sección (ver diseño §2.3) --
   * nunca depende de que una ruta Hono se acuerde de invocarla.
   */
  private readonly sectionAuthors = new Map<string, Set<string>>();

  constructor(snapshot: ApprovalWorkflowSnapshot = {}) {
    this.approvals = snapshot.approvals ? [...snapshot.approvals] : [];
    if (snapshot.sectionAuthors) {
      for (const [scopeRef, authors] of snapshot.sectionAuthors) {
        this.sectionAuthors.set(scopeRef, new Set(authors));
      }
    }
  }

  /** Registra que `actorId` redactó/editó contenido del alcance `scopeRef` (AE-11). */
  recordEdit(input: { scopeRef: string; actorId: string }): void {
    const authors = this.sectionAuthors.get(input.scopeRef) ?? new Set<string>();
    authors.add(input.actorId);
    this.sectionAuthors.set(input.scopeRef, authors);
  }

  /** Autores de contenido registrados exactamente para `scopeRef` (sin resolver jerarquía). Solo lectura/depuración. */
  authorsOf(scopeRef: string): string[] {
    return [...(this.sectionAuthors.get(scopeRef) ?? [])];
  }

  /**
   * Unión de todos los `actorId` autores de contenido de cualquier
   * `scopeRef` registrado que `approvalScopeRef` cubra (el propio alcance, o
   * -- si `approvalScopeRef` es "expediente" -- cualquier sección).
   */
  private authorsCoveredBy(approvalScopeRef: string): Set<string> {
    const covered = new Set<string>();
    for (const [recordedScopeRef, authors] of this.sectionAuthors) {
      if (isAncestorOrSame(approvalScopeRef, recordedScopeRef)) {
        for (const actorId of authors) covered.add(actorId);
      }
    }
    return covered;
  }

  requestReview(input: { scopeRef: string; actorId: string; actorRole: LicitacionesRole }): void {
    if (!SUBMITTER_ROLES.has(input.actorRole)) {
      throw new ApprovalRejectedError("rol_no_autorizado_para_enviar_a_revision", `Rol "${input.actorRole}" no puede enviar "${input.scopeRef}" a revisión.`);
    }
    this.submitters.set(input.scopeRef, input.actorId);
  }

  /**
   * Aprueba un alcance (sección/expediente). Reglas duras (en este orden):
   *  1. Solo roles reviewer/admin/owner pueden aprobar; writer/viewer se
   *     rechazan siempre (nunca hay excepción por conveniencia).
   *  2. `inputsHash` debe ser un `HashedInputs` sellado por
   *     sealInputs()/computeInputsHash() (EX-EXP-17, ya portado Fase 1) --
   *     fail-closed ante un hash calculado a mano.
   *  3. AE-02: `scope === "expediente"` exige `scopeRef === "expediente"`
   *     exacto -- defensa contra un `scope`/`scopeRef` inconsistentes que
   *     contarían como aprobación total de un expediente distinto.
   *  4. Autoaprobación prohibida: quien envió ese alcance a revisión no
   *     puede aprobarlo.
   *  5. AE-11: se rechaza si el propio aprobador consta como autor de
   *     contenido de CUALQUIER alcance cubierto por `scopeRef` (el mismo
   *     alcance, o cualquier sección si se aprueba "expediente") -- sin
   *     esto, quien redacta una sección podría aprobar igual todo el
   *     expediente con solo que otra persona hubiera pedido la revisión.
   */
  approve(input: { scope: ApprovalScope; scopeRef: string; actorId: string; actorRole: LicitacionesRole; inputsHash: HashedInputs }): Approval {
    if (!APPROVER_ROLES.has(input.actorRole)) {
      throw new ApprovalRejectedError("rol_no_autorizado_para_aprobar", `Rol "${input.actorRole}" no puede aprobar "${input.scopeRef}".`);
    }
    const { hash: verifiedInputsHash } = requireValidHashedInputs(input.inputsHash, "Approval.inputsHash (ApprovalWorkflow.approve())");

    if (input.scope === "expediente" && input.scopeRef !== "expediente") {
      throw new ApprovalRejectedError(
        "scope_scopeRef_inconsistente",
        `scope="expediente" exige scopeRef="expediente", se recibió scopeRef="${input.scopeRef}".`,
      );
    }

    const submitter = this.submitters.get(input.scopeRef);
    if (submitter !== undefined && submitter === input.actorId) {
      throw new ApprovalRejectedError("autoaprobacion_prohibida_mismo_actor_que_envio_a_revision", `El actor "${input.actorId}" no puede aprobar "${input.scopeRef}": fue quien lo envió a revisión.`);
    }

    if (this.authorsCoveredBy(input.scopeRef).has(input.actorId)) {
      throw new ApprovalRejectedError(
        "autoaprobacion_prohibida_actor_autor_de_contenido_en_alcance_cubierto",
        `El actor "${input.actorId}" no puede aprobar "${input.scopeRef}": consta como autor de contenido de una sección cubierta por ese alcance (AE-11).`,
      );
    }

    const approval: Approval = {
      id: `approval-${++approvalCounter}`,
      scope: input.scope,
      scopeRef: input.scopeRef,
      approvedBy: input.actorId,
      approvedByRole: input.actorRole,
      approvedAt: isoNow(),
      inputsHash: verifiedInputsHash,
      status: "vigente",
    };
    this.approvals.push(approval);
    return approval;
  }

  listApprovals(): Approval[] {
    return [...this.approvals];
  }

  /** Aprobaciones vigentes que cubren `scopeRef` (aprobación exacta, o "expediente" cubriendo cualquier sección). */
  activeApprovalsCovering(scopeRef: string): Approval[] {
    return this.approvals.filter((a) => a.status === "vigente" && isAncestorOrSame(a.scopeRef, scopeRef));
  }

  isFullyApproved(): boolean {
    return this.activeApprovalsCovering("expediente").length > 0;
  }

  /**
   * Registra un cambio detectado en un insumo ya aprobado e invalida
   * automáticamente cualquier aprobación vigente cuyo alcance incluya
   * `scopeRef` (la aprobación exacta, o "expediente" si el cambio es de
   * alcance "expediente" -- un cambio en una sección invalida SOLO las
   * aprobaciones de esa sección y de "expediente", nunca las de una sección
   * hermana).
   */
  recordChange(input: { scope: ApprovalScope; scopeRef: string; reason: string }): ChangeDetected {
    const affected = this.approvals.filter((a) => a.status === "vigente" && isAncestorOrSame(a.scopeRef, input.scopeRef));
    const timestamp = isoNow();
    const affectedIds = new Set(affected.map((a) => a.id));
    for (let i = 0; i < this.approvals.length; i++) {
      const a = this.approvals[i]!;
      if (affectedIds.has(a.id)) {
        this.approvals[i] = { ...a, status: "invalidada", invalidatedAt: timestamp, invalidatedReason: input.reason };
      }
    }
    const change: ChangeDetected = {
      id: `change-${++changeCounter}`,
      scope: input.scope,
      scopeRef: input.scopeRef,
      reason: input.reason,
      detectedAt: timestamp,
      invalidatedApprovalIds: affected.map((a) => a.id),
    };
    this.changes.push(change);
    return change;
  }

  listChanges(): ChangeDetected[] {
    return [...this.changes];
  }

  /**
   * Revalida si la aprobación vigente de `scopeRef` sigue reflejando los
   * insumos actuales: compara su `inputsHash` registrado contra
   * `currentInputsHash`. Si difiere, invalida automáticamente esa
   * aprobación llamando a `recordChange` internamente.
   */
  revalidateAgainstCurrentHash(input: { scopeRef: string; currentInputsHash: HashedInputs; reason?: string }): ChangeDetected | null {
    const { hash: currentHash } = requireValidHashedInputs(input.currentInputsHash, "revalidateAgainstCurrentHash(currentInputsHash)");
    const stale = this.approvals.filter((a) => a.status === "vigente" && a.scopeRef === input.scopeRef && a.inputsHash !== currentHash);
    if (stale.length === 0) return null;
    return this.recordChange({
      scope: stale[0]!.scope,
      scopeRef: input.scopeRef,
      reason: input.reason ?? `hash_insumos_divergente:aprobado=${stale[0]!.inputsHash}:actual=${currentHash}`,
    });
  }

  /** Combina `revalidateAgainstCurrentHash` (alcance "expediente") con `isFullyApproved()` en una sola llamada. */
  isFullyApprovedForCurrentHash(currentInputsHash: HashedInputs): boolean {
    this.revalidateAgainstCurrentHash({ scopeRef: "expediente", currentInputsHash });
    return this.isFullyApproved();
  }
}

/**
 * Replica literal de la regla de `PackageAssembler.buildManifest` (ver
 * diseño §2.1: `PackageAssembler` no cambia, esta función es solo un
 * atajo de conveniencia para que apps/api pueda decidir el mismo veredicto
 * sin duplicar la lógica). Devuelve `null` si ninguna aprobación cumple las
 * cuatro condiciones a la vez.
 */
export function evaluateExpedienteApproval(approvals: readonly Approval[], currentInputsHash: InputsHash): Approval | null {
  return approvals.find((a) => a.scope === "expediente" && a.scopeRef === "expediente" && a.status === "vigente" && a.inputsHash === currentInputsHash) ?? null;
}

/** Utilidad de solo pruebas: resetea contadores globales para IDs deterministas entre tests. */
export function resetApprovalCounters(): void {
  approvalCounter = 0;
  changeCounter = 0;
}
