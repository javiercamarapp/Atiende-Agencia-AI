// Staff — hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
// restaurantes permite gestionar roles desde el producto"): verificado contra el
// código real que licitaciones tenía `admin-staff.ts` (POST/GET/DELETE
// invitaciones, ver el hallazgo de auditoría original "alta de organización/staff
// imposible sin SQL") construido desde una fase anterior, pero NINGÚN panel lo
// llamaba todavía — a diferencia de restaurantes/despachos/citas, que ya tenían su
// propio Staff.tsx desde su respectiva Fase 14. Esta página cierra ese hueco
// completo: crear una invitación, ver las pendientes, revocar una pendiente, Y
// (el hallazgo específico de esta pasada) cambiar el rol de un staff ya aceptado.
// Port EXACTO de apps/web/src/verticals/restaurantes/pages/Staff.tsx (leído
// primero como plantilla) sobre los 6 roles de licitaciones, sin la sección de
// "repartidores" (licitaciones no tiene ese concepto).
//
// Gateada por `STAFF_INVITE_ROLES` (owner/admin) del lado del CLIENTE (cosmético,
// ver `LicitacionesShellContext.role`) — el servidor (admin-staff.ts) es SIEMPRE
// el enforcement real, con la jerarquía fina de `canInviteStaff` encima.
//
// Fase "sistema de diseño real" (contenido) — secciones a `Card`, botones a
// `Button`, el input de correo a `Input`, los `<select>` de rol siguen nativos
// (restilados con tokens), el estatus de cada invitación a `Badge` y los
// estados vacío/cargando a `EstadoVacio`/`EstadoCargando`. Cero cambios de
// lógica ni de red.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Mail, UserPlus } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label } from "@atiende/ui";
import { createStaffInvite, fetchOrgMembers, fetchStaffInvites, revokeStaffInvite, updateStaffRole } from "../lib/staff-client.ts";
import type { CreatedStaffInvite, OrgMember, StaffInvite, StaffVerticalRole } from "../lib/staff-client.ts";
import { fetchTenantConfig, updateTenantConfigTimezone } from "../lib/admin-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const STAFF_INVITE_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

const ROLE_LABELS: Record<StaffVerticalRole, string> = {
  owner: "Dueño/a",
  admin: "Administrador/a",
  analyst: "Analista",
  writer: "Redactor/a",
  reviewer: "Revisor/a",
  viewer: "Solo lectura",
};

const ROLE_OPTIONS: readonly StaffVerticalRole[] = ["analyst", "writer", "reviewer", "viewer", "admin", "owner"];

function statusLabel(status: string): string {
  if (status === "pending") return "Pendiente";
  if (status === "accepted") return "Aceptada";
  if (status === "revoked") return "Revocada";
  if (status === "expired") return "Expirada";
  return status;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "accepted") return "default";
  if (status === "revoked" || status === "expired") return "destructive";
  return "secondary";
}

/** `<select>` sigue siendo nativo (el sistema no exporta un primitivo propio):
 * solo se restila con los tokens reales. */
const SELECT_NATIVO =
  "h-11 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export function StaffPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const canManage = STAFF_INVITE_ROLES.has(role);

  const [invites, setInvites] = useState<readonly StaffInvite[] | null>(null);
  const [members, setMembers] = useState<readonly OrgMember[] | null>(null);
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // FASE 3 (producto) — zona horaria por negocio: UI mínima owner/admin (mismo
  // umbral `canManage`/`STAFF_INVITE_ROLES` de esta página). `timezone === null`
  // (sin fila todavía, o borrada explícitamente) se ve en el input como texto
  // vacío -- el placeholder deja claro cuál es el default real que aplica
  // mientras tanto, nunca un valor inventado en el campo.
  const [timezone, setTimezone] = useState<string | null>(null);
  const [timezoneInput, setTimezoneInput] = useState("");
  const [timezoneLoaded, setTimezoneLoaded] = useState(false);
  const [savingTimezone, setSavingTimezone] = useState(false);
  const [timezoneError, setTimezoneError] = useState<string | null>(null);
  const [timezoneSavedAt, setTimezoneSavedAt] = useState<number | null>(null);

  const [email, setEmail] = useState("");
  const [verticalRole, setVerticalRole] = useState<StaffVerticalRole>("analyst");
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
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, canManage]);

  async function loadTimezone() {
    if (!canManage) return;
    setTimezoneError(null);
    try {
      const config = await fetchTenantConfig(fetch, apiBaseUrl, token, orgSlug);
      setTimezone(config.timezone);
      setTimezoneInput(config.timezone ?? "");
    } catch (err) {
      setTimezoneError(err instanceof Error ? err.message : "No se pudo cargar la zona horaria.");
    } finally {
      setTimezoneLoaded(true);
    }
  }

  useEffect(() => {
    void loadTimezone();
  }, [apiBaseUrl, token, orgSlug, canManage]);

  async function handleSaveTimezone(e: FormEvent) {
    e.preventDefault();
    setSavingTimezone(true);
    setTimezoneError(null);
    setTimezoneSavedAt(null);
    try {
      // Texto vacío = borrar (`timezone: null`) -- vuelve al default de plataforma,
      // nunca se manda un string vacío como si fuera un timezone real.
      const trimmed = timezoneInput.trim();
      const updated = await updateTenantConfigTimezone(fetch, apiBaseUrl, token, orgSlug, trimmed.length > 0 ? trimmed : null);
      setTimezone(updated.timezone);
      setTimezoneInput(updated.timezone ?? "");
      setTimezoneSavedAt(Date.now());
    } catch (err) {
      setTimezoneError(err instanceof Error ? err.message : "No se pudo guardar la zona horaria.");
    } finally {
      setSavingTimezone(false);
    }
  }

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
    <div className="flex max-w-[760px] flex-col gap-5">
      <h1 className="text-xl font-semibold text-foreground">Staff</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {!canManage && (
        <p className="rounded-xl border border-border bg-muted p-3 text-[13px] text-muted-foreground">
          Invitar, revocar, o cambiar el rol de staff está reservado a dueños y administradores. Con tu rol actual ({role}) no puedes gestionar el staff de esta empresa.
        </p>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Zona horaria de la empresa</CardTitle>
            <CardDescription>
              Se usa para calcular "hoy" en vigencias de tarifas, facturación y alertas de renovación — nunca para reinterpretar el plazo legal ya fijado en las bases de una convocatoria (ese lo declara
              quien convoca, no tu empresa). Un plazo ya calculado y comunicado con la zona anterior NO se recalcula: este cambio aplica solo hacia adelante.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {timezoneError && <EstadoError mensaje={timezoneError} onReintentar={() => void loadTimezone()} />}
            {!timezoneLoaded && !timezoneError && <EstadoCargando lineas={1} etiqueta="Cargando zona horaria…" />}
            {timezoneLoaded && (
              <form onSubmit={handleSaveTimezone} className="flex flex-wrap items-end gap-2">
                <div className="flex min-w-[260px] flex-1 flex-col gap-1.5">
                  <Label htmlFor="tenant-timezone">Timezone IANA (ej. "America/Mexico_City", "America/Tijuana")</Label>
                  <Input
                    id="tenant-timezone"
                    type="text"
                    placeholder="America/Mexico_City (default de plataforma, sin configurar)"
                    value={timezoneInput}
                    onChange={(e) => setTimezoneInput(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{timezone ? `Configurada: ${timezone}` : "Sin configurar todavía — se usa el default de plataforma (America/Mexico_City)."} Deja el campo vacío y guarda para borrarla.</p>
                </div>
                <Button type="submit" size="sm" disabled={savingTimezone}>
                  {savingTimezone ? "Guardando…" : "Guardar"}
                </Button>
              </form>
            )}
            {timezoneSavedAt !== null && <p className="text-xs text-muted-foreground">Guardado.</p>}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invitar a alguien nuevo</CardTitle>
            <CardDescription>No podrás dar de alta a alguien con más alcance que el tuyo — el servidor lo rechaza (403) aunque el rol aparezca en esta lista.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                <Label htmlFor="staff-email">Correo</Label>
                <Input id="staff-email" type="email" placeholder="correo@ejemplo.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="staff-rol">Rol</Label>
                <select id="staff-rol" value={verticalRole} onChange={(e) => setVerticalRole(e.target.value as StaffVerticalRole)} className={SELECT_NATIVO}>
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" size="sm" disabled={creating}>
                <UserPlus />
                {creating ? "Invitando…" : "Invitar"}
              </Button>
            </form>

            {lastCreated && (
              <div className="rounded-xl border border-border bg-muted p-3">
                <p className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                  <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                  Invitación creada para {lastCreated.email} ({ROLE_LABELS[lastCreated.verticalRole]})
                </p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Se le mandó un correo real con el enlace de activación. Si prefieres compartirlo tú mismo, aquí está el token — solo se muestra una vez.
                </p>
                <code className="mt-1.5 block break-all rounded-md border border-border bg-card px-2.5 py-2 font-mono text-xs text-foreground">{lastCreated.inviteToken}</code>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invitaciones pendientes</CardTitle>
          </CardHeader>
          <CardContent>
            {!invites && !error && <EstadoCargando lineas={2} etiqueta="Cargando invitaciones…" />}
            {invites && invites.length === 0 && <EstadoVacio mensaje="No hay ninguna invitación pendiente." />}
            {invites && invites.length > 0 && (
              <div className="flex flex-col gap-2">
                {invites.map((inv) => (
                  <div key={inv.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-foreground">{inv.email}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span>{ROLE_LABELS[inv.verticalRole]}</span>
                        <Badge variant={statusVariant(inv.status)}>{statusLabel(inv.status)}</Badge>
                        <span>· expira {new Date(inv.expiresAt).toLocaleString("es-MX")}</span>
                      </p>
                    </div>
                    <Button type="button" variant="outline" size="sm" className="text-destructive" onClick={() => void handleRevoke(inv.id)} disabled={revokingId === inv.id}>
                      {revokingId === inv.id ? "Revocando…" : "Revocar"}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Staff activo</CardTitle>
            <CardDescription>
              Cambia el rol de un staff ya aceptado. No puedes tocar el rol de alguien con más alcance que el tuyo, ni asignar un rol por encima del tuyo, ni cambiar tu propio rol
              — el servidor lo rechaza aunque el rol aparezca en esta lista.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!members && !error && <EstadoCargando lineas={2} etiqueta="Cargando staff activo…" />}
            {members && members.length === 0 && <EstadoVacio mensaje="Todavía no hay ningún staff aceptado en esta empresa." />}
            {members && members.length > 0 && (
              <div className="flex flex-col gap-2">
                {members.map((m) => (
                  <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-foreground">{m.fullName}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{m.email}</p>
                    </div>
                    <select
                      value={m.verticalRole}
                      disabled={savingRoleId === m.id}
                      onChange={(e) => void handleRoleChange(m.id, e.target.value as StaffVerticalRole)}
                      aria-label={`Rol de ${m.fullName}`}
                      className={SELECT_NATIVO}
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}
