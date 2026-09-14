// Tipos del cierre mensual — puerto de
// `b2b_ai/features/monthly_close/models.py` (checklist/estado del período,
// elegido sobre `close_management` como referencia del motor de checklist —
// ver informe de auditoría de esta fase: `monthly_close` tiene mejor
// higiene de tenancy/RBAC y NO tiene estados muertos declarados-pero-
// nunca-usados como `close_management.ClosePeriodStatus.REVIEW/APPROVED`).
// Las validaciones de balance numérico (`validaciones.ts`) SÍ vienen de
// `close_management/validation_engine.py`, que es la única de las dos
// referencias que las implementa.
export type ClosePeriodStatus = "open" | "closed" | "overdue";

export type TaskStatus = "pending" | "in_progress" | "blocked" | "done" | "skipped";

export type TaskCategory = "cfdi" | "bank" | "nomina" | "declaracion" | "electronica" | "custom";

export interface CloseTask {
  readonly id: string;
  readonly periodId: string;
  readonly title: string;
  readonly description: string;
  readonly category: TaskCategory;
  readonly status: TaskStatus;
  readonly dependsOn: readonly string[];
  readonly dueDate: string | null;
  readonly autoCheckQuery: string | null;
  readonly required: boolean;
  readonly completedAt: string | null;
  readonly completedBy: string | null;
}

export interface ClosePeriod {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly year: number;
  readonly month: number;
  readonly status: ClosePeriodStatus;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
}

export interface CloseTemplateTask {
  readonly key?: string;
  readonly title: string;
  readonly description: string;
  readonly category: TaskCategory;
  readonly dependsOn: readonly string[];
  readonly autoCheckQuery: string | null;
  readonly required: boolean;
  readonly dueOffsetDays?: number | null;
}

export interface CloseTemplate {
  readonly name: string;
  readonly description: string;
  readonly tasks: readonly CloseTemplateTask[];
}
