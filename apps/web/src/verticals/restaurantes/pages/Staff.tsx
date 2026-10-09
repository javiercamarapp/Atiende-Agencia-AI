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
//
// Presentación (DS v2, PR-5): primitivos de `@atiende/ui` — `Card` para cada bloque y
// cada fila, `FormDialog`/`FormField`/`Input`/`Selector` para el alta (abierta desde el CTA de cabecera) y el rol
// de cada miembro, `Button` para invitar/revocar, `Badge` para el rol y `StatusBadge`
// para el estado de cada invitación, `useConfirm` para la baja y `PageContainer` como
// contenedor. Todos los gates de rol, fetches y payloads de abajo son los MISMOS.
import { useEffect, useState } from "react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormDialog,
  FormField,
  Input,
  Selector,
  PageContainer,
  StatusBadge,
  statusTone,
  useConfirm,
} from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { UserPlus, UserRoundCog } from "lucide-react";
import {
  createStaffInvite,
  fetchOrgMembers,
  fetchRepartidores,
  fetchStaffInvites,
  removeStaffMember,
  revokeStaffInvite,
  updateStaffRole,
} from "../lib/staff-client.ts";
import type { CreatedStaffInvite, OrgMember, RepartidorMember, StaffInvite, StaffVerticalRole } from "../lib/staff-client.ts";
import { PerfilRepartidorDialogo } from "../components/PerfilRepartidorDialogo.tsx";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const STAFF_INVITE_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

const ROLE_LABELS: Record<StaffVerticalRole, string> = {
  owner: "Dueño",
  admin: "Administrador",
  staff: "Staff (gestión)",
  repartidor: "Repartidor",
};

const ROLE_OPTIONS: readonly StaffVerticalRole[] = ["admin", "staff", "repartidor", "owner"];

const INVITE_STATUS_TONE: Readonly<Record<string, StatusTone>> = {
  pending: "warning",
  accepted: "success",
  revoked: "danger",
  expired: "neutral",
};

function statusLabel(status: string): string {
  if (status === "pending") return "Pendiente";
  if (status === "accepted") return "Aceptada";
  if (status === "revoked") return "Revocada";
  if (status === "expired") return "Expirada";
  return status;
}

export function StaffPage({ apiBaseUrl, token, propertyId, role, staffEmail }: RestaurantesShellContext) {
  const canManage = STAFF_INVITE_ROLES.has(role);
  const { confirmar, dialogo } = useConfirm();

  const [invites, setInvites] = useState<readonly StaffInvite[] | null>(null);
  const [repartidores, setRepartidores] = useState<readonly RepartidorMember[] | null>(null);
  // Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
  // restaurantes permite gestionar roles desde el producto"): verificado contra el
  // código real que ni siquiera restaurantes podía cambiar el rol de un staff YA
  // ACEPTADO — todo lo de arriba (invites/repartidores) solo cubre alta o lectura.
  const [members, setMembers] = useState<readonly OrgMember[] | null>(null);
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  // FASE 3 (producto) -- baja de un staff YA aceptado (ver removeStaffMember en
  // lib/staff-client.ts).
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [verticalRole, setVerticalRole] = useState<StaffVerticalRole>("staff");
  const [creating, setCreating] = useState(false);
  // El alta de staff vive en un FormDialog que abre el CTA de cabecera (UNI-C); su error se muestra DENTRO del diálogo
  // (el global `error` quedaría tapado por el modal) y el correo vacío se marca en el campo.
  const [dialogoInvitar, setDialogoInvitar] = useState(false);
  const [errorInvitar, setErrorInvitar] = useState<string | null>(null);
  const [errorCorreo, setErrorCorreo] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<CreatedStaffInvite | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // R-15: perfil operativo del repartidor (solo owner/admin; FormDialog con su propia carga y guardado).
  const [perfilDe, setPerfilDe] = useState<RepartidorMember | null>(null);

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

  // FASE 3 (producto) -- el servidor (admin-staff.ts::DELETE miembroItemPath) es
  // SIEMPRE el enforcement real (auto-baja/jerarquía/último owner) -- este
  // diálogo de confirmación es solo para evitar un clic accidental, nunca la única
  // barrera.
  async function handleRemove(member: OrgMember) {
    const ok = await confirmar({
      titulo: `Dar de baja a ${member.fullName}`,
      descripcion: "Pierde acceso a esta organización de inmediato.",
      tono: "danger",
      confirmar: "Dar de baja",
    });
    if (!ok) return;
    setRemovingId(member.id);
    setError(null);
    try {
      await removeStaffMember(fetch, apiBaseUrl, token, propertyId, member.id);
      setMembers((prev) => (prev ? prev.filter((m) => m.id !== member.id) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo dar de baja a ese staff.");
    } finally {
      setRemovingId(null);
    }
  }

  function abrirInvitar() {
    setEmail("");
    setVerticalRole("staff");
    setErrorInvitar(null);
    setErrorCorreo(null);
    setDialogoInvitar(true);
  }

  async function handleCreate() {
    if (!email.trim()) {
      setErrorCorreo("Escribe el correo de la persona a invitar.");
      return;
    }
    setErrorCorreo(null);
    setCreating(true);
    setErrorInvitar(null);
    setError(null);
    setLastCreated(null);
    try {
      const created = await createStaffInvite(fetch, apiBaseUrl, token, propertyId, { email: email.trim().toLowerCase(), verticalRole });
      setLastCreated(created);
      setEmail("");
      setDialogoInvitar(false);
      await load();
    } catch (err) {
      setErrorInvitar(err instanceof Error ? err.message : "No se pudo crear la invitación.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(invite: StaffInvite) {
    const ok = await confirmar({
      titulo: `Revocar la invitación de ${invite.email}`,
      descripcion: "La persona ya no podrá aceptarla con el token que recibió.",
      tono: "danger",
      confirmar: "Revocar",
    });
    if (!ok) return;
    const inviteId = invite.id;
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
    <PageContainer padding="none">
      <h1 className="sr-only">Staff</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {!canManage && (
        <Callout tone="info">Invitar o revocar staff está reservado a dueños y administradores. Con tu rol actual ({role}) solo puedes ver a los repartidores ya activos.</Callout>
      )}

      {canManage && (
        <div className="flex justify-end">
          <Button type="button" onClick={abrirInvitar}>
            <UserPlus />
            Invitar a alguien
          </Button>
        </div>
      )}

      {canManage && lastCreated && (
        <Callout tone="success" titulo={`Invitación creada para ${lastCreated.email} (${ROLE_LABELS[lastCreated.verticalRole]})`}>
          <p className="m-0 mb-1.5 text-xs text-muted-foreground">
            Compártele este token — solo se muestra una vez. Debe pegarlo en <code className="rounded bg-muted px-1 py-0.5 font-mono">/aceptar-invitacion</code> junto con su nombre y una
            contraseña.
          </p>
          <code className="block break-all rounded-md border border-border bg-card px-2.5 py-2 font-mono text-xs text-foreground">{lastCreated.inviteToken}</code>
        </Callout>
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
                        <StatusBadge tone="neutral" dot={false}>{ROLE_LABELS[inv.verticalRole]}</StatusBadge>
                        <StatusBadge tone={statusTone(INVITE_STATUS_TONE, inv.status)}>{statusLabel(inv.status)}</StatusBadge>
                        <span>· expira {new Date(inv.expiresAt).toLocaleString("es-MX")}</span>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => void handleRevoke(inv)}
                      loading={revokingId === inv.id}
                    >
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
          <p className="m-0 text-sm font-semibold text-foreground">Staff activo</p>
          <p className="m-0 text-xs text-muted-foreground">
            Cambia el rol de un staff ya aceptado, o dalo de baja por completo. No puedes tocar a alguien con más alcance que el tuyo, ni cambiar tu propio rol, ni darte de baja
            a ti mismo, ni dejar la organización sin ningún dueño — el servidor lo rechaza aunque la opción aparezca aquí.
          </p>
          {!members && !error && <EstadoCargando etiqueta="Cargando staff…" />}
          {members && members.length === 0 && <EstadoVacio mensaje="Todavía no hay ningún staff aceptado en esta organización." />}
          {members && members.length > 0 && (
            <div className="flex flex-col gap-2">
              {members.map((m) => {
                const esUnoMismo = m.email === staffEmail;
                return (
                  <Card key={m.id}>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                      <div>
                        <p className="m-0 text-sm font-semibold text-foreground">{m.fullName}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{m.email}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Selector
                          aria-label={`Rol de ${m.fullName}`}
                          value={m.verticalRole}
                          disabled={savingRoleId === m.id}
                          onChange={(e) => void handleRoleChange(m.id, e.target.value as StaffVerticalRole)}
                          wrapperClassName="w-auto min-w-40"
                        >
                          {ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </Selector>
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          onClick={() => void handleRemove(m)}
                          loading={removingId === m.id}
                          disabled={esUnoMismo}
                          title={esUnoMismo ? "No puedes darte de baja a ti mismo." : undefined}
                        >
                          Dar de baja
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

      <section className="flex flex-col gap-2">
        <p className="m-0 text-sm font-semibold text-foreground">Repartidores activos</p>
        {!repartidores && !error && <EstadoCargando etiqueta="Cargando repartidores…" />}
        {repartidores && repartidores.length === 0 && <EstadoVacio mensaje="Todavía no hay ningún repartidor aceptado en esta organización." />}
        {repartidores && repartidores.length > 0 && (
          <div className="flex flex-col gap-2">
            {repartidores.map((r) => (
              <Card key={r.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div>
                    <p className="m-0 text-sm font-semibold text-foreground">{r.fullName}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{r.email}</p>
                  </div>
                  {canManage && (
                    <Button type="button" variant="outline" size="sm" onClick={() => setPerfilDe(r)}>
                      <UserRoundCog />
                      Perfil
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
      <FormDialog
        open={dialogoInvitar}
        onOpenChange={setDialogoInvitar}
        titulo="Invitar a alguien nuevo"
        subtitulo="Le llega un token para crear su cuenta con el rol que elijas."
        anchoClase="max-w-2xl"
        onGuardar={() => void handleCreate()}
        guardando={creating}
        textoBotonGuardar="Invitar"
        bloquearCierre={creating}
      >
        <div className="grid gap-3">
          {errorInvitar && <Callout tone="danger">{errorInvitar}</Callout>}
          <FormField label="Correo" required error={errorCorreo}>
            <Input type="email" placeholder="correo@ejemplo.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </FormField>
          <FormField label="Rol" hint="No podrás dar de alta a alguien con más alcance que el tuyo — el servidor lo rechaza (403) aunque el rol aparezca en esta lista.">
            <Selector value={verticalRole} onChange={(e) => setVerticalRole(e.target.value as StaffVerticalRole)}>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Selector>
          </FormField>
        </div>
      </FormDialog>
      {canManage && (
        <PerfilRepartidorDialogo
          open={perfilDe !== null}
          onOpenChange={(abierto) => {
            if (!abierto) setPerfilDe(null);
          }}
          repartidor={perfilDe}
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
          confirmar={confirmar}
        />
      )}
      {dialogo}
    </PageContainer>
  );
}
