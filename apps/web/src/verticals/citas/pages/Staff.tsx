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
  TableRow, NativeSelect, etiquetasTraducidas, localeActivo, traductorActivo, useT } from "@atiende/ui";
import { citasStaff } from "@atiende/ui/i18n/citas/staff";
import { INVITE_STATUS_TONES } from "../lib/status-tones.ts";
import { createStaffInvite, fetchOrgMembers, fetchStaffInvites, revokeStaffInvite, updateStaffRole } from "../lib/staff-client.ts";
import type { CreatedStaffInvite, OrgMember, StaffInvite, StaffVerticalRole } from "../lib/staff-client.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const STAFF_INVITE_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Etiqueta de cada rol en el idioma activo (cada lectura traduce). */
const ROLE_LABELS: Readonly<Record<StaffVerticalRole, string>> = etiquetasTraducidas<StaffVerticalRole>(["owner", "admin", "staff"], (r) => `citas.staff.rol.${r}` as const, citasStaff);

const ROLE_OPTIONS: readonly StaffVerticalRole[] = ["admin", "staff", "owner"];

const tr = traductorActivo(citasStaff);

function statusLabel(status: string): string {
  if (status === "pending" || status === "accepted" || status === "revoked" || status === "expired") return tr(`citas.staff.estado.${status}`);
  return status;
}

export function StaffPage({ apiBaseUrl, token, propertyId, role }: CitasShellContext) {
  const t = useT(citasStaff);
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
      setError(err instanceof Error ? err.message : t("citas.staff.errorCargar"));
    }
  }

  async function handleRoleChange(memberId: string, nextRole: StaffVerticalRole) {
    setSavingRoleId(memberId);
    setError(null);
    try {
      const updated = await updateStaffRole(fetch, apiBaseUrl, token, propertyId, memberId, nextRole);
      setMembers((prev) => (prev ? prev.map((m) => (m.id === memberId ? updated : m)) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("citas.staff.errorRol"));
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
      setError(err instanceof Error ? err.message : t("citas.staff.errorInvitar"));
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
      setError(err instanceof Error ? err.message : t("citas.staff.errorRevocar"));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <h1 className="font-display text-xl font-semibold text-foreground">{t("citas.staff.titulo")}</h1>

      {error && <EstadoError mensaje={error} />}

      {!canManage && (
        <Card className="bg-muted/40">
          <CardContent className="flex items-start gap-3 p-4">
            <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("citas.staff.sinPermiso", { rol: role })}
            </p>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("citas.staff.invitarTitulo")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                <Label htmlFor="citas-staff-email">{t("citas.staff.correo")}</Label>
                <Input id="citas-staff-email" type="email" placeholder={t("citas.staff.correoPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="citas-staff-rol">{t("citas.staff.rol")}</Label>
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
                {creating ? t("citas.staff.invitando") : t("citas.staff.invitar")}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">
              {t("citas.staff.alcance")}
            </p>

            {lastCreated && (
              <div className="rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-sm font-semibold text-foreground">
                  {t("citas.staff.creada", { correo: lastCreated.email, rol: ROLE_LABELS[lastCreated.verticalRole] })}
                </p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t("citas.staff.creadaNota")}
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
            <CardTitle className="text-base">{t("citas.staff.pendientes")}</CardTitle>
          </CardHeader>
          <CardContent className={invites && invites.length > 0 ? "p-0" : undefined}>
            {!invites && !error && <EstadoCargando lineas={2} etiqueta={t("citas.staff.cargandoInvitaciones")} />}
            {invites && invites.length === 0 && <EstadoVacio icon={ShieldCheck} mensaje={t("citas.staff.sinInvitaciones")} />}
            {invites && invites.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("citas.staff.correo")}</TableHead>
                    <TableHead>{t("citas.staff.rol")}</TableHead>
                    <TableHead>{t("citas.staff.col.estado")}</TableHead>
                    <TableHead className="text-right">{t("citas.staff.col.accion")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invites.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-semibold text-foreground">
                        {inv.email}
                        <span className="block text-xs font-normal text-muted-foreground">{t("citas.staff.expira", { fecha: new Date(inv.expiresAt).toLocaleString(localeActivo()) })}</span>
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
                          {revokingId === inv.id ? t("citas.staff.revocando") : t("citas.staff.revocar")}
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
            <CardTitle className="text-base">{t("citas.staff.activo")}</CardTitle>
            <CardDescription>{t("citas.staff.activoDesc")}</CardDescription>
          </CardHeader>
          <CardContent className={members && members.length > 0 ? "p-0" : undefined}>
            {!members && !error && <EstadoCargando lineas={2} etiqueta={t("citas.staff.cargandoStaff")} />}
            {members && members.length === 0 && <EstadoVacio icon={Users} mensaje={t("citas.staff.sinStaff")} />}
            {members && members.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("citas.staff.col.persona")}</TableHead>
                    <TableHead className="text-right">{t("citas.staff.rol")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="font-semibold text-foreground">
                        {m.fullName}
                        <span className="block text-xs font-normal text-muted-foreground">{m.email}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Label htmlFor={`citas-staff-rol-${m.id}`} className="sr-only">
                          {t("citas.staff.rolDe", { nombre: m.fullName })}
                        </Label>
                        <NativeSelect
                          id={`citas-staff-rol-${m.id}`}
                          value={m.verticalRole}
                          disabled={savingRoleId === m.id}
                          onChange={(e) => void handleRoleChange(m.id, e.target.value as StaffVerticalRole)}
                        >
                          {ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </NativeSelect>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
