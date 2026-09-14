// Proveedores del panel de citas — lista + ficha (Fase 5). Fase 8 cierra el gap
// real de paridad con el origen (FichaProveedor.tsx/ProveedoresSection.tsx): alta/
// edición real de un proveedor y el checkbox real de qué servicios ofrece
// (`citas.provider_services`) — ver providers-client.ts. La ficha SÍ seguía
// ofreciendo, desde antes, una acción real: conectar Google Calendar (Fase 3).
//
// Sin selector de sucursal en el formulario a propósito: el shell de este panel
// (CitasShell.tsx) todavía usa siempre `branches[0]` como la única propertyId
// operable — un negocio de citas casi siempre es de una sola ubicación (ver
// ProviderRecord.propertyId). Agregar un selector de sucursal real es la misma
// decisión de producto pendiente en todo el panel, no algo que esta fase deba
// resolver a medias.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { createProvider, fetchProviderDetail, fetchProviders, requestGoogleCalendarConnectUrl, setProviderServiceOffering, updateProvider } from "../lib/providers-client.ts";
import type { ProviderDetail, ProviderSummary } from "../lib/providers-client.ts";
import { fetchServices } from "../lib/services-client.ts";
import type { ServiceSummary } from "../lib/services-client.ts";
import { formatDayOfWeek, formatHHMM } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const inputStyle = { padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 };
const primaryButtonStyle = { padding: "6px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" };

export function ProveedoresListPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRoleLabel, setNewRoleLabel] = useState("");
  const [creating, setCreating] = useState(false);

  function load() {
    setError(null);
    fetchProviders(fetch, apiBaseUrl, token, propertyId)
      .then(setProviders)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudieron cargar los proveedores."));
  }

  useEffect(() => {
    load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newDisplayName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createProvider(fetch, apiBaseUrl, token, propertyId, { displayName: newDisplayName.trim(), roleLabel: newRoleLabel.trim() || undefined });
      setNewDisplayName("");
      setNewRoleLabel("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el proveedor.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Proveedores</h1>
      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
        <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>Nuevo proveedor</p>
        <form onSubmit={handleCreate} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input placeholder="Nombre (ej. Dra. Ana Ruiz)" value={newDisplayName} onChange={(e) => setNewDisplayName(e.target.value)} style={inputStyle} />
          <input placeholder="Rol (ej. Dentista, Barbero)" value={newRoleLabel} onChange={(e) => setNewRoleLabel(e.target.value)} style={inputStyle} />
          <button type="submit" disabled={creating} style={primaryButtonStyle}>
            {creating ? "Creando…" : "Crear proveedor"}
          </button>
        </form>
      </section>

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
  const [services, setServices] = useState<readonly ServiceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [togglingServiceId, setTogglingServiceId] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editRoleLabel, setEditRoleLabel] = useState("");
  const [editIsActive, setEditIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  function load() {
    setError(null);
    fetchProviderDetail(fetch, apiBaseUrl, token, propertyId, providerId)
      .then((d) => {
        setDetail(d);
        setEditDisplayName(d.provider.displayName);
        setEditRoleLabel(d.provider.roleLabel);
        setEditIsActive(d.provider.isActive);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudo cargar el proveedor."));
  }

  useEffect(() => {
    load();
    fetchServices(fetch, apiBaseUrl, token, propertyId)
      .then(setServices)
      .catch(() => {
        /* la sección de servicios se degrada a "no se pudieron cargar" sin tronar la ficha completa */
      });
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

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editDisplayName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await updateProvider(fetch, apiBaseUrl, token, propertyId, providerId, { displayName: editDisplayName.trim(), roleLabel: editRoleLabel.trim() || undefined, isActive: editIsActive });
      setEditing(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el proveedor.");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleService(serviceId: string, offered: boolean) {
    setTogglingServiceId(serviceId);
    setError(null);
    try {
      await setProviderServiceOffering(fetch, apiBaseUrl, token, propertyId, providerId, serviceId, offered);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el servicio del proveedor.");
    } finally {
      setTogglingServiceId(null);
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
          <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <h1 style={{ fontSize: 20, margin: 0 }}>{detail.provider.displayName}</h1>
              <p style={{ margin: "4px 0 0", color: "#6b7280" }}>
                {detail.provider.roleLabel} {!detail.provider.isActive && "· Inactivo"}
              </p>
            </div>
            {!editing && (
              <button onClick={() => setEditing(true)} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, cursor: "pointer" }}>
                Editar proveedor
              </button>
            )}
          </header>

          {editing && (
            <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
              <form onSubmit={handleSaveEdit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6b7280" }}>
                  Nombre
                  <input value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} style={inputStyle} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6b7280" }}>
                  Rol / etiqueta
                  <input value={editRoleLabel} onChange={(e) => setEditRoleLabel(e.target.value)} style={inputStyle} />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={editIsActive} onChange={(e) => setEditIsActive(e.target.checked)} />
                  Activo
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="submit" disabled={saving} style={primaryButtonStyle}>
                    {saving ? "Guardando…" : "Guardar cambios"}
                  </button>
                  <button type="button" onClick={() => setEditing(false)} disabled={saving} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, cursor: "pointer" }}>
                    Cancelar
                  </button>
                </div>
              </form>
            </section>
          )}

          <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
            <p style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280" }}>Google Calendar</p>
            {detail.googleCalendar.connected ? (
              <p style={{ margin: 0, color: detail.googleCalendar.syncStatus === "error" ? "#b91c1c" : "#166534" }}>
                {detail.googleCalendar.syncStatus === "error" ? `Conectado, con un error de sincronización: ${detail.googleCalendar.syncError ?? "desconocido"}` : "Conectado — las citas de este proveedor se sincronizan automáticamente."}
              </p>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <p style={{ margin: 0, color: "#6b7280" }}>Este proveedor todavía no conecta su Google Calendar.</p>
                <button onClick={() => void handleConnectGoogleCalendar()} disabled={connecting} style={primaryButtonStyle}>
                  {connecting ? "Conectando…" : "Conectar Google Calendar"}
                </button>
              </div>
            )}
          </section>

          <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
            <p style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280" }}>Servicios que ofrece</p>
            {!services ? (
              <p style={{ margin: 0, color: "#6b7280" }}>Cargando…</p>
            ) : services.length === 0 ? (
              <p style={{ margin: 0, color: "#6b7280" }}>Este negocio todavía no tiene servicios configurados.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {services.map((s) => {
                  const offered = detail.offeredServiceIds.includes(s.id);
                  return (
                    <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "4px 0" }}>
                      <input type="checkbox" checked={offered} disabled={togglingServiceId === s.id} onChange={(e) => void handleToggleService(s.id, e.target.checked)} />
                      {s.name}
                    </label>
                  );
                })}
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
