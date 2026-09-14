// Sucursales (Fase 5) — lista + ficha de edición real (teléfono/dirección/
// coordenadas/slug). Deliberadamente sin "crear sucursal" ni "activar/desactivar":
// ver comentario de cabecera de admin-branches.ts.
import { useEffect, useState } from "react";
import { fetchAdminBranches, updateBranchDetail } from "../lib/branches-client.ts";
import type { BranchDetail } from "../lib/branches-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

export function SucursalesPage({ apiBaseUrl, token, propertyId }: RestaurantesShellContext) {
  const [branches, setBranches] = useState<readonly BranchDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ phone: string; address: string }>({ phone: "", address: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    setError(null);
    try {
      setBranches(await fetchAdminBranches(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las sucursales.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  function startEditing(branch: BranchDetail) {
    setEditing(branch.propertyId);
    setDraft({ phone: branch.phone ?? "", address: branch.address ?? "" });
  }

  async function handleSave(branchId: string) {
    setSaving(true);
    setError(null);
    try {
      await updateBranchDetail(fetch, apiBaseUrl, token, propertyId, branchId, { phone: draft.phone || null, address: draft.address || null });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la sucursal.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Sucursales</h1>
      <p style={{ margin: 0, fontSize: 12, color: "#9ca3af" }}>
        Crear una sucursal nueva o activar/desactivarla todavía no está disponible desde el panel — requiere un cambio de plataforma compartido por todas las verticales (ver README de este vertical).
      </p>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!branches && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {branches?.map((b) => (
          <div key={b.propertyId} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>{b.name}</p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
                  /{b.slug} ·{" "}
                  <span style={{ color: b.status === "active" ? "#166534" : "#991b1b" }}>{b.status === "active" ? "Activa" : "Inactiva"}</span>
                </p>
              </div>
              {editing !== b.propertyId && (
                <button onClick={() => startEditing(b)} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 12, cursor: "pointer" }}>
                  Editar
                </button>
              )}
            </div>

            {editing === b.propertyId ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
                <label style={{ fontSize: 12, color: "#6b7280" }}>
                  Teléfono
                  <input value={draft.phone} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} style={{ display: "block", width: "100%", marginTop: 4, padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }} />
                </label>
                <label style={{ fontSize: 12, color: "#6b7280" }}>
                  Dirección
                  <input value={draft.address} onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))} style={{ display: "block", width: "100%", marginTop: 4, padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }} />
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => void handleSave(b.propertyId)} disabled={saving} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 12, cursor: "pointer" }}>
                    {saving ? "Guardando…" : "Guardar"}
                  </button>
                  <button onClick={() => setEditing(null)} disabled={saving} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 12, cursor: "pointer" }}>
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <dl style={{ margin: "8px 0 0", display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 4, columnGap: 12, fontSize: 13 }}>
                <dt style={{ color: "#6b7280" }}>Teléfono</dt>
                <dd style={{ margin: 0 }}>{b.phone ?? "—"}</dd>
                <dt style={{ color: "#6b7280" }}>Dirección</dt>
                <dd style={{ margin: 0 }}>{b.address ?? "—"}</dd>
              </dl>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
