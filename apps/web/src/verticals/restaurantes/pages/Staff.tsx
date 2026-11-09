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
  PageHeader,
  StatusBadge,
  statusTone,
  etiquetasTraducidas,
  localeActivo,
  useConfirm,
  useT,
} from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { restaurantesStaff } from "@atiende/ui/i18n/restaurantes/staff";
import { Smartphone, UserPlus, UserRoundCog } from "lucide-react";
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
import { TelefonoAccesoDialogo } from "../components/TelefonoAccesoDialogo.tsx";
import { fetchTelefonosAcceso } from "../lib/login-telefono-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const STAFF_INVITE_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

// Etiquetas en el idioma activo (i18n): cada lectura traduce; en espanol, los textos de siempre.
const ROLE_LABELS: Readonly<Record<StaffVerticalRole, string>> = etiquetasTraducidas<StaffVerticalRole>(
  ["owner", "admin", "staff", "repartidor"],
  (r) => `restaurantes.staff.rol.${r}` as const,
  restaurantesStaff,
);
const ESTADO_INVITACION = etiquetasTraducidas<"pending" | "accepted" | "revoked" | "expired">(
  ["pending", "accepted", "revoked", "expired"],
  (s) => `restaurantes.staff.estado.${s}` as const,
  restaurantesStaff,
);

const ROLE_OPTIONS: readonly StaffVerticalRole[] = ["admin", "staff", "repartidor", "owner"];

const INVITE_STATUS_TONE: Readonly<Record<string, StatusTone>> = {
  pending: "warning",
  accepted: "success",
  revoked: "danger",
  expired: "neutral",
};

function statusLabel(status: string): string {
  if (status === "pending" || status === "accepted" || status === "revoked" || status === "expired") return ESTADO_INVITACION[status];
  return status;
}

export function StaffPage({ apiBaseUrl, token, propertyId, role, staffEmail }: RestaurantesShellContext) {
  const t = useT(restaurantesStaff);
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
  // Celular de acceso (login del repartidor por WhatsApp): null = la base aun no lo soporta -> el control se oculta (nada de maquetas).
  const [telefonos, setTelefonos] = useState<ReadonlyMap<string, string> | null>(null);
  const [telefonoDe, setTelefonoDe] = useState<RepartidorMember | null>(null);

  async function cargarTelefonos() {
    try {
      const filas = await fetchTelefonosAcceso(fetch, apiBaseUrl, token, propertyId);
      setTelefonos(new Map(filas.map((f) => [f.userId, f.telefonoEnmascarado])));
    } catch {
      setTelefonos(null);
    }
  }

  async function load() {
    setError(null);
    try {
      // `fetchRepartidores` está gateado por MANAGER_ROLES (owner/admin/staff, más
      // amplio) en el servidor -- se pide siempre. `fetchStaffInvites`/
      // `fetchOrgMembers` están gateados por STAFF_INVITE_ROLES (owner/admin, más
      // angosto) -- solo se piden cuando `canManage` ya lo anticipa, para no
      // disparar un 403 esperado en cada carga.
      setRepartidores(await fetchRepartidores(fetch, apiBaseUrl, token, propertyId));
      void cargarTelefonos();
      if (canManage) {
        setInvites(await fetchStaffInvites(fetch, apiBaseUrl, token, propertyId));
        setMembers(await fetchOrgMembers(fetch, apiBaseUrl, token, propertyId));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.staff.errorCargar"));
    }
  }

  async function handleRoleChange(memberId: string, nextRole: StaffVerticalRole) {
    setSavingRoleId(memberId);
    setError(null);
    try {
      const updated = await updateStaffRole(fetch, apiBaseUrl, token, propertyId, memberId, nextRole);
      setMembers((prev) => (prev ? prev.map((m) => (m.id === memberId ? updated : m)) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.staff.errorRol"));
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
      titulo: t("restaurantes.staff.bajaTitulo", { nombre: member.fullName }),
      descripcion: t("restaurantes.staff.bajaDesc"),
      tono: "danger",
      confirmar: t("restaurantes.staff.darDeBaja"),
    });
    if (!ok) return;
    setRemovingId(member.id);
    setError(null);
    try {
      await removeStaffMember(fetch, apiBaseUrl, token, propertyId, member.id);
      setMembers((prev) => (prev ? prev.filter((m) => m.id !== member.id) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.staff.errorBaja"));
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
      setErrorCorreo(t("restaurantes.staff.errorCorreo"));
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
      setErrorInvitar(err instanceof Error ? err.message : t("restaurantes.staff.errorInvitacion"));
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(invite: StaffInvite) {
    const ok = await confirmar({
      titulo: t("restaurantes.staff.revocarTitulo", { correo: invite.email }),
      descripcion: t("restaurantes.staff.revocarDesc"),
      tono: "danger",
      confirmar: t("restaurantes.staff.revocar"),
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
      setError(err instanceof Error ? err.message : t("restaurantes.staff.errorRevocar"));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <PageContainer padding="none">
      <PageHeader
        titulo={t("restaurantes.staff.titulo")}
        acciones={
          canManage ? (
            <Button type="button" onClick={abrirInvitar}>
              <UserPlus />
              {t("restaurantes.staff.invitar")}
            </Button>
          ) : undefined
        }
      />

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {!canManage && (
        <Callout tone="info">{t("restaurantes.staff.soloLectura", { rol: role })}</Callout>
      )}


      {canManage && lastCreated && (
        <Callout tone="success" titulo={t("restaurantes.staff.invitacionCreada", { correo: lastCreated.email, rol: ROLE_LABELS[lastCreated.verticalRole] })}>
          <p className="m-0 mb-1.5 text-xs text-muted-foreground">
            {t("restaurantes.staff.compartirToken")}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              {
                // i18n-ignorar: es la ruta de la pantalla, no texto.
                "/aceptar-invitacion"
              }
            </code>

            {t("restaurantes.staff.compartirTokenFin")}
          </p>
          <code className="block break-all rounded-md border border-border bg-card px-2.5 py-2 font-mono text-xs text-foreground">{lastCreated.inviteToken}</code>
        </Callout>
      )}

      {canManage && (
        <section className="flex flex-col gap-2">
          <p className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.staff.pendientes")}</p>
          {!invites && !error && <EstadoCargando etiqueta={t("restaurantes.staff.cargandoInvitaciones")} />}
          {invites && invites.length === 0 && <EstadoVacio mensaje={t("restaurantes.staff.sinInvitaciones")} />}
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
                        <span>{t("restaurantes.staff.expira", { fecha: new Date(inv.expiresAt).toLocaleString(localeActivo()) })}</span>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => void handleRevoke(inv)}
                      loading={revokingId === inv.id}
                    >
                      {t("restaurantes.staff.revocar")}
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
          <p className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.staff.activo")}</p>
          <p className="m-0 text-xs text-muted-foreground">{t("restaurantes.staff.activoAyuda")}</p>
          {!members && !error && <EstadoCargando etiqueta={t("restaurantes.staff.cargandoStaff")} />}
          {members && members.length === 0 && <EstadoVacio mensaje={t("restaurantes.staff.sinStaff")} />}
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
                          aria-label={t("restaurantes.staff.rolDe", { nombre: m.fullName })}
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
                          title={esUnoMismo ? t("restaurantes.staff.noTiMismo") : undefined}
                        >
                          {t("restaurantes.staff.darDeBaja")}
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
        <p className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.staff.repartidoresActivos")}</p>
        {!repartidores && !error && <EstadoCargando etiqueta={t("restaurantes.staff.cargandoRepartidores")} />}
        {repartidores && repartidores.length === 0 && <EstadoVacio mensaje={t("restaurantes.staff.sinRepartidores")} />}
        {repartidores && repartidores.length > 0 && (
          <div className="flex flex-col gap-2">
            {repartidores.map((r) => (
              <Card key={r.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div>
                    <p className="m-0 text-sm font-semibold text-foreground">{r.fullName}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{r.email}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {telefonos && (
                      <Button type="button" variant="outline" size="sm" onClick={() => setTelefonoDe(r)}>
                        <Smartphone />
                        {telefonos.has(r.id) ? t("restaurantes.staff.celularValor", { telefono: telefonos.get(r.id) ?? "" }) : t("restaurantes.staff.celularAcceso")}
                      </Button>
                    )}
                    {canManage && (
                      <Button type="button" variant="outline" size="sm" onClick={() => setPerfilDe(r)}>
                        <UserRoundCog />
                        {t("restaurantes.staff.perfil")}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
      <FormDialog
        open={dialogoInvitar}
        onOpenChange={setDialogoInvitar}
        titulo={t("restaurantes.staff.invitarNuevo")}
        subtitulo={t("restaurantes.staff.invitarSub")}
        anchoClase="max-w-2xl"
        onGuardar={() => void handleCreate()}
        guardando={creating}
        textoBotonGuardar={t("restaurantes.staff.invitarBoton")}
        bloquearCierre={creating}
      >
        <div className="grid gap-3">
          {errorInvitar && <Callout tone="danger">{errorInvitar}</Callout>}
          <FormField label={t("restaurantes.staff.correo")} required error={errorCorreo}>
            <Input type="email" placeholder={t("restaurantes.staff.correoEjemplo")} value={email} onChange={(e) => setEmail(e.target.value)} />
          </FormField>
          <FormField label={t("restaurantes.staff.rol")} hint={t("restaurantes.staff.rolAyuda")}>

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
      {telefonos && (
        <TelefonoAccesoDialogo
          open={telefonoDe !== null}
          onOpenChange={(abierto) => {
            if (!abierto) setTelefonoDe(null);
          }}
          repartidor={telefonoDe}
          telefonoEnmascarado={telefonoDe ? (telefonos.get(telefonoDe.id) ?? null) : null}
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
          onCambio={() => void cargarTelefonos()}
        />
      )}
      {dialogo}
    </PageContainer>
  );
}
