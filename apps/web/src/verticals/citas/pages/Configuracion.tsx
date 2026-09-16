// Configuración del panel de citas — centro de conexión de Google Calendar por
// proveedor (Fase 3/5) y, desde Fase 8, edición real de `citas.tenant_config`
// (rubro/timezone/teléfono de aviso — port de ConfiguracionSection.tsx del
// origen, ver tenant-config-client.ts). A propósito NO edita `name`/`slug`/
// `is_active` del negocio (`core.organization`): ver comentario en
// domain-citas/src/repository.ts::TenantConfigPatch — ese schema es compartido
// por las 6 verticales y ninguna otra lo edita desde el panel todavía. Horarios
// globales del negocio, plantillas de recordatorios y configuración del canal de
// WhatsApp siguen sin lectura/escritura expuesta en domain-citas.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { UserRound } from "lucide-react";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import { fetchProviderDetail, fetchProviders, requestGoogleCalendarConnectUrl } from "../lib/providers-client.ts";
import type { GoogleCalendarStatus, ProviderSummary } from "../lib/providers-client.ts";
import { fetchTenantConfig, RUBRO_OPTIONS, updateTenantConfig } from "../lib/tenant-config-client.ts";
import type { TenantConfig } from "../lib/tenant-config-client.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

interface ProviderRow {
  readonly provider: ProviderSummary;
  readonly googleCalendar: GoogleCalendarStatus | null;
}

const inputStyle = { padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 };
const primaryButtonStyle = { padding: "6px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" };

export function ConfiguracionPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const [rows, setRows] = useState<readonly ProviderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const [tenantConfig, setTenantConfig] = useState<TenantConfig | null>(null);
  const [tenantConfigError, setTenantConfigError] = useState<string | null>(null);
  const [rubro, setRubro] = useState("otro");
  const [timezone, setTimezone] = useState("America/Mexico_City");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [savingTenantConfig, setSavingTenantConfig] = useState(false);
  const [tenantConfigSaved, setTenantConfigSaved] = useState(false);

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

  function loadTenantConfig() {
    setTenantConfigError(null);
    fetchTenantConfig(fetch, apiBaseUrl, token, propertyId)
      .then((config) => {
        setTenantConfig(config);
        setRubro(config.rubro);
        setTimezone(config.defaultTimezone);
        setOwnerPhone(config.ownerNotificationPhone ?? "");
      })
      .catch((err: unknown) => setTenantConfigError(err instanceof Error ? err.message : "No se pudo cargar la configuración del negocio."));
  }

  useEffect(() => {
    void load();
    loadTenantConfig();
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

  async function handleSaveTenantConfig(e: FormEvent) {
    e.preventDefault();
    setSavingTenantConfig(true);
    setTenantConfigError(null);
    setTenantConfigSaved(false);
    try {
      const updated = await updateTenantConfig(fetch, apiBaseUrl, token, propertyId, { rubro, defaultTimezone: timezone, ownerNotificationPhone: ownerPhone.trim() || null });
      setTenantConfig(updated);
      setTenantConfigSaved(true);
    } catch (err) {
      setTenantConfigError(err instanceof Error ? err.message : "No se pudo guardar la configuración del negocio.");
    } finally {
      setSavingTenantConfig(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Configuración</h1>
      <p style={{ margin: 0, color: "#6b7280", fontSize: 13 }}>
        Negocio: <strong>{orgSlug}</strong>
      </p>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
        <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>Datos del negocio</p>

        {tenantConfigError && (
          <div className="mb-3">
            <EstadoError mensaje={tenantConfigError} />
          </div>
        )}
        {!tenantConfig && !tenantConfigError && <EstadoCargando etiqueta="Cargando datos del negocio…" />}

        {tenantConfig && (
          <form onSubmit={handleSaveTenantConfig} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6b7280" }}>
              Rubro
              <select value={rubro} onChange={(e) => setRubro(e.target.value)} style={inputStyle}>
                {RUBRO_OPTIONS.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>Determina qué FAQs y, en rubros de salud, qué guardia de crisis aplica el agente — no cambia el motor.</span>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6b7280" }}>
              Zona horaria por defecto
              <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Ej. America/Mexico_City" style={inputStyle} />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6b7280" }}>
              Teléfono de aviso urgente (opcional)
              <input value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} placeholder="Ej. 5599998888" style={inputStyle} />
              <span style={{ fontSize: 11, color: "#9ca3af" }}>Se avisa por WhatsApp si la guardia de crisis detecta un mensaje real de emergencia.</span>
            </label>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button type="submit" disabled={savingTenantConfig} style={primaryButtonStyle}>
                {savingTenantConfig ? "Guardando…" : "Guardar cambios"}
              </button>
              {tenantConfigSaved && !savingTenantConfig && <span style={{ fontSize: 12, color: "#166534" }}>Guardado.</span>}
            </div>
          </form>
        )}
      </section>

      {error && <EstadoError mensaje={error} />}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
        <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>Conexión con Google Calendar</p>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "#6b7280" }}>Cada proveedor conecta su propio calendario — un calendario de Google es personal, nunca compartido por todo el negocio.</p>

        {!rows && !error && <EstadoCargando etiqueta="Cargando proveedores…" />}
        {rows && rows.length === 0 && <EstadoVacio icon={UserRound} mensaje="Este negocio todavía no tiene proveedores activos." />}

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
          Horarios globales del negocio, plantillas de recordatorios y configuración del canal de WhatsApp todavía no tienen lectura/escritura expuesta en el backend de citas — se agregarán cuando el dominio las calcule. El nombre/slug/estado del negocio (`core.organization`) tampoco se edita aquí: ese schema es compartido por las 6 verticales de la plataforma.
        </p>
      </section>
    </div>
  );
}
