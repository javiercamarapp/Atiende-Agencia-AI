// Rn-20 -- Equipo: invitar, cambiar el rol y dar de baja al staff de la gestora (rentas era la única vertical sin esta
// pantalla; sin ella no se podía dar de alta a limpieza, al contador ni a un operador). Port de
// verticals/restaurantes/pages/Staff.tsx sobre los 6 roles de rentas. Solo admin_gestora (`STAFF_INVITE_ROLES`, cosmético:
// el servidor y `core.update_membership_role`/`core.remove_membership` aplican la jerarquía real de `canInviteStaff`, el
// bloqueo de auto-cambio/auto-baja y la protección del último administrador).
//
// Acciones destructivas (dar de baja, revocar, cambiar un rol) pasan por useConfirm: cancelar o cerrar el diálogo NUNCA
// llama al servidor.
// UNI-C-rentas: PageHeader (único h1), Cards con CardTitle limpio, FormField + Button loading, DataTable, Callout, notify
// y fechas con el formateador único (fechaHoraEsMx).
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { UserPlus } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, FormField, Input, NativeSelect, notify, PageContainer, PageHeader, StatusBadge, statusTone, useConfirm } from "@atiende/ui";
import type { DataTableColumna, StatusTone } from "@atiende/ui";
import { createStaffInvite, fetchOrgMembers, fetchStaffInvites, removeStaffMember, revokeStaffInvite, STAFF_ROLE_LABELS, STAFF_ROLE_OPTIONS, updateStaffRole } from "../lib/staff-client.ts";
import type { CreatedStaffInvite, OrgMember, StaffInvite, StaffVerticalRole } from "../lib/staff-client.ts";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

// Espejo web de STAFF_INVITE_ROLES (packages/domain-rentas/src/roles.ts).
const STAFF_INVITE_ROLES: ReadonlySet<string> = new Set(["admin_gestora"]);

const INVITE_STATUS_TONE: Readonly<Record<string, StatusTone>> = { pending: "warning", accepted: "success", revoked: "danger", expired: "neutral" };

function statusLabel(status: string): string {
  if (status === "pending") return "Pendiente";
  if (status === "accepted") return "Aceptada";
  if (status === "revoked") return "Revocada";
  if (status === "expired") return "Expirada";
  return status;
}

export function EquipoPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const rol = org?.rol ?? "";
  const canManage = STAFF_INVITE_ROLES.has(rol);
  const { confirmar, dialogo } = useConfirm();

  const [invites, setInvites] = useState<readonly StaffInvite[] | null>(null);
  const [members, setMembers] = useState<readonly OrgMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [verticalRole, setVerticalRole] = useState<StaffVerticalRole>("limpieza");
  const [creating, setCreating] = useState(false);
  const [lastCreated, setLastCreated] = useState<CreatedStaffInvite | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

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
      notify.success("Invitación creada.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la invitación.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(inv: StaffInvite) {
    const ok = await confirmar({ titulo: `Revocar la invitación a ${inv.email}`, descripcion: "El enlace deja de funcionar y no podrá activar su cuenta con él.", tono: "danger", confirmar: "Revocar" });
    if (!ok) return;
    setRevokingId(inv.id);
    setError(null);
    try {
      await revokeStaffInvite(fetch, apiBaseUrl, token, propertyId, inv.id);
      if (lastCreated?.id === inv.id) setLastCreated(null);
      notify.success("Invitación revocada.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo revocar la invitación.");
    } finally {
      setRevokingId(null);
    }
  }

  async function handleRoleChange(m: OrgMember, nextRole: StaffVerticalRole) {
    if (nextRole === m.verticalRole) return;
    const ok = await confirmar({
      titulo: `Cambiar el rol de ${m.fullName}`,
      descripcion: `Pasa de ${STAFF_ROLE_LABELS[m.verticalRole]} a ${STAFF_ROLE_LABELS[nextRole]}. Cambia lo que puede ver y hacer desde su próximo inicio de sesión.`,
      confirmar: "Cambiar rol",
    });
    if (!ok) return;
    setSavingRoleId(m.id);
    setError(null);
    try {
      const updated = await updateStaffRole(fetch, apiBaseUrl, token, propertyId, m.id, nextRole);
      setMembers((prev) => (prev ? prev.map((x) => (x.id === m.id ? updated : x)) : prev));
      notify.success(`Rol de ${m.fullName} actualizado.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el rol de esa persona.");
    } finally {
      setSavingRoleId(null);
    }
  }

  async function handleRemove(m: OrgMember) {
    const ok = await confirmar({ titulo: `Dar de baja a ${m.fullName}`, descripcion: "Pierde acceso a esta organización de inmediato.", tono: "danger", confirmar: "Dar de baja" });
    if (!ok) return;
    setRemovingId(m.id);
    setError(null);
    try {
      await removeStaffMember(fetch, apiBaseUrl, token, propertyId, m.id);
      setMembers((prev) => (prev ? prev.filter((x) => x.id !== m.id) : prev));
      notify.success(`${m.fullName} ya no tiene acceso.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo dar de baja a esa persona.");
    } finally {
      setRemovingId(null);
    }
  }

  const columnasInvitaciones: readonly DataTableColumna<StaffInvite>[] = [
    { id: "correo", encabezado: "Correo", principal: true, valorOrden: (i) => i.email, celda: (i) => <span className="font-medium text-foreground">{i.email}</span> },
    { id: "rol", encabezado: "Rol", celda: (i) => <StatusBadge tone="neutral" dot={false}>{STAFF_ROLE_LABELS[i.verticalRole] ?? i.verticalRole}</StatusBadge> },
    { id: "estado", encabezado: "Estado", celda: (i) => <StatusBadge tone={statusTone(INVITE_STATUS_TONE, i.status)}>{statusLabel(i.status)}</StatusBadge> },
    { id: "expira", encabezado: "Expira", valorOrden: (i) => i.expiresAt, celda: (i) => <span className="text-muted-foreground">{fechaHoraEsMx(i.expiresAt)}</span> },
    {
      id: "acciones",
      encabezado: "Acciones",
      alinear: "right",
      celda: (i) => (
        <Button type="button" variant="destructive" size="sm" aria-label={`Revocar la invitación a ${i.email}`} onClick={() => void handleRevoke(i)} loading={revokingId === i.id} loadingText="Revocando…">
          Revocar
        </Button>
      ),
    },
  ];

  const columnasMiembros: readonly DataTableColumna<OrgMember>[] = [
    {
      id: "persona",
      encabezado: "Persona",
      principal: true,
      valorOrden: (m) => m.fullName,
      celda: (m) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">{m.fullName}</span>
          <span className="text-xs text-muted-foreground">{m.email}</span>
        </div>
      ),
    },
    {
      id: "rol",
      encabezado: "Rol",
      celda: (m) => (
        <NativeSelect
          aria-label={`Rol de ${m.fullName}`}
          value={m.verticalRole}
          disabled={savingRoleId === m.id || m.email === session.email}
          onChange={(e) => void handleRoleChange(m, e.target.value as StaffVerticalRole)}
          wrapperClassName="w-auto min-w-48"
        >
          {STAFF_ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {STAFF_ROLE_LABELS[r]}
            </option>
          ))}
        </NativeSelect>
      ),
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      alinear: "right",
      celda: (m) => {
        const esUnoMismo = m.email === session.email;
        return (
          <Button type="button" variant="destructive" size="sm" aria-label={`Dar de baja a ${m.fullName}`} onClick={() => void handleRemove(m)} loading={removingId === m.id} loadingText="Dando de baja…" disabled={esUnoMismo} title={esUnoMismo ? "No puedes darte de baja a ti misma." : undefined}>
            Dar de baja
          </Button>
        );
      },
    },
  ];

  return (
    <PageContainer>
      <PageHeader titulo="Equipo" descripcion="Invita, cambia el rol y da de baja al staff de la gestora." />

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {!canManage && (
        <Callout tone="info" titulo="Acceso reservado a la administradora">
          Invitar, cambiar el rol o dar de baja al equipo está reservado a la administradora de la gestora. Con tu rol actual ({rol || "sin rol"}) no tienes acceso a esta página.
        </Callout>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Invitar a alguien nuevo</CardTitle>
            <CardDescription>Se envía un correo con el enlace para activar la cuenta (vence en 7 días). No puedes dar de alta a alguien con más alcance que el tuyo.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2.5">
              <FormField label="Correo" id="equipo-invitar-correo" className="min-w-[220px]">
                <Input type="email" placeholder="correo@ejemplo.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </FormField>
              <FormField label="Rol" id="equipo-invitar-rol">
                <NativeSelect value={verticalRole} onChange={(e) => setVerticalRole(e.target.value as StaffVerticalRole)} wrapperClassName="w-auto min-w-48">
                  {STAFF_ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {STAFF_ROLE_LABELS[r]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <Button type="submit" loading={creating} loadingText="Invitando…">
                <UserPlus /> Invitar
              </Button>
            </form>

            {lastCreated && (
              <Callout tone="success" titulo={`Invitación creada para ${lastCreated.email} (${STAFF_ROLE_LABELS[lastCreated.verticalRole]})`} className="mt-3" onDismiss={() => setLastCreated(null)}>
                Le enviamos el correo. Si prefieres compartirle el token tú mismo, cópialo ahora: solo se muestra una vez. Debe pegarlo en <code className="rounded bg-canvas px-1 py-0.5 font-mono">/aceptar-invitacion</code> junto con su nombre y una contraseña.
                <code className="mt-1.5 block break-all rounded-md border border-border bg-card px-2.5 py-2 font-mono text-xs text-foreground">{lastCreated.inviteToken}</code>
              </Callout>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Invitaciones pendientes</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!invites && !error && <EstadoCargando etiqueta="Cargando invitaciones…" />}
            {invites && <DataTable etiqueta="Invitaciones del equipo" columnas={columnasInvitaciones} filas={invites} obtenerId={(i) => i.id} vacio={{ titulo: "Sin invitaciones", mensaje: "No hay ninguna invitación pendiente." }} />}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Equipo activo</CardTitle>
            <CardDescription>
              Cambia el rol de alguien ya aceptado o dalo de baja. No puedes tocar a alguien con más alcance que el tuyo, cambiar tu propio rol, darte de baja a ti misma ni dejar la organización sin ninguna administradora: el servidor lo rechaza aunque la opción aparezca aquí.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {!members && !error && <EstadoCargando etiqueta="Cargando equipo…" />}
            {members && <DataTable etiqueta="Equipo activo" columnas={columnasMiembros} filas={members} obtenerId={(m) => m.id} vacio={{ titulo: "Sin equipo", mensaje: "Todavía no hay nadie en el equipo." }} />}
          </CardContent>
        </Card>
      )}
      {dialogo}
    </PageContainer>
  );
}
