// Ficha de un período de cierre (Fase 9) — el checklist real: GET .../periodos/:id
// (periodo + tareas + estado agregado, cierre-mensual.ts), completar una tarea
// (POST .../tareas/:id/completar — el motor `completarTarea` en
// @atiende/domain-despachos bloquea completar si alguna dependencia sigue sin
// terminar, mismo orden que la plantilla real del despacho) y cerrar el período
// (POST .../cerrar — `CERRAR_PERIODO_ROLES = ["admin"]`: acción irreversible en
// esta fase, sin reapertura implementada, ver roles.ts). El reporte de cierre
// (GET .../reporte) se trae bajo demanda para no pedirlo en cada carga de la
// página.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { cerrarPeriodoCierre, completarTareaCierre, fetchPeriodoDetalle, fetchReporteCierre } from "../lib/cierre-mensual-client.ts";
import type { CloseTask, PeriodoDetalle, ReporteCierre } from "../lib/cierre-mensual-client.ts";
import { formatDate, formatPeriodStatus, formatPeriodo, formatTaskCategory, formatTaskStatus } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);
const CERRAR_ROLES = new Set(["admin"]);

const TASK_STATUS_COLORS: Record<CloseTask["status"], { bg: string; fg: string }> = {
  pending: { bg: "#f3f4f6", fg: "#4b5563" },
  in_progress: { bg: "#dbeafe", fg: "#1e40af" },
  blocked: { bg: "#fee2e2", fg: "#991b1b" },
  done: { bg: "#dcfce7", fg: "#166534" },
  skipped: { bg: "#f3f4f6", fg: "#9ca3af" },
};

function TaskStatusBadge({ status }: { status: CloseTask["status"] }) {
  const colors = TASK_STATUS_COLORS[status];
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, fontWeight: 600 }}>{formatTaskStatus(status)}</span>;
}

export function CierreMensualDetallePage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const { periodoId } = useParams<{ periodoId: string }>();
  const [detalle, setDetalle] = useState<PeriodoDetalle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [cerrando, setCerrando] = useState(false);
  const [reporte, setReporte] = useState<ReporteCierre | null>(null);
  const [cargandoReporte, setCargandoReporte] = useState(false);

  async function load() {
    if (!periodoId) return;
    setLoading(true);
    setError(null);
    try {
      setDetalle(await fetchPeriodoDetalle(fetch, apiBaseUrl, token, propertyId, periodoId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el período de cierre.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, periodoId]);

  async function handleCompletar(taskId: string) {
    if (!periodoId) return;
    setActionError(null);
    setBusyTaskId(taskId);
    try {
      await completarTareaCierre(fetch, apiBaseUrl, token, propertyId, periodoId, taskId);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo completar la tarea.");
    } finally {
      setBusyTaskId(null);
    }
  }

  async function handleCerrar() {
    if (!periodoId) return;
    setActionError(null);
    setCerrando(true);
    try {
      await cerrarPeriodoCierre(fetch, apiBaseUrl, token, propertyId, periodoId);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo cerrar el período.");
    } finally {
      setCerrando(false);
    }
  }

  async function handleVerReporte() {
    if (!periodoId) return;
    setActionError(null);
    setCargandoReporte(true);
    try {
      setReporte(await fetchReporteCierre(fetch, apiBaseUrl, token, propertyId, periodoId));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo generar el reporte.");
    } finally {
      setCargandoReporte(false);
    }
  }

  if (!periodoId) return <p role="alert">Período no especificado.</p>;
  if (loading && !detalle) return <p style={{ color: "#6b7280" }}>Cargando…</p>;
  if (error) return <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>;
  if (!detalle) return null;

  const { periodo, tareas, estado } = detalle;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 900 }}>
      <div>
        <Link to={`/despachos/${orgSlug}/cierre-mensual`} style={{ fontSize: 13, color: "#6b7280", textDecoration: "none" }}>
          ← Cierre mensual
        </Link>
      </div>

      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>{formatPeriodo(periodo.year, periodo.month)}</h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
            {formatPeriodStatus(periodo.status)} · Abierto {formatDate(periodo.openedAt)}
            {periodo.closedAt && ` · Cerrado ${formatDate(periodo.closedAt)}`}
          </p>
        </div>
        {periodo.status !== "closed" && CERRAR_ROLES.has(role) && (
          <button onClick={handleCerrar} disabled={cerrando} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #b91c1c", background: "#fff", color: "#b91c1c", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            {cerrando ? "Cerrando…" : "Cerrar período"}
          </button>
        )}
      </header>

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
          <span>
            Avance: {estado.done + estado.skipped} de {estado.totalTasks} tareas
          </span>
          <strong>{estado.progressPercent}%</strong>
        </div>
        <div style={{ height: 8, borderRadius: 999, background: "#f3f4f6", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${estado.progressPercent}%`, background: periodo.status === "overdue" ? "#dc2626" : "#111827" }} />
        </div>
        {estado.overdue.length > 0 && <p style={{ fontSize: 12, color: "#b91c1c", margin: "8px 0 0" }}>{estado.overdue.length} tarea(s) vencida(s).</p>}
        {estado.blocked.length > 0 && <p style={{ fontSize: 12, color: "#9ca3af", margin: "4px 0 0" }}>{estado.blocked.length} tarea(s) bloqueada(s) por dependencias.</p>}
      </div>

      {actionError && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {actionError}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {tareas.map((t) => {
          const puedeCompletar = GESTIONAR_ROLES.has(role) && t.status !== "done" && t.status !== "skipped" && t.status !== "blocked";
          return (
            <div key={t.id} style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13 }}>{t.title}</strong>
                  <TaskStatusBadge status={t.status} />
                  <span style={{ fontSize: 11, color: "#9ca3af" }}>{formatTaskCategory(t.category)}</span>
                </div>
                <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>{t.description}</p>
                {t.category === "electronica" && (
                  <Link to={`/despachos/${orgSlug}/contabilidad-electronica`} style={{ fontSize: 12, color: "#111827", textDecoration: "underline" }}>
                    Ir a Contabilidad electrónica →
                  </Link>
                )}
                {t.completedAt && <p style={{ fontSize: 11, color: "#9ca3af", margin: "4px 0 0" }}>Completada {formatDate(t.completedAt)}</p>}
              </div>
              {puedeCompletar && (
                <button onClick={() => handleCompletar(t.id)} disabled={busyTaskId === t.id} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 12, flexShrink: 0 }}>
                  {busyTaskId === t.id ? "…" : "Completar"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
        <button onClick={handleVerReporte} disabled={cargandoReporte} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 13 }}>
          {cargandoReporte ? "Generando…" : reporte ? "Actualizar reporte" : "Ver reporte de cierre"}
        </button>
        {reporte && (
          <div style={{ marginTop: 12, fontSize: 13, display: "flex", flexDirection: "column", gap: 6 }}>
            <p style={{ margin: 0 }}>
              {reporte.done} completadas, {reporte.skipped} omitidas, {reporte.pending} pendientes ({reporte.progressPercent}%) · {reporte.estimatedHours.toFixed(1)}h estimadas
            </p>
            {reporte.issues.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, color: "#b91c1c" }}>
                {reporte.issues.map((i) => (
                  <li key={i.taskId}>
                    {i.title} — {i.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
