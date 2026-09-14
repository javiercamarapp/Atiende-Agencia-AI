// Agenda del panel de citas (Fase 5/7) — vista mes/semana de citas REALES (GET
// /v1/citas/properties/:propertyId/appointments, Fase 5 — admin.ts), agrupadas por
// día. Fase 5 solo ofrecía cancelar (appointments-lifecycle.ts); Fase 7 agrega
// confirmar/completar/marcar no-show — mismo patrón de botón condicionado por
// estado. El panel sigue sin reagendar ni reasignar hoy (esas dos solo las
// ejecuta el agente, ver ese mismo archivo) y sigue sin tiempo real: la agenda se
// vuelve a pedir tras cada acción de escritura (`load()`), nunca vía suscripción
// (gap conocido y documentado, ver resumen de la fase — Supabase Realtime del
// origen no se portó).
import { useEffect, useMemo, useState } from "react";
import { cancelAppointment, completeAppointment, confirmAppointment, fetchAppointments, markAppointmentNoShow } from "../lib/appointments-client.ts";
import type { AppointmentSummary } from "../lib/appointments-client.ts";
import { fetchProviders } from "../lib/providers-client.ts";
import type { ProviderSummary } from "../lib/providers-client.ts";
import { formatAppointmentSource, formatAppointmentStatus, formatDateLong, formatTimeRange } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

type ViewMode = "month" | "week";

function startOfWeek(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = domingo
  const diff = day === 0 ? -6 : 1 - day; // semana empieza en lunes
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function computeRange(anchor: Date, view: ViewMode): { fromIso: string; toIso: string; label: string } {
  if (view === "week") {
    const from = startOfWeek(anchor);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 7);
    return { fromIso: from.toISOString(), toIso: to.toISOString(), label: `Semana del ${formatDateLong(from.toISOString())}` };
  }
  const from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const to = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  const label = new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric" }).format(from);
  return { fromIso: from.toISOString(), toIso: to.toISOString(), label };
}

function shiftAnchor(anchor: Date, view: ViewMode, direction: 1 | -1): Date {
  const d = new Date(anchor);
  if (view === "week") d.setUTCDate(d.getUTCDate() + 7 * direction);
  else d.setUTCMonth(d.getUTCMonth() + direction);
  return d;
}

function groupByDay(appointments: readonly AppointmentSummary[]): ReadonlyArray<[string, AppointmentSummary[]]> {
  const groups = new Map<string, AppointmentSummary[]>();
  for (const apt of appointments) {
    const dayKey = apt.startsAt.slice(0, 10);
    const list = groups.get(dayKey) ?? [];
    list.push(apt);
    groups.set(dayKey, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const CANCELABLE_STATUSES = new Set(["pending", "confirmed"]);
// Fase 7 — mismos 2 estados "vivos" que ya usa CANCELABLE_STATUSES/
// LIFECYCLE_EDITABLE_STATUSES de domain-citas/appointments.ts: solo una cita
// pending/confirmed admite estas 3 transiciones nuevas.
const CONFIRMABLE_STATUSES = new Set(["pending"]);
const COMPLETABLE_STATUSES = new Set(["pending", "confirmed"]);
const NO_SHOW_STATUSES = new Set(["pending", "confirmed"]);

type LifecycleAction = "cancel" | "confirm" | "complete" | "no_show";

export function AgendaPage({ apiBaseUrl, token, propertyId }: CitasShellContext) {
  const [view, setView] = useState<ViewMode>("month");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
  const [providerFilter, setProviderFilter] = useState<string>("");
  const [appointments, setAppointments] = useState<readonly AppointmentSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Una sola acción de ciclo de vida en vuelo a la vez, por cita — mismo criterio
  // que el `cancellingId` original, generalizado a las 4 acciones del panel.
  const [pendingAction, setPendingAction] = useState<{ id: string; action: LifecycleAction } | null>(null);

  const range = useMemo(() => computeRange(anchor, view), [anchor, view]);

  useEffect(() => {
    fetchProviders(fetch, apiBaseUrl, token, propertyId)
      .then(setProviders)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudieron cargar los proveedores."));
  }, [apiBaseUrl, token, propertyId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAppointments(fetch, apiBaseUrl, token, propertyId, { fromIso: range.fromIso, toIso: range.toIso, providerId: providerFilter || undefined });
      setAppointments(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las citas.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // `load` se recrea cada render (depende de `providerFilter`, ya en el arreglo
    // de dependencias) — mismo criterio que Dashboard.tsx de restaurantes: este
    // proyecto no tiene configurado eslint-plugin-react-hooks, así que no hace
    // falta silenciar nada.
    void load();
  }, [apiBaseUrl, token, propertyId, range.fromIso, range.toIso, providerFilter]);

  async function runLifecycleAction(appointmentId: string, action: LifecycleAction, confirmMessage: string | null, run: () => Promise<AppointmentSummary>, errorFallback: string) {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setPendingAction({ id: appointmentId, action });
    setError(null);
    try {
      await run();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : errorFallback);
    } finally {
      setPendingAction(null);
    }
  }

  async function handleCancel(appointmentId: string) {
    await runLifecycleAction(appointmentId, "cancel", "¿Cancelar esta cita? Esta acción no se puede deshacer.", () => cancelAppointment(fetch, apiBaseUrl, token, propertyId, appointmentId), "No se pudo cancelar la cita.");
  }

  async function handleConfirm(appointmentId: string) {
    await runLifecycleAction(appointmentId, "confirm", null, () => confirmAppointment(fetch, apiBaseUrl, token, propertyId, appointmentId), "No se pudo confirmar la cita.");
  }

  async function handleComplete(appointmentId: string) {
    await runLifecycleAction(appointmentId, "complete", null, () => completeAppointment(fetch, apiBaseUrl, token, propertyId, appointmentId), "No se pudo marcar la cita como completada.");
  }

  async function handleNoShow(appointmentId: string) {
    await runLifecycleAction(
      appointmentId,
      "no_show",
      "¿Marcar esta cita como no-show? El cliente no se presentó y el horario del proveedor queda libre de inmediato.",
      () => markAppointmentNoShow(fetch, apiBaseUrl, token, propertyId, appointmentId),
      "No se pudo marcar la cita como no-show.",
    );
  }

  const groups = appointments ? groupByDay(appointments) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Agenda</h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0", textTransform: "capitalize" }}>{range.label}</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db" }}>
            <option value="">Todos los proveedores</option>
            {providers?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
          <div style={{ display: "flex", border: "1px solid #d1d5db", borderRadius: 999, overflow: "hidden" }}>
            {(["month", "week"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{ padding: "6px 12px", border: "none", background: view === v ? "#111827" : "#fff", color: view === v ? "#fff" : "#111827", fontSize: 12, cursor: "pointer" }}
              >
                {v === "month" ? "Mes" : "Semana"}
              </button>
            ))}
          </div>
          <button onClick={() => setAnchor((a) => shiftAnchor(a, view, -1))} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
            ← Anterior
          </button>
          <button onClick={() => setAnchor(new Date())} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
            Hoy
          </button>
          <button onClick={() => setAnchor((a) => shiftAnchor(a, view, 1))} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
            Siguiente →
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      {loading && !appointments && <p style={{ color: "#6b7280" }}>Cargando…</p>}

      {appointments && appointments.length === 0 && !loading && <p style={{ color: "#6b7280" }}>No hay citas en este rango.</p>}

      {groups.map(([day, dayAppointments]) => (
        <section key={day} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 13, fontWeight: 600, textTransform: "capitalize", margin: 0, borderBottom: "1px solid #e5e7eb", paddingBottom: 4 }}>{formatDateLong(dayAppointments[0]!.startsAt)}</p>
          {dayAppointments.map((apt) => (
            <article key={apt.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, flexWrap: "wrap" }}>
              <div>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>
                  {formatTimeRange(apt.startsAt, apt.endsAt)} — {apt.serviceName ?? "Servicio desconocido"}
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 13, color: "#374151" }}>
                  {apt.customerName ?? "Cliente desconocido"} {apt.customerPhone ? `· ${apt.customerPhone}` : ""}
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
                  {apt.providerName ?? "Proveedor desconocido"} · {formatAppointmentSource(apt.source)}
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontSize: 11,
                    padding: "3px 8px",
                    borderRadius: 999,
                    background: apt.status === "cancelled" ? "#fee2e2" : apt.status === "completed" ? "#dcfce7" : apt.status === "no_show" ? "#ffedd5" : "#e0e7ff",
                    color: apt.status === "cancelled" ? "#991b1b" : apt.status === "completed" ? "#166534" : apt.status === "no_show" ? "#9a3412" : "#3730a3",
                  }}
                >
                  {formatAppointmentStatus(apt.status)}
                </span>
                {CONFIRMABLE_STATUSES.has(apt.status) && (
                  <button
                    onClick={() => void handleConfirm(apt.id)}
                    disabled={pendingAction !== null && pendingAction.id === apt.id}
                    style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #a5b4fc", background: "#fff", color: "#3730a3", fontSize: 12, cursor: "pointer" }}
                  >
                    {pendingAction?.id === apt.id && pendingAction.action === "confirm" ? "Confirmando…" : "Confirmar"}
                  </button>
                )}
                {COMPLETABLE_STATUSES.has(apt.status) && (
                  <button
                    onClick={() => void handleComplete(apt.id)}
                    disabled={pendingAction !== null && pendingAction.id === apt.id}
                    style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #86efac", background: "#fff", color: "#166534", fontSize: 12, cursor: "pointer" }}
                  >
                    {pendingAction?.id === apt.id && pendingAction.action === "complete" ? "Completando…" : "Completar"}
                  </button>
                )}
                {NO_SHOW_STATUSES.has(apt.status) && (
                  <button
                    onClick={() => void handleNoShow(apt.id)}
                    disabled={pendingAction !== null && pendingAction.id === apt.id}
                    style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #fdba74", background: "#fff", color: "#9a3412", fontSize: 12, cursor: "pointer" }}
                  >
                    {pendingAction?.id === apt.id && pendingAction.action === "no_show" ? "Marcando…" : "No-show"}
                  </button>
                )}
                {CANCELABLE_STATUSES.has(apt.status) && (
                  <button
                    onClick={() => void handleCancel(apt.id)}
                    disabled={pendingAction !== null && pendingAction.id === apt.id}
                    style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #fca5a5", background: "#fff", color: "#b91c1c", fontSize: 12, cursor: "pointer" }}
                  >
                    {pendingAction?.id === apt.id && pendingAction.action === "cancel" ? "Cancelando…" : "Cancelar"}
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
