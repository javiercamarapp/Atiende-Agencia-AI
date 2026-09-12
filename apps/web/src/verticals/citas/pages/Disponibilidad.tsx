// Disponibilidad del panel de citas (Fase 5) — selector de proveedor + su horario
// semanal real (mismos datos que la sección "Horario semanal" de la ficha de
// Proveedores.tsx, reusando providers-client.ts: domain-citas solo expone lectura
// de reglas de disponibilidad, `loadAvailabilityRules` — ningún endpoint de
// escritura todavía, ver README). Página aparte porque el diseño original la trata
// como su propia sección del panel (DisponibilidadSection.tsx).
import { useEffect, useState } from "react";
import { fetchProviderDetail, fetchProviders } from "../lib/providers-client.ts";
import type { AvailabilityRuleSummary, ProviderDetail, ProviderSummary } from "../lib/providers-client.ts";
import { formatDayOfWeek, formatHHMM } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

export function DisponibilidadPage({ apiBaseUrl, token, propertyId }: CitasShellContext) {
  const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [detail, setDetail] = useState<ProviderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    fetchProviderDetail(fetch, apiBaseUrl, token, propertyId, selectedProviderId)
      .then((d) => !cancelado && setDetail(d))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudo cargar la disponibilidad."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, selectedProviderId]);

  const rulesByDay = new Map<number, AvailabilityRuleSummary[]>();
  if (detail) {
    for (const rule of detail.availabilityRules) {
      const list = rulesByDay.get(rule.dayOfWeek) ?? [];
      list.push(rule);
      rulesByDay.set(rule.dayOfWeek, list);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
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
          <select value={selectedProviderId} onChange={(e) => setSelectedProviderId(e.target.value)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db" }}>
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
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280", fontSize: 12, textTransform: "uppercase" }}>
              <th style={{ padding: "4px 0" }}>Día</th>
              <th style={{ padding: "4px 0" }}>Horario</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 7 }, (_, dayOfWeek) => {
              const rules = rulesByDay.get(dayOfWeek) ?? [];
              return (
                <tr key={dayOfWeek} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "8px 0", fontWeight: 500 }}>{formatDayOfWeek(dayOfWeek)}</td>
                  <td style={{ padding: "8px 0", color: rules.length === 0 ? "#9ca3af" : "#111827" }}>
                    {rules.length === 0
                      ? "Cerrado"
                      : rules.map((r) => (
                          <span key={r.id} style={{ marginRight: 12, opacity: r.isActive ? 1 : 0.5 }}>
                            {formatHHMM(r.startTime)} – {formatHHMM(r.endTime)}
                            {!r.isActive && " (inactivo)"}
                          </span>
                        ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p style={{ margin: 0, fontSize: 12, color: "#9ca3af" }}>Solo lectura — configurar horarios/excepciones todavía no está disponible desde el panel.</p>
    </div>
  );
}
