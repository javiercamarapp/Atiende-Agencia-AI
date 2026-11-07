// Seccion "Equipo" de la ficha de una organizacion (alta del equipo inicial por superadmin, SA-L-26 minimo, go-live G-07).
// Backend real: GET/POST /superadmin/organizaciones/:id/invitaciones, POST .../:inviteId/reenviar y DELETE .../:inviteId (migracion 0053; las
// mutaciones piden motivo >= 20 y step-up MFA). Cancelar y Escape NUNCA llaman al servidor. El correo llega enmascarado; el enlace de
// activacion se muestra UNA sola vez, justo despues de crear o reenviar. Estados: cargando, error con reintento, "no disponible aun" (base sin la
// migracion) y vacio con la accion de invitar al primer dueno.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Copy, MailPlus, RefreshCw, Trash2, Users } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, Checkbox, ConfirmDialog, EstadoCargando, EstadoError, EstadoVacio, FormDialog, Input, Label, NativeSelect, StatusBadge, Textarea, notify, traductorActivo, useT } from "@atiende/ui";
import { comun } from "@atiende/ui/i18n/comun";
import { superadminComun } from "@atiende/ui/i18n/superadmin/comun";
import { superadminEquipo } from "@atiende/ui/i18n/superadmin/equipo";
import { fechaHoraEsMx } from "../../lib/formato-fecha.ts";
import { fetchConStepUp } from "../lib/stepup.ts";
import { MOTIVO_EQUIPO_MINIMO, nombreRolEquipo, rolesEquipoDe } from "../lib/equipo.ts";
import type { EquipoInvitacion, RespuestaEquipo, ResultadoInvitacion } from "../lib/equipo.ts";

// Textos fuera de React (errores de red, etiqueta de sucursales): siguen al idioma activo; los componentes usan `useT`.
const tr = traductorActivo(superadminComun, superadminEquipo);

type Carga = { readonly estado: "cargando" } | { readonly estado: "error"; readonly mensaje: string } | { readonly estado: "ok"; readonly datos: RespuestaEquipo };

interface RespuestaApi {
  readonly ok: boolean;
  readonly status: number;
  readonly code: string | null;
  readonly mensaje: string;
  readonly cuerpo: unknown;
}

/** Llama a la API del equipo (con step-up) y devuelve el codigo de error de la API para distinguir, p. ej., el segundo owner. */
async function llamar(apiBaseUrl: string, token: string, path: string, init: RequestInit = {}): Promise<RespuestaApi> {
  try {
    const res = await fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    });
    const cuerpo = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    return { ok: res.ok, status: res.status, code: cuerpo?.code ?? null, mensaje: cuerpo?.message ?? tr("superadmin.comun.error.solicitud"), cuerpo };
  } catch {
    return { ok: false, status: 0, code: null, mensaje: tr("superadmin.equipo.error.conexion"), cuerpo: null };
  }
}

function etiquetaSucursales(ids: readonly string[] | null, nombres: ReadonlyMap<string, string>): string {
  if (ids === null) return tr("superadmin.equipo.todasSucursales");
  return ids.map((id) => nombres.get(id) ?? tr("superadmin.equipo.sucursal")).join(", ");
}

export function EquipoOrganizacion({ apiBaseUrl, token, organizacionId }: { readonly apiBaseUrl: string; readonly token: string; readonly organizacionId: string }) {
  const t = useT(comun, superadminComun, superadminEquipo);
  const base = `/superadmin/organizaciones/${encodeURIComponent(organizacionId)}/invitaciones`;
  const [carga, setCarga] = useState<Carga>({ estado: "cargando" });
  const [invitando, setInvitando] = useState(false);
  const [reenviando, setReenviando] = useState<EquipoInvitacion | null>(null);
  const [revocando, setRevocando] = useState<EquipoInvitacion | null>(null);
  const [enlace, setEnlace] = useState<ResultadoInvitacion | null>(null);

  const cargar = useCallback(async () => {
    setCarga({ estado: "cargando" });
    const r = await llamar(apiBaseUrl, token, base);
    if (!r.ok) {
      setCarga({ estado: "error", mensaje: tr(r.status === 404 ? "superadmin.equipo.error.noEncontrada" : "superadmin.equipo.error.cargar") });
      return;
    }
    const datos = r.cuerpo as RespuestaEquipo | null;
    // Una respuesta que no tiene la forma esperada (proxy, version vieja) es un error de carga, no un estado inventado.
    if (!datos || !Array.isArray(datos.miembros) || !Array.isArray(datos.invitaciones) || !Array.isArray(datos.sucursales)) {
      setCarga({ estado: "error", mensaje: tr("superadmin.equipo.error.formato") });
      return;
    }
    setCarga({ estado: "ok", datos });
  }, [apiBaseUrl, token, base]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const datos = carga.estado === "ok" ? carga.datos : null;
  const nombres = new Map((datos?.sucursales ?? []).map((s) => [s.id, s.nombre] as const));
  const hayOwner = datos ? datos.miembros.some((m) => m.platformRole === "owner") || datos.invitaciones.some((i) => i.platformRole === "owner" && !i.vencida) : false;
  const puedeInvitar = datos?.disponible === true;

  const reenviar = async (motivo?: string) => {
    if (!reenviando) return;
    const texto = (motivo ?? "").trim();
    if (texto.length < MOTIVO_EQUIPO_MINIMO) return;
    const r = await llamar(apiBaseUrl, token, `${base}/${encodeURIComponent(reenviando.id)}/reenviar`, { method: "POST", body: JSON.stringify({ motivo: texto }) });
    if (!r.ok) {
      notify.error(r.mensaje);
      throw new Error(r.mensaje);
    }
    setEnlace(r.cuerpo as ResultadoInvitacion);
    notify.success(t("superadmin.equipo.reenviada"));
    setReenviando(null);
    void cargar();
  };

  const revocar = async (motivo?: string) => {
    if (!revocando) return;
    const texto = (motivo ?? "").trim();
    if (texto.length < MOTIVO_EQUIPO_MINIMO) return;
    const r = await llamar(apiBaseUrl, token, `${base}/${encodeURIComponent(revocando.id)}`, { method: "DELETE", body: JSON.stringify({ motivo: texto }) });
    if (!r.ok) {
      notify.error(r.mensaje);
      throw new Error(r.mensaje);
    }
    notify.success(t("superadmin.equipo.revocada"));
    setRevocando(null);
    void cargar();
  };

  const copiar = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      notify.success(t("superadmin.equipo.copiado"));
    } catch {
      notify.error(t("superadmin.equipo.noCopiado"));
    }
  };

  return (
    <Card className="min-w-0" data-seccion="equipo">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4" strokeWidth={1.75} aria-hidden="true" />
          {t("superadmin.equipo.titulo")}
        </CardTitle>
        {puedeInvitar && (
          <Button type="button" size="sm" className="gap-1.5" onClick={() => setInvitando(true)}>
            <MailPlus className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            {t("superadmin.equipo.invitar")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {carga.estado === "cargando" && <EstadoCargando etiqueta={t("superadmin.equipo.cargando")} />}
        {carga.estado === "error" && <EstadoError compacto titulo={t("superadmin.equipo.error.titulo")} mensaje={carga.mensaje} onReintentar={() => void cargar()} />}
        {datos && !datos.disponible && (
          <Callout tone="warning" role="status">
            {datos.mensaje}
          </Callout>
        )}

        {enlace && (
          <Callout tone="info" role="status" data-testid="enlace-activacion">
            <p className="font-medium">{t("superadmin.equipo.enlacePara", { correo: enlace.invitacion.correo })}</p>
            <p className="text-xs text-muted-foreground">
              {t("superadmin.equipo.unaVez")} {t(enlace.correoEncolado ? "superadmin.equipo.correoEncolado" : "superadmin.equipo.correoNoEncolado")}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Input readOnly aria-label={t("superadmin.equipo.enlace")} value={enlace.acceptUrl} onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={() => void copiar(enlace.acceptUrl)}>
                <Copy className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                {t("superadmin.equipo.copiar")}
              </Button>
              <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setEnlace(null)}>
                {t("superadmin.equipo.listo")}
              </Button>
            </div>
          </Callout>
        )}

        {datos?.disponible && (
          <>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("superadmin.equipo.miembrosN", { n: datos.miembros.length })}</p>
              {datos.miembros.length === 0 ? (
                <EstadoVacio compacto titulo={t("superadmin.equipo.sinMiembrosTitulo")} mensaje={t("superadmin.equipo.sinMiembros")} />
              ) : (
                <ul className="divide-y divide-dashed divide-line2" aria-label={t("superadmin.equipo.miembros")}>
                  {datos.miembros.map((m) => (
                    <li key={m.userId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 text-ui">
                      <span className="min-w-0">
                        <span className="block truncate text-foreground">{m.correo}</span>
                        <span className="block truncate text-xs text-muted-foreground">{etiquetaSucursales(m.propertyIds, nombres)}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <StatusBadge tone="neutral">{nombreRolEquipo(datos.vertical, m.rol)}</StatusBadge>
                        <span className="text-xs text-muted-foreground">{t("superadmin.equipo.alta", { fecha: fechaHoraEsMx(m.altaEn) })}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("superadmin.equipo.invitacionesN", { n: datos.invitaciones.length })}</p>
              {datos.invitaciones.length === 0 ? (
                <p className="py-1.5 text-ui text-muted-foreground">{t("superadmin.equipo.sinInvitaciones")}</p>
              ) : (
                <ul className="divide-y divide-dashed divide-line2" aria-label={t("superadmin.equipo.invitaciones")}>
                  {datos.invitaciones.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-1.5 text-ui" data-invitacion={i.id}>
                      <span className="min-w-0">
                        <span className="block truncate text-foreground">{i.correo}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {nombreRolEquipo(datos.vertical, i.rol)} · {etiquetaSucursales(i.propertyIds, nombres)} · {i.vencida ? t("superadmin.equipo.vencida") : t("superadmin.equipo.vence", { fecha: fechaHoraEsMx(i.venceEn) })}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setReenviando(i)}>
                          <RefreshCw className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                          {t("superadmin.equipo.reenviar")}
                          <span className="sr-only"> {t("superadmin.equipo.srA", { correo: i.correo })}</span>
                        </Button>
                        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setRevocando(i)}>
                          <Trash2 className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                          {t("superadmin.equipo.revocar")}
                          <span className="sr-only"> {t("superadmin.equipo.srA", { correo: i.correo })}</span>
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>

      {datos?.disponible && (
        <FormularioInvitar
          open={invitando}
          onOpenChange={setInvitando}
          apiBaseUrl={apiBaseUrl}
          token={token}
          base={base}
          sucursales={datos.sucursales}
          vertical={datos.vertical}
          hayOwner={hayOwner}
          onCreada={(r) => {
            setEnlace(r);
            setInvitando(false);
            notify.success(t("superadmin.equipo.creada"));
            void cargar();
          }}
        />
      )}

      <ConfirmDialog
        open={reenviando !== null}
        onOpenChange={(v) => !v && setReenviando(null)}
        titulo={t("superadmin.equipo.reenviarTitulo")}
        descripcion={reenviando ? t("superadmin.equipo.reenviarDescripcion", { correo: reenviando.correo }) : undefined}
        confirmar={t("superadmin.equipo.reenviar")}
        campo={{ etiqueta: t("superadmin.comun.col.motivo"), ayuda: t("superadmin.comun.motivoAyuda", { n: MOTIVO_EQUIPO_MINIMO }), multilinea: true, minLength: MOTIVO_EQUIPO_MINIMO, maxLength: 500 }}
        onConfirm={reenviar}
      />
      <ConfirmDialog
        open={revocando !== null}
        onOpenChange={(v) => !v && setRevocando(null)}
        titulo={t("superadmin.equipo.revocarTitulo")}
        tono="danger"
        descripcion={revocando ? t("superadmin.equipo.revocarDescripcion", { correo: revocando.correo }) : undefined}
        confirmar={t("superadmin.equipo.revocar")}
        campo={{ etiqueta: t("superadmin.comun.col.motivo"), ayuda: t("superadmin.comun.motivoAyuda", { n: MOTIVO_EQUIPO_MINIMO }), multilinea: true, minLength: MOTIVO_EQUIPO_MINIMO, maxLength: 500 }}
        onConfirm={revocar}
      />
    </Card>
  );
}

function FormularioInvitar({
  open,
  onOpenChange,
  apiBaseUrl,
  token,
  base,
  sucursales,
  vertical,
  hayOwner,
  onCreada,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly base: string;
  readonly sucursales: RespuestaEquipo["sucursales"];
  readonly vertical: string | undefined;
  readonly hayOwner: boolean;
  readonly onCreada: (r: ResultadoInvitacion) => void;
}) {
  const t = useT(comun, superadminComun, superadminEquipo);
  const roles = rolesEquipoDe(vertical);
  const rolDueno = roles.find((r) => r.esDueno)?.valor ?? "owner";
  const [email, setEmail] = useState("");
  const [rol, setRol] = useState(rolDueno);
  const [elegidas, setElegidas] = useState<ReadonlySet<string>>(new Set());
  const [motivo, setMotivo] = useState("");
  const [segundoOwner, setSegundoOwner] = useState(false);
  const [pideConfirmacion, setPideConfirmacion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (open) {
      setEmail("");
      setRol(rolDueno);
      setElegidas(new Set());
      setMotivo("");
      setSegundoOwner(false);
      setPideConfirmacion(false);
      setError(null);
      setGuardando(false);
    }
  }, [open, rolDueno]);

  const mostrarSegundoOwner = roles.some((r) => r.valor === rol && r.esDueno) && (hayOwner || pideConfirmacion);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError(t("superadmin.equipo.error.correo"));
    if (motivo.trim().length < MOTIVO_EQUIPO_MINIMO) return setError(t("superadmin.equipo.error.motivo", { n: MOTIVO_EQUIPO_MINIMO }));
    if (mostrarSegundoOwner && !segundoOwner) return setError(t("superadmin.equipo.error.segundoOwner"));
    setError(null);
    setGuardando(true);
    const r = await llamar(apiBaseUrl, token, base, {
      method: "POST",
      body: JSON.stringify({
        email: email.trim(),
        verticalRole: rol,
        ...(elegidas.size > 0 ? { propertyIds: [...elegidas] } : {}),
        motivo: motivo.trim(),
        ...(segundoOwner ? { confirmarSegundoOwner: true } : {}),
      }),
    });
    setGuardando(false);
    if (r.ok) return onCreada(r.cuerpo as ResultadoInvitacion);
    if (r.code === "segundo_owner_requiere_confirmacion") setPideConfirmacion(true);
    setError(r.mensaje);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      titulo={t("superadmin.equipo.form.titulo")}
      subtitulo={t("superadmin.equipo.form.subtitulo")}
      anchoClase="max-w-lg"
      bloquearCierre={guardando}
      footer={
        <>
          <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => onOpenChange(false)} disabled={guardando}>
            {t("comun.cancelar")}
          </Button>
          <Button type="submit" form="form-invitar-equipo" className="rounded-full px-6" disabled={guardando}>
            {guardando ? t("superadmin.equipo.invitando") : t("superadmin.equipo.invitar")}
          </Button>
        </>
      }
    >
      <form id="form-invitar-equipo" onSubmit={(ev) => void enviar(ev)} className="flex flex-col gap-3" noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="equipo-email">{t("superadmin.equipo.form.correo")}</Label>
          <Input id="equipo-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("superadmin.equipo.form.correoPlaceholder")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="equipo-rol">{t("superadmin.equipo.form.rol")}</Label>
          <NativeSelect id="equipo-rol" value={rol} onChange={(e) => setRol(e.target.value)}>
            {roles.map((r) => (
              <option key={r.valor} value={r.valor}>
                {r.nombre}
              </option>
            ))}
          </NativeSelect>
        </div>
        {sucursales.length > 0 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-ui font-medium text-foreground">{t("superadmin.equipo.form.sucursales")}</legend>
            <p className="text-xs text-muted-foreground">{t("superadmin.equipo.form.sucursalesAyuda")}</p>
            {sucursales.map((s) => (
              <Checkbox
                key={s.id}
                label={s.nombre}
                checked={elegidas.has(s.id)}
                onChange={(e) =>
                  setElegidas((previas) => {
                    const sig = new Set(previas);
                    if (e.target.checked) sig.add(s.id);
                    else sig.delete(s.id);
                    return sig;
                  })
                }
              />
            ))}
          </fieldset>
        )}
        {mostrarSegundoOwner && (
          <Checkbox label={t("superadmin.equipo.form.segundoOwner")} descripcion={t("superadmin.equipo.form.segundoOwnerAyuda")} checked={segundoOwner} onChange={(e) => setSegundoOwner(e.target.checked)} />
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="equipo-motivo">{t("superadmin.comun.motivoEtiqueta", { n: MOTIVO_EQUIPO_MINIMO })}</Label>
          <Textarea id="equipo-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={3} placeholder={t("superadmin.equipo.form.motivoPlaceholder")} />
        </div>
        {error && (
          <p role="alert" className="text-ui text-destructive">
            {error}
          </p>
        )}
      </form>
    </FormDialog>
  );
}
