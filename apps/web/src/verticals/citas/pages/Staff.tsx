// Staff (Fase 12) — hallazgo de auditoría (CRÍTICO/ALTO, "citas define 3 roles de
// plataforma pero no los aplica en NINGUNA capa"): admin-staff.ts ya expone
// POST/GET/DELETE .../admin/staff/invitaciones, pero ningún panel los llamaba
// todavía. Esta página cierra ese hueco: crear una invitación, ver las pendientes
// (con su token para copiar/pegar) y revocar una pendiente — mismo patrón exacto
// que restaurantes/pages/Staff.tsx, sin la sección de "repartidores" (citas no
// tiene ese concepto). Gateada por `STAFF_INVITE_ROLES` (owner/admin) del lado del
// CLIENTE (cosmético, ver CitasShellContext.role) — el servidor (admin-staff.ts)
// es SIEMPRE el enforcement real, con la jerarquía fina de `canInviteStaff` encima.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { createStaffInvite, fetchOrgMembers, fetchStaffInvites, revokeStaffInvite, updateStaffRole } from "../lib/staff-client.ts";
import type { CreatedStaffInvite, OrgMember, StaffInvite, StaffVerticalRole } from "../lib/staff-client.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const STAFF_INVITE_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

const ROLE_LABELS: Record<StaffVerticalRole, string> = {
  owner: "Dueño/a",
  admin: "Administrador/a",
  staff: "Staff",
};

const ROLE_OPTIONS: readonly StaffVerticalRole[] = ["admin", "staff", "owner"];

function statusLabel(status: string): string {
  if (status === "pending") return "Pendiente";
  if (status === "accepted") return "Aceptada";
  if (status === "revoked") return "Revocada";
  if (status === "expired") return "Expirada";
  return status;
}

export function StaffPage({ apiBaseUrl, token, propertyId, role }: CitasShellContext) {
  const canManage = STAFF_INVITE_ROLES.has(role);

  const [invites, setInvites] = useState<readonly StaffInvite[] | null>(null);
  // Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
  // restaurantes permite gestionar roles desde el producto"): todo lo de arriba
  // (invites) solo cubre alta -- esto es la tabla nueva "Staff activo".
  const [members, setMembers] = useState<readonly OrgMember[] | null>(null);
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [verticalRole, setVerticalRole] = useState<StaffVerticalRole>("staff");
  const [creating, setCreating] = useState(false);
  const [lastCreated, setLastCreated] = useState<CreatedStaffInvite | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function load() {
    if (!canManage) return;
    setError(null);
    try {
      setInvites(await fetchStaffInvites(fetch, apiBaseUrl, token, propertyId));
      setMembers(await fetchOrgMembers(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el staff.");
    }
  }

  async function handleRoleChange(memberId: string, nextRole: StaffVerticalRole) {
    setSavingRoleId(memberId);
    setError(null);
    try {
      const updated = await updateStaffRole(fetch, apiBaseUrl, token, propertyId, memberId, nextRole);
      setMembers((prev) => (prev ? prev.map((m) => (m.id === memberId ? updated : m)) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el rol de ese staff.");
    } finally {
      setSavingRoleId(null);
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, canManage]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setCreating(true);
    setError(null);
    setLastCreated(null);
    try {
      const created = await createStaffInvite(fetch, apiBaseUrl, token, propertyId, { email: email.trim().toLowerCase(), verticalRole });
      setLastCreated(created);
      setEmail("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la invitación.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    setRevokingId(inviteId);
    setError(null);
    try {
      await revokeStaffInvite(fetch, apiBaseUrl, token, propertyId, inviteId);
      if (lastCreated?.id === inviteId) setLastCreated(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo revocar la invitación.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 720 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Staff</h1>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      {!canManage && (
        <p style={{ margin: 0, fontSize: 13, color: "#6b7280", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
          Invitar o revocar staff está reservado a dueños y administradores. Con tu rol actual ({role}) no puedes gestionar el staff de este negocio.
        </p>
      )}

      {canManage && (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
          <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>Invitar a alguien nuevo</p>
          <form onSubmit={handleCreate} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="email"
              placeholder="correo@ejemplo.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, minWidth: 220 }}
            />
            <select value={verticalRole} onChange={(e) => setVerticalRole(e.target.value as StaffVerticalRole)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <button type="submit" disabled={creating} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" }}>
              {creating ? "Invitando…" : "Invitar"}
            </button>
          </form>
          <p style={{ margin: "8px 0 0", fontSize: 12, color: "#9ca3af" }}>
            No podrás dar de alta a alguien con más alcance que el tuyo — el servidor lo rechaza (403) aunque el rol aparezca en esta lista.
          </p>

          {lastCreated && (
            <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: "#eff6ff", border: "1px solid #bfdbfe" }}>
              <p style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 600 }}>
                Invitación creada para {lastCreated.email} ({ROLE_LABELS[lastCreated.verticalRole]})
              </p>
              <p style={{ margin: "0 0 6px", fontSize: 12, color: "#374151" }}>
                Se le mandó un correo real con el enlace de activación. Si prefieres compartirlo tú mismo, aquí está el token — solo se muestra una vez.
              </p>
              <code style={{ display: "block", padding: "8px 10px", borderRadius: 6, background: "#fff", border: "1px solid #dbeafe", fontSize: 12, wordBreak: "break-all" }}>{lastCreated.inviteToken}</code>
            </div>
          )}
        </section>
      )}

      {canManage && (
        <section>
          <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600 }}>Invitaciones pendientes</p>
          {!invites && !error && <p style={{ color: "#6b7280", fontSize: 13 }}>Cargando…</p>}
          {invites && invites.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>No hay ninguna invitación pendiente.</p>}
          {invites && invites.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {invites.map((inv) => (
                <div
                  key={inv.id}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}
                >
                  <div>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>{inv.email}</p>
                    <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
                      {ROLE_LABELS[inv.verticalRole]} · {statusLabel(inv.status)} · expira {new Date(inv.expiresAt).toLocaleString("es-MX")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRevoke(inv.id)}
                    disabled={revokingId === inv.id}
                    style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #fecaca", background: "#fff", color: "#b91c1c", fontSize: 12, cursor: "pointer" }}
                  >
                    {revokingId === inv.id ? "Revocando…" : "Revocar"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {canManage && (
        <section>
          <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600 }}>Staff activo</p>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "#9ca3af" }}>
            Cambia el rol de un staff ya aceptado. No puedes tocar el rol de alguien con más alcance que el tuyo, ni asignar un rol por encima del tuyo, ni cambiar tu propio rol
            — el servidor lo rechaza aunque el rol aparezca en esta lista.
          </p>
          {!members && !error && <p style={{ color: "#6b7280", fontSize: 13 }}>Cargando…</p>}
          {members && members.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>Todavía no hay ningún staff aceptado en este negocio.</p>}
          {members && members.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {members.map((m) => (
                <div
                  key={m.id}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, flexWrap: "wrap" }}
                >
                  <div>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>{m.fullName}</p>
                    <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>{m.email}</p>
                  </div>
                  <select
                    value={m.verticalRole}
                    disabled={savingRoleId === m.id}
                    onChange={(e) => void handleRoleChange(m.id, e.target.value as StaffVerticalRole)}
                    style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
