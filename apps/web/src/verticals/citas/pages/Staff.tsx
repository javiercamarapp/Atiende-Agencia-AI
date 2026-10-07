// Staff (Fase 12) — hallazgo de auditoría (CRÍTICO/ALTO, "citas define 3 roles de
// plataforma pero no los aplica en NINGUNA capa"): admin-staff.ts ya expone
// POST/GET/DELETE .../admin/staff/invitaciones, pero ningún panel los llamaba
// todavía. Esta página cierra ese hueco: crear una invitación, ver las pendientes
// (con su token para copiar/pegar) y revocar una pendiente — mismo patrón exacto
// que restaurantes/pages/Staff.tsx, sin la sección de "repartidores" (citas no
// tiene ese concepto). Gateada por `STAFF_INVITE_ROLES` (owner/admin) del lado del
// CLIENTE (cosmético, ver CitasShellContext.role) — el servidor (admin-staff.ts)
// es SIEMPRE el enforcement real, con la jerarquía fina de `canInviteStaff` encima.
//
// Presentación real (Fase de diseño): las secciones y las filas artesanales con
// hex en línea se cambian por Card/Table/Input/Label/Button/Badge de
// @atiende/ui. Las llamadas, el gateo por rol y las ramas condicionales son
// exactamente las mismas.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Lock, Send, ShieldCheck, Users } from "lucide-react";
import {
  StatusBadge,
  statusTone,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow, NativeSelect, useConfirm } from "@atiende/ui";
import { INVITE_STATUS_TONES } from "../lib/status-tones.ts";
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

// Alcance de cada rol: nadie puede tocar el rol de alguien con más alcance que el suyo ni asignar uno por encima del suyo.
const ROLE_RANK: Record<StaffVerticalRole, number> = { staff: 1, admin: 2, owner: 3 };

function rankOf(role: string): number {
  return ROLE_RANK[role as StaffVerticalRole] ?? 0;
}

function statusLabel(status: string): string {
  if (status === "pending") return "Pendiente";
  if (status === "accepted") return "Aceptada";
  if (status === "revoked") return "Revocada";
  if (status === "expired") return "Expirada";
  return status;
}

export function StaffPage({ apiBaseUrl, token, propertyId, role, staffEmail }: CitasShellContext) {
  const { confirmar, dialogo } = useConfirm();
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

  async function handleRoleChange(member: OrgMember, nextRole: StaffVerticalRole) {
    if (nextRole === member.verticalRole) return;
    const aceptado = await confirmar({
      titulo: "¿Cambiar el rol de esta persona?",
      descripcion: `${member.fullName} pasa de ${ROLE_LABELS[member.verticalRole]} a ${ROLE_LABELS[nextRole]} y sus permisos cambian de inmediato.`,
      confirmar: "Cambiar rol",
      cancelar: "Volver",
    });
    if (!aceptado) return;
    const memberId = member.id;
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
    const aceptado = await confirmar({
      titulo: "¿Revocar esta invitación?",
      descripcion: "El enlace de la invitación deja de funcionar. Si quieres volver a invitar a esa persona, tendrás que crear otra.",
      tono: "danger",
      confirmar: "Revocar invitación",
      cancelar: "Volver",
    });
    if (!aceptado) return;
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
    <div className="flex max-w-3xl flex-col gap-5">
      <h1 className="font-display text-xl font-semibold text-foreground">Staff</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {!canManage && (
        <Card className="bg-muted/40">
          <CardContent className="flex items-start gap-3 p-4">
            <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm leading-relaxed text-muted-foreground">
              Invitar o revocar staff está reservado a dueños y administradores. Con tu rol actual ({role}) no puedes gestionar el staff de este negocio.
            </p>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Invitar a alguien nuevo</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                <Label htmlFor="citas-staff-email">Correo</Label>
                <Input id="citas-staff-email" type="email" placeholder="correo@ejemplo.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="citas-staff-rol">Rol</Label>
                <NativeSelect id="citas-staff-rol" value={verticalRole} onChange={(e) => setVerticalRole(e.target.value as StaffVerticalRole)}>
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Button type="submit" disabled={creating}>
                <Send aria-hidden />
                {creating ? "Invitando…" : "Invitar"}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">
              No podrás dar de alta a alguien con más alcance que el tuyo — el servidor lo rechaza (403) aunque el rol aparezca en esta lista.
            </p>

            {lastCreated && (
              <div className="rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-sm font-semibold text-foreground">
                  Invitación creada para {lastCreated.email} ({ROLE_LABELS[lastCreated.verticalRole]})
                </p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Se le mandó un correo real con el enlace de activación. Si prefieres compartirlo tú mismo, aquí está el token — solo se muestra una vez.
                </p>
                <code className="mt-1.5 block break-all rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground">{lastCreated.inviteToken}</code>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Invitaciones pendientes</CardTitle>
          </CardHeader>
          <CardContent className={invites && invites.length > 0 ? "p-0" : undefined}>
            {!invites && !error && <EstadoCargando lineas={2} etiqueta="Cargando invitaciones…" />}
            {invites && invites.length === 0 && <EstadoVacio icon={ShieldCheck} mensaje="No hay ninguna invitación pendiente." />}
            {invites && invites.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Correo</TableHead>
                    <TableHead>Rol</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-right">Acción</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invites.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-semibold text-foreground">
                        {inv.email}
                        <span className="block text-xs font-normal text-muted-foreground">expira {new Date(inv.expiresAt).toLocaleString("es-MX")}</span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{ROLE_LABELS[inv.verticalRole]}</TableCell>
                      <TableCell>
                        <StatusBadge tone={statusTone(INVITE_STATUS_TONES, inv.status)}>{statusLabel(inv.status)}</StatusBadge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => void handleRevoke(inv.id)}
                          disabled={revokingId === inv.id}
                        >
                          {revokingId === inv.id ? "Revocando…" : "Revocar"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Staff activo</CardTitle>
            <CardDescription>
              Cambia el rol de un staff ya aceptado. No puedes tocar el rol de alguien con más alcance que el tuyo, ni asignar un rol por encima del tuyo, ni cambiar tu propio rol
              — el servidor lo rechaza aunque el rol aparezca en esta lista.
            </CardDescription>
          </CardHeader>
          <CardContent className={members && members.length > 0 ? "p-0" : undefined}>
            {!members && !error && <EstadoCargando lineas={2} etiqueta="Cargando staff…" />}
            {members && members.length === 0 && <EstadoVacio icon={Users} mensaje="Todavía no hay ningún staff aceptado en este negocio." />}
            {members && members.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Persona</TableHead>
                    <TableHead className="text-right">Rol</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((m) => {
                    // El servidor siempre rechaza cambiar tu propio rol o el de alguien con más alcance: el panel ni lo ofrece.
                    const esPropio = m.email.toLowerCase() === staffEmail.toLowerCase();
                    const sinAlcance = rankOf(m.verticalRole) > rankOf(role);
                    const opciones = ROLE_OPTIONS.filter((r) => rankOf(r) <= rankOf(role) || r === m.verticalRole);
                    return (
                    <TableRow key={m.id}>
                      <TableCell className="font-semibold text-foreground">
                        {m.fullName}
                        <span className="block text-xs font-normal text-muted-foreground">{m.email}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Label htmlFor={`citas-staff-rol-${m.id}`} className="sr-only">
                          Rol de {m.fullName}
                        </Label>
                        <NativeSelect
                          id={`citas-staff-rol-${m.id}`}
                          value={m.verticalRole}
                          disabled={savingRoleId === m.id || esPropio || sinAlcance}
                          onChange={(e) => void handleRoleChange(m, e.target.value as StaffVerticalRole)}
                        >
                          {opciones.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </NativeSelect>
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
      {dialogo}
    </div>
  );
}
