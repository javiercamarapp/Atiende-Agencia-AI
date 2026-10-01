// Rn-20 -- Equipo: invitar, cambiar el rol y dar de baja al staff de la gestora (rentas era la única vertical sin esta
// pantalla; sin ella no se podía dar de alta a limpieza, al contador ni a un operador). Port de
// verticals/restaurantes/pages/Staff.tsx sobre los 6 roles de rentas. Solo admin_gestora (`STAFF_INVITE_ROLES`, cosmético:
// el servidor y `core.update_membership_role`/`core.remove_membership` aplican la jerarquía real de `canInviteStaff`, el
// bloqueo de auto-cambio/auto-baja y la protección del último administrador).
//
// Acciones destructivas (dar de baja, revocar, cambiar un rol) pasan por useConfirm: cancelar o cerrar el diálogo NUNCA
// llama al servidor.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Info, UserPlus } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, PageContainer, StatusBadge, statusTone, useConfirm } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { createStaffInvite, fetchOrgMembers, fetchStaffInvites, removeStaffMember, revokeStaffInvite, STAFF_ROLE_LABELS, STAFF_ROLE_OPTIONS, updateStaffRole } from "../lib/staff-client.ts";
import type { CreatedStaffInvite, OrgMember, StaffInvite, StaffVerticalRole } from "../lib/staff-client.ts";
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo dar de baja a esa persona.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <PageContainer padding="none" size="md" className="gap-5 [&>*]:min-w-0">
      <h1 className="m-0 font-display text-xl font-semibold text-foreground">Equipo</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {!canManage && (
        <Card className="bg-muted/40">
          <CardContent className="flex items-start gap-2 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span>Invitar, cambiar el rol o dar de baja al equipo está reservado a la administradora de la gestora. Con tu rol actual ({rol || "sin rol"}) no tienes acceso a esta página.</span>
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
              <Button type="submit" disabled={creating}>
                <UserPlus />
                {creating ? "Invitando…" : "Invitar"}
              </Button>
            </form>
            <CardDescription className="mt-2 text-xs">Se envía un correo con el enlace para activar la cuenta (vence en 7 días). No puedes dar de alta a alguien con más alcance que el tuyo.</CardDescription>

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
                        <span>· expira {new Date(inv.expiresAt).toLocaleString("es-MX")}</span>
                      </div>
                    </div>
                    <Button type="button" variant="destructive" size="sm" className="h-9 text-xs" onClick={() => void handleRevoke(inv)} disabled={revokingId === inv.id}>
                      {revokingId === inv.id ? "Revocando…" : "Revocar"}
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
          <p className="m-0 text-xs text-muted-foreground">
            Cambia el rol de alguien ya aceptado o dalo de baja. No puedes tocar a alguien con más alcance que el tuyo, cambiar tu propio rol, darte de baja a ti misma ni dejar la organización sin ninguna administradora — el servidor lo rechaza aunque la opción aparezca aquí.
          </p>
          {!members && !error && <EstadoCargando etiqueta="Cargando equipo…" />}
          {members && members.length === 0 && <EstadoVacio mensaje="Todavía no hay nadie en el equipo." />}
          {members && members.length > 0 && (
            <div className="flex flex-col gap-2">
              {members.map((m) => {
                const esUnoMismo = m.email === session.email;
                return (
                  <Card key={m.id}>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                      <div>
                        <p className="m-0 text-sm font-semibold text-foreground">{m.fullName}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{m.email}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <NativeSelect
                          aria-label={`Rol de ${m.fullName}`}
                          value={m.verticalRole}
                          disabled={savingRoleId === m.id || esUnoMismo}
                          onChange={(e) => void handleRoleChange(m, e.target.value as StaffVerticalRole)}
                          wrapperClassName="w-auto min-w-48"
                        >
                          {STAFF_ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {STAFF_ROLE_LABELS[r]}
                            </option>
                          ))}
                        </NativeSelect>
                        <Button type="button" variant="destructive" size="sm" className="h-9 text-xs" onClick={() => void handleRemove(m)} disabled={removingId === m.id || esUnoMismo} title={esUnoMismo ? "No puedes darte de baja a ti misma." : undefined}>
                          {removingId === m.id ? "Dando de baja…" : "Dar de baja"}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      )}
      {dialogo}
    </PageContainer>
  );
}
