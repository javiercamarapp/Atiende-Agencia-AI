// Fixtures de despachos contables (Despacho Medina y Asociados). Forma = apps/web/src/verticals/despachos/lib/*-client.ts.
import { fallo } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("despachos");
const ORG = orgDe("despachos");
const D = "/despachos/:id";

interface Periodo {
  id: string;
  organizationId: string;
  propertyId: string;
  year: number;
  month: number;
  status: "open" | "closed" | "overdue";
  openedAt: string;
  closedAt: string | null;
  closedBy: string | null;
}

interface Tarea {
  id: string;
  periodId: string;
  title: string;
  description: string;
  category: string;
  status: string;
  dependsOn: string[];
  dueDate: string | null;
  autoCheckQuery: string | null;
  required: boolean;
  completedAt: string | null;
  completedBy: string | null;
}

function periodosSemilla(): Periodo[] {
  return [{ id: "per-2026-09", organizationId: ORG.id, propertyId: PROP.id, year: 2026, month: 9, status: "open", openedAt: "2026-09-01T15:00:00.000Z", closedAt: null, closedBy: null }];
}

function tareasSemilla(): Tarea[] {
  const t = (id: string, title: string, category: string, status: string): Tarea => ({ id, periodId: "per-2026-09", title, description: `${title} del periodo`, category, status, dependsOn: [], dueDate: "2026-10-10", autoCheckQuery: null, required: true, completedAt: status === "done" ? "2026-09-28T15:00:00.000Z" : null, completedBy: null });
  return [t("tar-1", "Conciliar bancos de septiembre", "bank", "done"), t("tar-2", "Presentar declaracion mensual de IVA", "declaracion", "pending")];
}

function estadoDe(tareas: Tarea[]) {
  const done = tareas.filter((t) => t.status === "done").length;
  return { totalTasks: tareas.length, done, skipped: 0, pending: tareas.length - done, inProgress: 0, progressPercent: Math.round((done / tareas.length) * 100), blocked: [], overdue: [] };
}

export const rutasDespachos: readonly Ruta[] = [
  { metodo: "GET", patron: "/v1/despachos/:org/admin/branches", manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre }] }) },
  { metodo: "GET", patron: `${D}/cierre-mensual/periodos`, manejador: (p) => ({ periodos: p.estado.obtener("desp.periodos", periodosSemilla) }) },
  { metodo: "GET", patron: `${D}/cierre-mensual/periodos/:pid`, manejador: (p) => {
      const periodo = p.estado.obtener("desp.periodos", periodosSemilla).find((x) => x.id === p.params.pid);
      if (!periodo) return fallo(404, "Ese periodo no existe");
      const tareas = p.estado.obtener("desp.tareas", tareasSemilla);
      return { periodo, tareas, estado: estadoDe(tareas) };
    } },
  { metodo: "POST", patron: `${D}/cierre-mensual/periodos/:pid/cerrar`, roles: ["admin"], manejador: (p) => {
      const periodo = p.estado.obtener("desp.periodos", periodosSemilla).find((x) => x.id === p.params.pid);
      if (!periodo) return fallo(404, "Ese periodo no existe");
      const esperado = `${periodo.year}-${String(periodo.month).padStart(2, "0")}`;
      // El servidor real exige el mismo texto que la UI: aqui tambien, para que la prueba no pueda "saltarse" el candado.
      if (((p.cuerpo ?? {}) as { confirmacion?: string }).confirmacion !== esperado) return fallo(400, `Escribe exactamente ${esperado}`);
      periodo.status = "closed";
      periodo.closedAt = "2026-10-01T15:00:00.000Z";
      return periodo;
    } },
];

export const despachos = { orgSlug: ORG.slug, propertyId: PROP.id, periodoId: "per-2026-09" };
