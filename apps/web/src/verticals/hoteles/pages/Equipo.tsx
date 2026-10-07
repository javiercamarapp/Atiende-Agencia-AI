// H-P3-05 -- Equipo de hoteles: invitar con uno de los 8 roles, ver y revocar invitaciones pendientes y ver al equipo activo (solo lectura).
// Misma composicion que rentas/pages/Equipo.tsx. Solo owner/gm (`STAFF_INVITE_ROLES`, cosmetico: el servidor aplica la jerarquia real de
// `canInviteStaff`: un gm nunca da de alta a un propietario). Revocar pasa por useConfirm: cancelar o cerrar el dialogo NUNCA llama al servidor.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Info, UserPlus } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, PageContainer, StatusBadge, statusTone, useConfirm } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { createStaffInvite, EQUIPO_ROLES, fetchOrgMembers, fetchStaffInvites, revokeStaffInvite, STAFF_ROLE_LABELS, STAFF_ROLE_OPTIONS } from "../lib/staff-client.ts";
import type { CreatedStaffInvite, OrgMember, StaffInvite, StaffVerticalRole } from "../lib/staff-client.ts";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const INVITE_STATUS_TONE: Readonly<Record<string, StatusTone>> = { pending: "warning", accepted: "success", revoked: "danger", expired: "neutral" };

function statusLabel(status: string): string {
  if (status === "pending") return "Pendiente";
  if (status === "accepted") return "Aceptada";
  if (status === "revoked") return "Revocada";
  if (status === "expired") return "Expirada";
  return status;
}

export function EquipoPage({ apiBaseUrl, token, propertyId, role, staffEmail }: HotelesShellContext) {
  const canManage = EQUIPO_ROLES.has(role);
  const { confirmar, dialogo } = useConfirm();

  const [invites, setInvites] = useState<readonly StaffInvite[] | null>(null);
  const [members, setMembers] = useState<readonly OrgMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [verticalRole, setVerticalRole] = useState<StaffVerticalRole>("frontdesk");
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

  async function handleRevoke(inv: StaffInvite) {
    const ok = await confirmar({ titulo: `Revocar la invitación a ${inv.email}`, descripcion: "El enlace deja de funcionar y no podrá activar su cuenta con él.", tono: "danger", confirmar: "Revocar" });
    if (!ok) return;
    setRevokingId(inv.id);
    setError(null);
    try {
      await revokeStaffInvite(fetch, apiBaseUrl, token, propertyId, inv.id);
      if (lastCreated?.id === inv.id) setLastCreated(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo revocar la invitación.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <PageContainer padding="none" size="md" className="gap-5 [&>*]:min-w-0">
      <h1 className="sr-only">Equipo</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {!canManage && (
        <Card className="bg-muted/40">
          <CardContent className="flex items-start gap-2 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span>Invitar o revocar al equipo está reservado al propietario y al gerente general. Con tu rol actual ({STAFF_ROLE_LABELS[role as StaffVerticalRole] ?? (role || "sin rol")}) no tienes acceso a esta página.</span>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader className="p-4 pb-3">
            <CardTitle className="text-sm font-semibold">Invitar a alguien nuevo</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="equipo-invitar-correo" className="text-xs text-muted-foreground">
                  Correo
                </Label>
                <Input id="equipo-invitar-correo" type="email" placeholder="correo@ejemplo.com" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-auto min-w-[220px]" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="equipo-invitar-rol" className="text-xs text-muted-foreground">
                  Rol
                </Label>
                <NativeSelect id="equipo-invitar-rol" value={verticalRole} onChange={(e) => setVerticalRole(e.target.value as StaffVerticalRole)} wrapperClassName="w-auto min-w-48">
                  {STAFF_ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {STAFF_ROLE_LABELS[r]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Button type="submit" loading={creating} disabled={creating}>
                <UserPlus />
                Invitar
              </Button>
            </form>
            <CardDescription className="mt-2 text-xs">Se envía un correo con el enlace para activar la cuenta (vence en 7 días). No puedes dar de alta a alguien con más alcance que el tuyo: el gerente general no invita propietarios.</CardDescription>

            {lastCreated && (
              <div className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
                <p className="m-0 mb-1.5 text-sm font-semibold text-foreground">
                  Invitación creada para {lastCreated.email} ({STAFF_ROLE_LABELS[lastCreated.verticalRole]})
                </p>
                <p className="m-0 mb-1.5 text-xs text-muted-foreground">
                  Le enviamos el correo. Si prefieres compartirle el token tú mismo, cópialo ahora: solo se muestra una vez. Debe pegarlo en <code className="rounded bg-muted px-1 py-0.5 font-mono">/aceptar-invitacion</code> junto con su nombre y una contraseña.
                </p>
                <code className="block break-all rounded-md border border-border bg-card px-2.5 py-2 font-mono text-xs text-foreground">{lastCreated.inviteToken}</code>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <section className="flex flex-col gap-2">
          <p className="m-0 text-sm font-semibold text-foreground">Invitaciones pendientes</p>
          {!invites && !error && <EstadoCargando etiqueta="Cargando invitaciones…" />}
          {invites && invites.length === 0 && <EstadoVacio mensaje="No hay ninguna invitación pendiente." />}
          {invites && invites.length > 0 && (
            <div className="flex flex-col gap-2">
              {invites.map((inv) => (
                <Card key={inv.id}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div>
                      <p className="m-0 text-sm font-semibold text-foreground">{inv.email}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <StatusBadge tone="neutral" dot={false}>
                          {STAFF_ROLE_LABELS[inv.verticalRole] ?? inv.verticalRole}
                        </StatusBadge>
                        <StatusBadge tone={statusTone(INVITE_STATUS_TONE, inv.status)}>{statusLabel(inv.status)}</StatusBadge>
                        <span>· expira {fechaHoraEsMx(inv.expiresAt)}</span>
                      </div>
                    </div>
                    <Button type="button" variant="destructive" size="sm" className="h-9 text-xs" onClick={() => void handleRevoke(inv)} loading={revokingId === inv.id} disabled={revokingId === inv.id}>
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
        <section className="flex flex-col gap-2">
          <p className="m-0 text-sm font-semibold text-foreground">Equipo activo</p>
          <p className="m-0 text-xs text-muted-foreground">Personas que ya aceptaron su invitación. Cambiar el rol o dar de baja a alguien aún no está disponible desde esta pantalla.</p>
          {!members && !error && <EstadoCargando etiqueta="Cargando equipo…" />}
          {members && members.length === 0 && <EstadoVacio mensaje="Todavía no hay nadie en el equipo." />}
          {members && members.length > 0 && (
            <div className="flex flex-col gap-2">
              {members.map((m) => (
                <Card key={m.id}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div>
                      <p className="m-0 text-sm font-semibold text-foreground">
                        {m.fullName}
                        {m.email === staffEmail && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(tú)</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{m.email}</p>
                    </div>
                    <StatusBadge tone="neutral" dot={false}>
                      {STAFF_ROLE_LABELS[m.verticalRole] ?? m.verticalRole}
                    </StatusBadge>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}
      {dialogo}
    </PageContainer>
  );
}
