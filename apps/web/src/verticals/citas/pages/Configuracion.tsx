// Configuración del panel de citas (Fase 5) — hoy es, sobre todo, el centro de
// conexión de Google Calendar por proveedor (Fase 3, ya existía en el backend vía
// google-calendar-oauth.ts; esta página es la primera UI real que lo usa). El
// resto de "configuración" del negocio (horarios globales, recordatorios, canales
// de WhatsApp) no tiene todavía ninguna lectura/escritura expuesta en
// domain-citas — se documenta como pendiente en vez de inventar un formulario que
// no guardaría nada real.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchProviderDetail, fetchProviders, requestGoogleCalendarConnectUrl } from "../lib/providers-client.ts";
import type { GoogleCalendarStatus, ProviderSummary } from "../lib/providers-client.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

interface ProviderRow {
  readonly provider: ProviderSummary;
  readonly googleCalendar: GoogleCalendarStatus | null;
}

export function ConfiguracionPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const [rows, setRows] = useState<readonly ProviderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const providers = await fetchProviders(fetch, apiBaseUrl, token, propertyId);
      const details = await Promise.all(
        providers.map(async (provider) => {
          try {
            const detail = await fetchProviderDetail(fetch, apiBaseUrl, token, propertyId, provider.id);
            return { provider, googleCalendar: detail.googleCalendar };
          } catch {
            return { provider, googleCalendar: null };
          }
        }),
      );
      setRows(details);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la configuración.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleConnect(providerId: string) {
    setConnectingId(providerId);
    setError(null);
    try {
      const url = await requestGoogleCalendarConnectUrl(fetch, apiBaseUrl, token, propertyId, providerId);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar la conexión con Google Calendar.");
      setConnectingId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Configuración</h1>
      <p style={{ margin: 0, color: "#6b7280", fontSize: 13 }}>
        Negocio: <strong>{orgSlug}</strong>
      </p>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
        <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>Conexión con Google Calendar</p>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "#6b7280" }}>Cada proveedor conecta su propio calendario — un calendario de Google es personal, nunca compartido por todo el negocio.</p>

        {!rows && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
        {rows && rows.length === 0 && <p style={{ color: "#6b7280" }}>Este negocio todavía no tiene proveedores activos.</p>}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows?.map(({ provider, googleCalendar }) => (
            <div key={provider.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid #f3f4f6", flexWrap: "wrap" }}>
              <div>
                <Link to={`/citas/${orgSlug}/proveedores/${provider.id}`} style={{ fontWeight: 500, color: "inherit", textDecoration: "none" }}>
                  {provider.displayName}
                </Link>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>{provider.roleLabel}</p>
              </div>
              {googleCalendar?.connected ? (
                <span style={{ fontSize: 12, padding: "3px 10px", borderRadius: 999, background: googleCalendar.syncStatus === "error" ? "#fee2e2" : "#dcfce7", color: googleCalendar.syncStatus === "error" ? "#991b1b" : "#166534" }}>
                  {googleCalendar.syncStatus === "error" ? "Conectado (con error)" : "Conectado"}
                </span>
              ) : (
                <button
                  onClick={() => void handleConnect(provider.id)}
                  disabled={connectingId === provider.id}
                  style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 12, cursor: "pointer" }}
                >
                  {connectingId === provider.id ? "Conectando…" : "Conectar"}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section style={{ border: "1px dashed #d1d5db", borderRadius: 10, padding: 16 }}>
        <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600, color: "#6b7280" }}>Próximamente</p>
        <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>
          Horarios globales del negocio, plantillas de recordatorios y configuración del canal de WhatsApp todavía no tienen lectura/escritura expuesta en el backend de citas — se agregarán cuando el dominio las calcule.
        </p>
      </section>
    </div>
  );
}
