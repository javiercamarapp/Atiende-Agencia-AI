// Disponibilidad del panel de citas (Fase 5, solo lectura) — Fase 10 cierra el gap
// real más grave de esta vertical: sin poder crear/editar `citas.availability_rules`
// desde el panel, un negocio nuevo no podía recibir ni una cita (el motor de
// disponibilidad, availability.ts, nunca encontraba reglas de dónde calcular slots).
// Reusa providers-client.ts (createAvailabilityRule/updateAvailabilityRule/
// deleteAvailabilityRule/fetchAvailabilityOverrides/upsertAvailabilityOverride/
// deleteAvailabilityOverride, ver admin.ts::POST/PATCH/DELETE
// .../availability-rules[/:ruleId] y .../availability-overrides[/:date]).
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  createAvailabilityRule,
  deleteAvailabilityOverride,
  deleteAvailabilityRule,
  fetchAvailabilityOverrides,
  fetchProviderDetail,
  fetchProviders,
  updateAvailabilityRule,
  upsertAvailabilityOverride,
} from "../lib/providers-client.ts";
import type { AvailabilityOverrideSummary, AvailabilityRuleSummary, ProviderDetail, ProviderSummary } from "../lib/providers-client.ts";
import { formatDayOfWeek, formatHHMM } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const inputStyle = { padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 };
const primaryButtonStyle = { padding: "6px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" };
const secondaryButtonStyle = { padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, cursor: "pointer" };
const dangerButtonStyle = { padding: "4px 10px", borderRadius: 8, border: "1px solid #fecaca", background: "#fff", color: "#b91c1c", fontSize: 12, cursor: "pointer" };

const DAY_OPTIONS = Array.from({ length: 7 }, (_, i) => i);

/** "09:00" o "09:00:00" -> "09:00" para un <input type="time">, que solo acepta
 * "HH:MM" (nunca segundos) — mismo recorte que `formatHHMM` de format.ts, aquí
 * como valor controlado en vez de texto mostrado. */
function toTimeInputValue(time: string): string {
  return time.slice(0, 5);
}

export function DisponibilidadPage({ apiBaseUrl, token, propertyId }: CitasShellContext) {
  const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [detail, setDetail] = useState<ProviderDetail | null>(null);
  const [overrides, setOverrides] = useState<readonly AvailabilityOverrideSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- alta de regla nueva ----
  const [newDayOfWeek, setNewDayOfWeek] = useState(1);
  const [newStartTime, setNewStartTime] = useState("09:00");
  const [newEndTime, setNewEndTime] = useState("18:00");
  const [creatingRule, setCreatingRule] = useState(false);

  // ---- edición inline de una regla existente ----
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editStartTime, setEditStartTime] = useState("");
  const [editEndTime, setEditEndTime] = useState("");
  const [editIsActive, setEditIsActive] = useState(true);
  const [savingRule, setSavingRule] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);

  // ---- alta/edición de una excepción puntual ----
  const [newOverrideDate, setNewOverrideDate] = useState("");
  const [newOverrideClosed, setNewOverrideClosed] = useState(true);
  const [newOverrideStart, setNewOverrideStart] = useState("09:00");
  const [newOverrideEnd, setNewOverrideEnd] = useState("14:00");
  const [newOverrideReason, setNewOverrideReason] = useState("");
  const [savingOverride, setSavingOverride] = useState(false);
  const [deletingOverrideDate, setDeletingOverrideDate] = useState<string | null>(null);

  function loadDetail() {
    if (!selectedProviderId) return;
    fetchProviderDetail(fetch, apiBaseUrl, token, propertyId, selectedProviderId)
      .then(setDetail)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudo cargar la disponibilidad."));
  }

  function loadOverrides() {
    if (!selectedProviderId) return;
    fetchAvailabilityOverrides(fetch, apiBaseUrl, token, propertyId, selectedProviderId)
      .then(setOverrides)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudieron cargar las excepciones."));
  }

  useEffect(() => {
    fetchProviders(fetch, apiBaseUrl, token, propertyId)
      .then((list) => {
        setProviders(list);
        if (list.length > 0) setSelectedProviderId(list[0]!.id);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudieron cargar los proveedores."));
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    if (!selectedProviderId) return;
    let cancelado = false;
    setDetail(null);
    setOverrides(null);
    setEditingRuleId(null);
    fetchProviderDetail(fetch, apiBaseUrl, token, propertyId, selectedProviderId)
      .then((d) => !cancelado && setDetail(d))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudo cargar la disponibilidad."));
    fetchAvailabilityOverrides(fetch, apiBaseUrl, token, propertyId, selectedProviderId)
      .then((list) => !cancelado && setOverrides(list))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudieron cargar las excepciones."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, selectedProviderId]);

  async function handleCreateRule(e: FormEvent) {
    e.preventDefault();
    if (!selectedProviderId) return;
    setCreatingRule(true);
    setError(null);
    try {
      await createAvailabilityRule(fetch, apiBaseUrl, token, propertyId, selectedProviderId, { dayOfWeek: newDayOfWeek, startTime: newStartTime, endTime: newEndTime });
      loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el horario.");
    } finally {
      setCreatingRule(false);
    }
  }

  function startEditingRule(rule: AvailabilityRuleSummary) {
    setEditingRuleId(rule.id);
    setEditStartTime(toTimeInputValue(rule.startTime));
    setEditEndTime(toTimeInputValue(rule.endTime));
    setEditIsActive(rule.isActive);
  }

  async function handleSaveRule(e: FormEvent) {
    e.preventDefault();
    if (!selectedProviderId || !editingRuleId) return;
    setSavingRule(true);
    setError(null);
    try {
      await updateAvailabilityRule(fetch, apiBaseUrl, token, propertyId, selectedProviderId, editingRuleId, { startTime: editStartTime, endTime: editEndTime, isActive: editIsActive });
      setEditingRuleId(null);
      loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el horario.");
    } finally {
      setSavingRule(false);
    }
  }

  async function handleDeleteRule(ruleId: string) {
    if (!selectedProviderId) return;
    setDeletingRuleId(ruleId);
    setError(null);
    try {
      await deleteAvailabilityRule(fetch, apiBaseUrl, token, propertyId, selectedProviderId, ruleId);
      loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo quitar el horario.");
    } finally {
      setDeletingRuleId(null);
    }
  }

  async function handleSaveOverride(e: FormEvent) {
    e.preventDefault();
    if (!selectedProviderId || !newOverrideDate) return;
    setSavingOverride(true);
    setError(null);
    try {
      await upsertAvailabilityOverride(fetch, apiBaseUrl, token, propertyId, selectedProviderId, newOverrideDate, {
        isClosed: newOverrideClosed,
        startTime: newOverrideClosed ? null : newOverrideStart,
        endTime: newOverrideClosed ? null : newOverrideEnd,
        reason: newOverrideReason.trim() || null,
      });
      setNewOverrideDate("");
      setNewOverrideReason("");
      loadOverrides();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la excepción.");
    } finally {
      setSavingOverride(false);
    }
  }

  async function handleDeleteOverride(overrideDate: string) {
    if (!selectedProviderId) return;
    setDeletingOverrideDate(overrideDate);
    setError(null);
    try {
      await deleteAvailabilityOverride(fetch, apiBaseUrl, token, propertyId, selectedProviderId, overrideDate);
      loadOverrides();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo quitar la excepción.");
    } finally {
      setDeletingOverrideDate(null);
    }
  }

  const rulesByDay = new Map<number, AvailabilityRuleSummary[]>();
  if (detail) {
    for (const rule of detail.availabilityRules) {
      const list = rulesByDay.get(rule.dayOfWeek) ?? [];
      list.push(rule);
      rulesByDay.set(rule.dayOfWeek, list);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Disponibilidad</h1>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      {providers && providers.length === 0 && <p style={{ color: "#6b7280" }}>Este negocio todavía no tiene proveedores activos.</p>}

      {providers && providers.length > 0 && (
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "#374151" }}>
          Proveedor
          <select value={selectedProviderId} onChange={(e) => setSelectedProviderId(e.target.value)} style={{ ...inputStyle, maxWidth: 280 }}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
      )}

      {!detail && selectedProviderId && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}

      {detail && (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280" }}>Horario semanal</p>

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280", fontSize: 12, textTransform: "uppercase" }}>
                <th style={{ padding: "4px 0" }}>Día</th>
                <th style={{ padding: "4px 0" }}>Horario</th>
                <th style={{ padding: "4px 0" }} />
              </tr>
            </thead>
            <tbody>
              {DAY_OPTIONS.map((dayOfWeek) => {
                const rules = rulesByDay.get(dayOfWeek) ?? [];
                return (
                  <tr key={dayOfWeek} style={{ borderTop: "1px solid #f3f4f6", verticalAlign: "top" }}>
                    <td style={{ padding: "8px 0", fontWeight: 500 }}>{formatDayOfWeek(dayOfWeek)}</td>
                    <td style={{ padding: "8px 0", color: rules.length === 0 ? "#9ca3af" : "#111827" }} colSpan={2}>
                      {rules.length === 0 && "Cerrado"}
                      {rules.map((r) =>
                        editingRuleId === r.id ? (
                          <form key={r.id} onSubmit={handleSaveRule} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                            <input type="time" value={editStartTime} onChange={(e) => setEditStartTime(e.target.value)} style={{ ...inputStyle, padding: "4px 8px" }} required />
                            <span>–</span>
                            <input type="time" value={editEndTime} onChange={(e) => setEditEndTime(e.target.value)} style={{ ...inputStyle, padding: "4px 8px" }} required />
                            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                              <input type="checkbox" checked={editIsActive} onChange={(e) => setEditIsActive(e.target.checked)} />
                              Activo
                            </label>
                            <button type="submit" disabled={savingRule} style={{ ...primaryButtonStyle, padding: "4px 10px", fontSize: 12 }}>
                              {savingRule ? "Guardando…" : "Guardar"}
                            </button>
                            <button type="button" onClick={() => setEditingRuleId(null)} disabled={savingRule} style={{ ...secondaryButtonStyle, padding: "4px 10px", fontSize: 12 }}>
                              Cancelar
                            </button>
                          </form>
                        ) : (
                          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span style={{ opacity: r.isActive ? 1 : 0.5 }}>
                              {formatHHMM(r.startTime)} – {formatHHMM(r.endTime)}
                              {!r.isActive && " (inactivo)"}
                            </span>
                            <button type="button" onClick={() => startEditingRule(r)} style={{ ...secondaryButtonStyle, padding: "2px 8px", fontSize: 11 }}>
                              Editar
                            </button>
                            <button type="button" onClick={() => void handleDeleteRule(r.id)} disabled={deletingRuleId === r.id} style={dangerButtonStyle}>
                              {deletingRuleId === r.id ? "Quitando…" : "Quitar"}
                            </button>
                          </div>
                        ),
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <form onSubmit={handleCreateRule} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
            <select value={newDayOfWeek} onChange={(e) => setNewDayOfWeek(Number(e.target.value))} style={inputStyle}>
              {DAY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {formatDayOfWeek(d)}
                </option>
              ))}
            </select>
            <input type="time" value={newStartTime} onChange={(e) => setNewStartTime(e.target.value)} style={inputStyle} required />
            <span>–</span>
            <input type="time" value={newEndTime} onChange={(e) => setNewEndTime(e.target.value)} style={inputStyle} required />
            <button type="submit" disabled={creatingRule} style={primaryButtonStyle}>
              {creatingRule ? "Agregando…" : "Agregar horario"}
            </button>
          </form>
        </section>
      )}

      {detail && (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280" }}>Excepciones (días específicos)</p>

          {!overrides && <p style={{ margin: 0, color: "#6b7280" }}>Cargando…</p>}
          {overrides && overrides.length === 0 && <p style={{ margin: 0, color: "#6b7280" }}>Sin excepciones próximas — este proveedor sigue su horario semanal normal.</p>}
          {overrides && overrides.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {overrides.map((o) => (
                <div key={o.overrideDate} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 500 }}>{o.overrideDate}</span>
                  <span style={{ color: o.isClosed ? "#b91c1c" : "#111827" }}>{o.isClosed ? "Cerrado" : `${formatHHMM(o.startTime ?? "")} – ${formatHHMM(o.endTime ?? "")}`}</span>
                  {o.reason && <span style={{ color: "#6b7280" }}>({o.reason})</span>}
                  <button type="button" onClick={() => void handleDeleteOverride(o.overrideDate)} disabled={deletingOverrideDate === o.overrideDate} style={dangerButtonStyle}>
                    {deletingOverrideDate === o.overrideDate ? "Quitando…" : "Quitar"}
                  </button>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleSaveOverride} style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input type="date" value={newOverrideDate} onChange={(e) => setNewOverrideDate(e.target.value)} style={inputStyle} required />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={newOverrideClosed} onChange={(e) => setNewOverrideClosed(e.target.checked)} />
                Cerrado todo el día
              </label>
              {!newOverrideClosed && (
                <>
                  <input type="time" value={newOverrideStart} onChange={(e) => setNewOverrideStart(e.target.value)} style={inputStyle} required />
                  <span>–</span>
                  <input type="time" value={newOverrideEnd} onChange={(e) => setNewOverrideEnd(e.target.value)} style={inputStyle} required />
                </>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input placeholder="Motivo (opcional, ej. Vacaciones)" value={newOverrideReason} onChange={(e) => setNewOverrideReason(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 200 }} />
              <button type="submit" disabled={savingOverride} style={primaryButtonStyle}>
                {savingOverride ? "Guardando…" : "Guardar excepción"}
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
