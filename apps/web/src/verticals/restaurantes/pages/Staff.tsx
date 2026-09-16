// Staff (Fase 14) — hallazgo de auditoría (severidad ALTA, "Invitaciones de staff
// (Fase 10) sin ninguna UI: imposible dar de alta staff o repartidores desde el
// producto"): admin-staff.ts ya exponía POST/GET/DELETE .../admin/staff/invitaciones
// desde Fase 10, y GET .../admin/staff/repartidores desde Fase 12 (ver el comentario
// de cabecera de ese archivo), pero ningún panel los llamaba todavía. Esta página
// cierra ese hueco: crear una invitación, ver las pendientes (con su token para
// copiar/pegar — sin proveedor SMTP configurado, ver comentario de
// `admin-staff.ts::app.post(collectionPath)`), revocar una pendiente, y ver a los
// repartidores YA aceptados (reusa `fetchRepartidores`, Fase 12 — no se duplica ese
// listado). Gateada por `STAFF_INVITE_ROLES` (owner/admin) del lado del CLIENTE
// (cosmético, ver `RestaurantesShellContext.role`) — el servidor (admin-staff.ts) es
// SIEMPRE el enforcement real, con la jerarquía fina de `canInviteStaff` encima.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import {
  createStaffInvite,
  fetchOrgMembers,
  fetchRepartidores,
  fetchStaffInvites,
  revokeStaffInvite,
  updateStaffRole,
} from "../lib/staff-client.ts";
import type { CreatedStaffInvite, OrgMember, RepartidorMember, StaffInvite, StaffVerticalRole } from "../lib/staff-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const STAFF_INVITE_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

const ROLE_LABELS: Record<StaffVerticalRole, string> = {
  owner: "Dueño",
  admin: "Administrador",
  staff: "Staff (gestión)",
  repartidor: "Repartidor",
};

const ROLE_OPTIONS: readonly StaffVerticalRole[] = ["admin", "staff", "repartidor", "owner"];

function statusLabel(status: string): string {
  if (status === "pending") return "Pendiente";
  if (status === "accepted") return "Aceptada";
  if (status === "revoked") return "Revocada";
  if (status === "expired") return "Expirada";
  return status;
}

export function StaffPage({ apiBaseUrl, token, propertyId, role }: RestaurantesShellContext) {
  const canManage = STAFF_INVITE_ROLES.has(role);

  const [invites, setInvites] = useState<readonly StaffInvite[] | null>(null);
  const [repartidores, setRepartidores] = useState<readonly RepartidorMember[] | null>(null);
  // Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
  // restaurantes permite gestionar roles desde el producto"): verificado contra el
  // código real que ni siquiera restaurantes podía cambiar el rol de un staff YA
  // ACEPTADO — todo lo de arriba (invites/repartidores) solo cubre alta o lectura.
  const [members, setMembers] = useState<readonly OrgMember[] | null>(null);
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [verticalRole, setVerticalRole] = useState<StaffVerticalRole>("staff");
  const [creating, setCreating] = useState(false);
  const [lastCreated, setLastCreated] = useState<CreatedStaffInvite | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      // `fetchRepartidores` está gateado por MANAGER_ROLES (owner/admin/staff, más
      // amplio) en el servidor -- se pide siempre. `fetchStaffInvites`/
      // `fetchOrgMembers` están gateados por STAFF_INVITE_ROLES (owner/admin, más
      // angosto) -- solo se piden cuando `canManage` ya lo anticipa, para no
      // disparar un 403 esperado en cada carga.
      setRepartidores(await fetchRepartidores(fetch, apiBaseUrl, token, propertyId));
      if (canManage) {
        setInvites(await fetchStaffInvites(fetch, apiBaseUrl, token, propertyId));
        setMembers(await fetchOrgMembers(fetch, apiBaseUrl, token, propertyId));
      }
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

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {!canManage && (
        <p style={{ margin: 0, fontSize: 13, color: "#6b7280", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
          Invitar o revocar staff está reservado a dueños y administradores. Con tu rol actual ({role}) solo puedes ver a los repartidores ya activos.
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
                Compártele este token — solo se muestra una vez. Debe pegarlo en <code>/aceptar-invitacion</code> junto con su nombre y una contraseña.
              </p>
              <code style={{ display: "block", padding: "8px 10px", borderRadius: 6, background: "#fff", border: "1px solid #dbeafe", fontSize: 12, wordBreak: "break-all" }}>{lastCreated.inviteToken}</code>
            </div>
          )}
        </section>
      )}

      {canManage && (
        <section>
          <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600 }}>Invitaciones pendientes</p>
          {!invites && !error && <EstadoCargando etiqueta="Cargando invitaciones…" />}
          {invites && invites.length === 0 && <EstadoVacio mensaje="No hay ninguna invitación pendiente." />}
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
          {!members && !error && <EstadoCargando etiqueta="Cargando staff…" />}
          {members && members.length === 0 && <EstadoVacio mensaje="Todavía no hay ningún staff aceptado en esta organización." />}
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

      <section>
        <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600 }}>Repartidores activos</p>
        {!repartidores && !error && <EstadoCargando etiqueta="Cargando repartidores…" />}
        {repartidores && repartidores.length === 0 && <EstadoVacio mensaje="Todavía no hay ningún repartidor aceptado en esta organización." />}
        {repartidores && repartidores.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {repartidores.map((r) => (
              <div key={r.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>{r.fullName}</p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>{r.email}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
