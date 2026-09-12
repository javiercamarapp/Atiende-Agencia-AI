// Proveedores del panel de citas (Fase 5) — lista + ficha, de solo lectura (ver
// providers-client.ts: domain-citas todavía no expone crear/editar un proveedor).
// La ficha SÍ ofrece una acción real de escritura: conectar Google Calendar, que ya
// existía desde Fase 3 (google-calendar-oauth.ts).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchProviderDetail, fetchProviders, requestGoogleCalendarConnectUrl } from "../lib/providers-client.ts";
import type { ProviderDetail, ProviderSummary } from "../lib/providers-client.ts";
import { formatDayOfWeek, formatHHMM } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

export function ProveedoresListPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchProviders(fetch, apiBaseUrl, token, propertyId)
      .then((list) => !cancelado && setProviders(list))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudieron cargar los proveedores."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Proveedores</h1>
      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!providers && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {providers && providers.length === 0 && <p style={{ color: "#6b7280" }}>Este negocio todavía no tiene proveedores activos.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
        {providers?.map((p) => (
          <Link
            key={p.id}
            to={`/citas/${orgSlug}/proveedores/${p.id}`}
            style={{ display: "block", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, textDecoration: "none", color: "inherit" }}
          >
            <p style={{ margin: 0, fontWeight: 600 }}>{p.displayName}</p>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6b7280" }}>{p.roleLabel}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

export interface ProveedorFichaPageProps extends CitasShellContext {
  readonly providerId: string;
}

export function ProveedorFichaPage({ apiBaseUrl, token, propertyId, orgSlug, providerId }: ProveedorFichaPageProps) {
  const [detail, setDetail] = useState<ProviderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  function load() {
    setError(null);
    fetchProviderDetail(fetch, apiBaseUrl, token, propertyId, providerId)
      .then(setDetail)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudo cargar el proveedor."));
  }

  useEffect(() => {
    load();
  }, [apiBaseUrl, token, propertyId, providerId]);

  async function handleConnectGoogleCalendar() {
    setConnecting(true);
    setError(null);
    try {
      const url = await requestGoogleCalendarConnectUrl(fetch, apiBaseUrl, token, propertyId, providerId);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar la conexión con Google Calendar.");
      setConnecting(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
      <Link to={`/citas/${orgSlug}/proveedores`} style={{ fontSize: 13, color: "#6b7280" }}>
        ← Volver a proveedores
      </Link>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      {!detail && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}

      {detail && (
        <>
          <header>
            <h1 style={{ fontSize: 20, margin: 0 }}>{detail.provider.displayName}</h1>
            <p style={{ margin: "4px 0 0", color: "#6b7280" }}>{detail.provider.roleLabel}</p>
          </header>

          <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
            <p style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280" }}>Google Calendar</p>
            {detail.googleCalendar.connected ? (
              <p style={{ margin: 0, color: detail.googleCalendar.syncStatus === "error" ? "#b91c1c" : "#166534" }}>
                {detail.googleCalendar.syncStatus === "error" ? `Conectado, con un error de sincronización: ${detail.googleCalendar.syncError ?? "desconocido"}` : "Conectado — las citas de este proveedor se sincronizan automáticamente."}
              </p>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <p style={{ margin: 0, color: "#6b7280" }}>Este proveedor todavía no conecta su Google Calendar.</p>
                <button onClick={() => void handleConnectGoogleCalendar()} disabled={connecting} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" }}>
                  {connecting ? "Conectando…" : "Conectar Google Calendar"}
                </button>
              </div>
            )}
          </section>

          <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
            <p style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280" }}>Horario semanal</p>
            {detail.availabilityRules.length === 0 ? (
              <p style={{ margin: 0, color: "#6b7280" }}>Sin reglas de disponibilidad configuradas todavía.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <tbody>
                  {[...detail.availabilityRules]
                    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
                    .map((rule) => (
                      <tr key={rule.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                        <td style={{ padding: "6px 0" }}>{formatDayOfWeek(rule.dayOfWeek)}</td>
                        <td style={{ padding: "6px 0", color: rule.isActive ? "#111827" : "#9ca3af" }}>
                          {formatHHMM(rule.startTime)} – {formatHHMM(rule.endTime)} {!rule.isActive && "(inactivo)"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "#9ca3af" }}>Solo lectura — editar el horario todavía no está disponible desde el panel.</p>
          </section>
        </>
      )}
    </div>
  );
}
