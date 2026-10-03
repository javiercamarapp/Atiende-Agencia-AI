// Staff — hallazgo de auditoría (severidad ALTA, "Alta de organización/staff
// imposible sin SQL"): admin-staff.ts ya expone POST/GET/DELETE
// .../despachos/:propertyId/admin/staff/invitaciones, pero ningún panel los
// llamaba todavía. Esta página cierra ese hueco: crear una invitación, ver las
// pendientes (con su token para copiar/pegar además del correo real que ya se
// encola best-effort, ver admin-staff.ts), y revocar una pendiente. Port EXACTO
// de apps/web/src/verticals/restaurantes/pages/Staff.tsx (leído primero como
// plantilla) sobre los 4 roles de despachos, sin la sección de "repartidores"
// (despachos no tiene un rol análogo con selector propio en otra ruta).
//
// Gateada por `STAFF_INVITE_ROLES` (solo admin) del lado del CLIENTE (cosmético,
// ver `DespachosShellContext.role`) — el servidor (admin-staff.ts) es SIEMPRE el
// enforcement real, con la jerarquía fina de `canInviteStaff` encima.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { MailPlus, Trash2 } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, PageContainer } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { createStaffInvite, fetchOrgMembers, fetchStaffInvites, revokeStaffInvite, updateStaffRole } from "../lib/staff-client.ts";
import type { CreatedStaffInvite, OrgMember, StaffInvite, StaffVerticalRole } from "../lib/staff-client.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que STAFF_INVITE_ROLES (@atiende/domain-despachos/roles.ts) --
// cosmético, el servidor aplica exactamente el mismo filtro vía assertVerticalRole
// en las 3 rutas de admin-staff.ts. Nunca la única barrera.
const STAFF_INVITE_ROLES: ReadonlySet<string> = new Set(["admin"]);

const ROLE_LABELS: Record<StaffVerticalRole, string> = {
  admin: "Administrador",
  contador: "Contador",
  auditor: "Auditor",
  readonly: "Solo lectura",
};

const ROLE_OPTIONS: readonly StaffVerticalRole[] = ["contador", "auditor", "readonly", "admin"];

function statusLabel(status: string): string {
  if (status === "pending") return "Pendiente";
  if (status === "accepted") return "Aceptada";
  if (status === "revoked") return "Revocada";
  if (status === "expired") return "Expirada";
  return status;
}

export function StaffPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const canManage = STAFF_INVITE_ROLES.has(role);

  const [invites, setInvites] = useState<readonly StaffInvite[] | null>(null);
  // Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
  // restaurantes permite gestionar roles desde el producto"): todo lo de arriba
  // (invites) solo cubre alta -- esto es la tabla nueva "Staff activo".
  const [members, setMembers] = useState<readonly OrgMember[] | null>(null);
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [verticalRole, setVerticalRole] = useState<StaffVerticalRole>("contador");
  const [creating, setCreating] = useState(false);
  const [lastCreated, setLastCreated] = useState<CreatedStaffInvite | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
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
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
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

  const columnasInvitaciones: DataTableColumna<StaffInvite>[] = [
    { id: "correo", encabezado: "Correo", principal: true, valorOrden: (inv) => inv.email, celda: (inv) => <span className="font-medium text-foreground">{inv.email}</span> },
    { id: "rol", encabezado: "Rol", valorOrden: (inv) => ROLE_LABELS[inv.verticalRole], celda: (inv) => ROLE_LABELS[inv.verticalRole] },
    { id: "estado", encabezado: "Estado", valorOrden: (inv) => inv.status, celda: (inv) => statusLabel(inv.status) },
    {
      id: "expira",
      encabezado: "Expira",
      valorOrden: (inv) => inv.expiresAt,
      celda: (inv) => <span className="text-muted-foreground">{new Date(inv.expiresAt).toLocaleString("es-MX")}</span>,
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      alinear: "right",
      celda: (inv) => (
        <Button type="button" variant="outline" size="sm" className="h-9 shrink-0 border-destructive/40 text-destructive hover:border-destructive" onClick={() => void handleRevoke(inv.id)} disabled={revokingId === inv.id}>
          <Trash2 />
          {revokingId === inv.id ? "Revocando…" : "Revocar"}
        </Button>
      ),
    },
  ];

  const columnasStaff: DataTableColumna<OrgMember>[] = [
    { id: "nombre", encabezado: "Nombre", principal: true, valorOrden: (m) => m.fullName, celda: (m) => <span className="font-medium text-foreground">{m.fullName}</span> },
    { id: "correo", encabezado: "Correo", valorOrden: (m) => m.email, celda: (m) => <span className="text-muted-foreground">{m.email}</span> },
    {
      id: "rol",
      encabezado: "Rol",
      valorOrden: (m) => ROLE_LABELS[m.verticalRole],
      celda: (m) => (
        <>
          <Label htmlFor={`staff-rol-${m.id}`} className="sr-only">
            Rol de {m.fullName}
          </Label>
          <NativeSelect
            id={`staff-rol-${m.id}`}
            value={m.verticalRole}
            disabled={savingRoleId === m.id}
            onChange={(e) => void handleRoleChange(m.id, e.target.value as StaffVerticalRole)}
            wrapperClassName="w-auto min-w-44"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </NativeSelect>
        </>
      ),
    },
  ];

  return (
    <PageContainer padding="none" size="md" className="gap-5 [&>*]:min-w-0">
      <h1 className="font-display text-xl font-semibold text-foreground">Staff</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {!canManage && (
        <p className="rounded-xl border border-border bg-muted px-3 py-3 text-sm text-muted-foreground">
          Invitar o revocar staff está reservado al administrador del despacho. Tu rol actual ({role}) no tiene acceso a esta página.
        </p>
      )}

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Invitar a alguien nuevo</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="flex flex-wrap items-center gap-2">
              <Label htmlFor="staff-email" className="sr-only">
                Correo del staff
              </Label>
              <Input
                id="staff-email"
                type="email"
                placeholder="correo@ejemplo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="min-w-56 flex-1 text-sm"
              />
              <Label htmlFor="staff-rol" className="sr-only">
                Rol del staff
              </Label>
              <NativeSelect
                id="staff-rol"
                value={verticalRole}
                onChange={(e) => setVerticalRole(e.target.value as StaffVerticalRole)}
                wrapperClassName="w-auto min-w-44"
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </NativeSelect>
              <Button type="submit" size="sm" disabled={creating}>
                <MailPlus />
                {creating ? "Invitando…" : "Invitar"}
              </Button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">
              No podrás dar de alta a alguien con más alcance que el tuyo — el servidor lo rechaza (403) aunque el rol aparezca en esta lista.
            </p>

            {lastCreated && (
              <div className="mt-3.5 rounded-lg border border-primary/30 bg-primary/5 p-3">
                <p className="text-sm font-semibold text-foreground">
                  Invitación creada para {lastCreated.email} ({ROLE_LABELS[lastCreated.verticalRole]})
                </p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Ya se encoló un correo real con el enlace de activación. Si prefieres compartirlo tú mismo, aquí está el token — solo se muestra una vez.
                </p>
                <code className="mt-1.5 block break-all rounded-md border border-border bg-card px-2.5 py-2 font-mono text-xs text-foreground">{lastCreated.inviteToken}</code>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <section>
          <p className="mb-2 text-sm font-semibold text-foreground">Invitaciones pendientes</p>
          {!invites && !error && <EstadoCargando etiqueta="Cargando invitaciones…" lineas={2} />}
          {invites && invites.length === 0 && <EstadoVacio mensaje="No hay ninguna invitación pendiente." />}
          {invites && invites.length > 0 && (
            <DataTable etiqueta="Invitaciones pendientes" columnas={columnasInvitaciones} filas={invites} obtenerId={(inv) => inv.id} />
          )}
        </section>
      )}

      {canManage && (
        <section>
          <p className="mb-2 text-sm font-semibold text-foreground">Staff activo</p>
          <p className="mb-2 text-xs text-muted-foreground">
            Cambia el rol de un staff ya aceptado. No puedes tocar el rol de alguien con más alcance que el tuyo, ni asignar un rol por encima del tuyo, ni cambiar tu propio rol
            — el servidor lo rechaza aunque el rol aparezca en esta lista.
          </p>
          {!members && !error && <EstadoCargando etiqueta="Cargando staff…" lineas={2} />}
          {members && members.length === 0 && <EstadoVacio mensaje="Todavía no hay ningún staff aceptado en este despacho." />}
          {members && members.length > 0 && (
            <DataTable etiqueta="Staff activo" columnas={columnasStaff} filas={members} obtenerId={(m) => m.id} />
          )}
        </section>
      )}
    </PageContainer>
  );
}
