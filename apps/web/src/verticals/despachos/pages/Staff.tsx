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
import { Lock, MailPlus, Trash2 } from "lucide-react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, FormDialog, FormField, Input, NativeSelect, notify, PageContainer, PageHeader, useConfirm } from "@atiende/ui";
import { createStaffInvite, fetchOrgMembers, fetchStaffInvites, revokeStaffInvite, updateStaffRole } from "../lib/staff-client.ts";
import type { CreatedStaffInvite, OrgMember, StaffInvite, StaffVerticalRole } from "../lib/staff-client.ts";
import { formatDateTime } from "../lib/format.ts";
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
  const { confirmar, dialogo } = useConfirm();

  const [invites, setInvites] = useState<readonly StaffInvite[] | null>(null);
  // Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
  // restaurantes permite gestionar roles desde el producto"): todo lo de arriba
  // (invites) solo cubre alta -- esto es la tabla nueva "Equipo activo".
  const [members, setMembers] = useState<readonly OrgMember[] | null>(null);
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [dialogAbierto, setDialogAbierto] = useState(false);
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
      setError(err instanceof Error ? err.message : "No se pudo cargar el equipo.");
    }
  }

  async function handleRoleChange(memberId: string, nextRole: StaffVerticalRole) {
    setSavingRoleId(memberId);
    try {
      const updated = await updateStaffRole(fetch, apiBaseUrl, token, propertyId, memberId, nextRole);
      setMembers((prev) => (prev ? prev.map((m) => (m.id === memberId ? updated : m)) : prev));
      notify.success("Rol actualizado.");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "No se pudo cambiar el rol de esa persona.");
    } finally {
      setSavingRoleId(null);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, canManage]);

  async function handleCreate() {
    if (!email.trim()) return;
    setCreating(true);
    setLastCreated(null);
    try {
      const created = await createStaffInvite(fetch, apiBaseUrl, token, propertyId, { email: email.trim().toLowerCase(), verticalRole });
      setLastCreated(created);
      setEmail("");
      setDialogAbierto(false);
      notify.success("Invitación creada.");
      await load();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "No se pudo crear la invitación.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(inv: StaffInvite) {
    const ok = await confirmar({
      titulo: "Revocar invitación",
      descripcion: `La invitación para ${inv.email} dejará de funcionar. Esta acción no se puede deshacer.`,
      tono: "danger",
      confirmar: "Revocar",
    });
    if (!ok) return;
    setRevokingId(inv.id);
    try {
      await revokeStaffInvite(fetch, apiBaseUrl, token, propertyId, inv.id);
      if (lastCreated?.id === inv.id) setLastCreated(null);
      notify.success("Invitación revocada.");
      await load();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "No se pudo revocar la invitación.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader
        titulo="Equipo"
        descripcion="Invita a las personas de tu despacho y define su rol."
        acciones={
          canManage ? (
            <Button type="button" size="sm" onClick={() => setDialogAbierto(true)}>
              <MailPlus />
              Invitar
            </Button>
          ) : undefined
        }
      />

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {!canManage && (
        <EstadoVacio
          icon={Lock}
          titulo="Sin permiso"
          mensaje={`Invitar o revocar al equipo está reservado al administrador del despacho. Tu rol actual (${role}) no tiene acceso a esta página.`}
        />
      )}

      {canManage && lastCreated && (
        <Callout tone="success" titulo={`Invitación creada para ${lastCreated.email} (${ROLE_LABELS[lastCreated.verticalRole]})`}>
          <p>Ya se encoló un correo real con el enlace de activación. Si prefieres compartirlo tú mismo, aquí está el token — solo se muestra una vez.</p>
          <code className="mt-1.5 block break-all rounded-md border border-border bg-card px-2.5 py-2 font-mono text-xs text-foreground">{lastCreated.inviteToken}</code>
        </Callout>
      )}

      {canManage && (
        <section className="grid gap-2">
          <h2 className="text-sm font-medium text-foreground">Invitaciones pendientes</h2>
          {!invites && !error && <EstadoCargando etiqueta="Cargando invitaciones…" lineas={2} />}
          {invites && invites.length === 0 && <EstadoVacio mensaje="No hay ninguna invitación pendiente." />}
          {invites && invites.length > 0 && (
            <div className="flex flex-col gap-2">
              {invites.map((inv) => (
                <Card key={inv.id}>
                  <CardContent className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{inv.email}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {ROLE_LABELS[inv.verticalRole]} · {statusLabel(inv.status)} · expira {formatDateTime(inv.expiresAt)}
                      </p>
                    </div>
                    <Button type="button" variant="destructive" size="sm" className="shrink-0" onClick={() => void handleRevoke(inv)} loading={revokingId === inv.id}>
                      <Trash2 />
                      Revocar
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      {canManage && (
        <section className="grid gap-2">
          <h2 className="text-sm font-medium text-foreground">Equipo activo</h2>
          <p className="text-xs text-muted-foreground">
            Cambia el rol de una persona ya aceptada. No puedes tocar el rol de alguien con más alcance que el tuyo, ni asignar un rol por encima del tuyo, ni cambiar tu propio rol
            — el servidor lo rechaza aunque el rol aparezca en esta lista.
          </p>
          {!members && !error && <EstadoCargando etiqueta="Cargando equipo…" lineas={2} />}
          {members && members.length === 0 && <EstadoVacio mensaje="Todavía no hay nadie aceptado en este despacho." />}
          {members && members.length > 0 && (
            <div className="flex flex-col gap-2">
              {members.map((m) => (
                <Card key={m.id}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{m.fullName}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{m.email}</p>
                    </div>
                    <FormField label={`Rol de ${m.fullName}`} className="min-w-44 [&>label]:sr-only">
                      <NativeSelect value={m.verticalRole} disabled={savingRoleId === m.id} onChange={(e) => void handleRoleChange(m.id, e.target.value as StaffVerticalRole)} wrapperClassName="w-auto min-w-44">
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </NativeSelect>
                    </FormField>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      <FormDialog
        open={dialogAbierto}
        onOpenChange={(abierto) => {
          if (!creating) setDialogAbierto(abierto);
        }}
        titulo="Invitar a alguien nuevo"
        subtitulo="No podrás dar de alta a alguien con más alcance que el tuyo — el servidor lo rechaza (403) aunque el rol aparezca en esta lista."
        anchoClase="max-w-lg"
        onGuardar={() => void handleCreate()}
        guardando={creating}
        guardarDeshabilitado={!email.trim()}
        textoBotonGuardar="Invitar"
        bloquearCierre={creating}
      >
        <div className="grid gap-3">
          <FormField label="Correo" required>
            <Input type="email" placeholder="correo@ejemplo.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </FormField>
          <FormField label="Rol">
            <NativeSelect value={verticalRole} onChange={(e) => setVerticalRole(e.target.value as StaffVerticalRole)}>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        </div>
      </FormDialog>
      {dialogo}
    </PageContainer>
  );
}
