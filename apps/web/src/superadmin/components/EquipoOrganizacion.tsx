// Seccion "Equipo" de la ficha de una organizacion (alta del equipo inicial por superadmin, SA-L-26 minimo, go-live G-07).
// Backend real: GET/POST /superadmin/organizaciones/:id/invitaciones, POST .../:inviteId/reenviar y DELETE .../:inviteId (migracion 0053; las
// mutaciones piden motivo >= 20 y step-up MFA). Cancelar y Escape NUNCA llaman al servidor. El correo llega enmascarado; el enlace de
// activacion se muestra UNA sola vez, justo despues de crear o reenviar. Estados: cargando, error con reintento, "no disponible aun" (base sin la
// migracion) y vacio con la accion de invitar al primer dueno.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Copy, MailPlus, RefreshCw, Trash2, Users } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, Checkbox, ConfirmDialog, EstadoCargando, EstadoError, EstadoVacio, FormDialog, Input, Label, NativeSelect, StatusBadge, Textarea, notify } from "@atiende/ui";
import { fechaHoraEsMx } from "../../lib/formato-fecha.ts";
import { fetchConStepUp } from "../lib/stepup.ts";
import { MOTIVO_EQUIPO_MINIMO, NOMBRE_ROL_EQUIPO, ROLES_EQUIPO } from "../lib/equipo.ts";
import type { EquipoInvitacion, RespuestaEquipo, ResultadoInvitacion } from "../lib/equipo.ts";

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
    return { ok: res.ok, status: res.status, code: cuerpo?.code ?? null, mensaje: cuerpo?.message ?? "No se pudo completar la solicitud.", cuerpo };
  } catch {
    return { ok: false, status: 0, code: null, mensaje: "No se pudo conectar con el servidor.", cuerpo: null };
  }
}

function etiquetaSucursales(ids: readonly string[] | null, nombres: ReadonlyMap<string, string>): string {
  if (ids === null) return "Todas las sucursales";
  return ids.map((id) => nombres.get(id) ?? "Sucursal").join(", ");
}

export function EquipoOrganizacion({ apiBaseUrl, token, organizacionId }: { readonly apiBaseUrl: string; readonly token: string; readonly organizacionId: string }) {
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
      setCarga({ estado: "error", mensaje: r.status === 404 ? "No encontramos esta organización." : "No se pudo cargar el equipo de la organización." });
      return;
    }
    const datos = r.cuerpo as RespuestaEquipo | null;
    // Una respuesta que no tiene la forma esperada (proxy, version vieja) es un error de carga, no un estado inventado.
    if (!datos || !Array.isArray(datos.miembros) || !Array.isArray(datos.invitaciones) || !Array.isArray(datos.sucursales)) {
      setCarga({ estado: "error", mensaje: "La respuesta del servidor no tiene el formato esperado." });
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
    notify.success("Invitación reenviada: el enlace anterior ya no sirve.");
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
    notify.success("Invitación revocada.");
    setRevocando(null);
    void cargar();
  };

  const copiar = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      notify.success("Enlace copiado.");
    } catch {
      notify.error("No se pudo copiar: selecciona el enlace y cópialo a mano.");
    }
  };

  return (
    <Card className="min-w-0" data-seccion="equipo">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4" strokeWidth={1.75} aria-hidden="true" />
          Equipo
        </CardTitle>
        {puedeInvitar && (
          <Button type="button" size="sm" className="gap-1.5" onClick={() => setInvitando(true)}>
            <MailPlus className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            Invitar
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {carga.estado === "cargando" && <EstadoCargando etiqueta="Cargando el equipo…" />}
        {carga.estado === "error" && <EstadoError compacto titulo="No se pudo cargar el equipo" mensaje={carga.mensaje} onReintentar={() => void cargar()} />}
        {datos && !datos.disponible && (
          <Callout tone="warning" role="status">
            {datos.mensaje}
          </Callout>
        )}

        {enlace && (
          <Callout tone="info" role="status" data-testid="enlace-activacion">
            <p className="font-medium">Enlace de activación para {enlace.invitacion.correo}</p>
            <p className="text-xs text-muted-foreground">
              Se muestra una sola vez (solo se guarda su huella). {enlace.correoEncolado ? "El correo de invitación quedó encolado." : "El correo no pudo encolarse: comparte este enlace por otro medio."}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Input readOnly aria-label="Enlace de activación" value={enlace.acceptUrl} onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={() => void copiar(enlace.acceptUrl)}>
                <Copy className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                Copiar
              </Button>
              <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setEnlace(null)}>
                Listo
              </Button>
            </div>
          </Callout>
        )}

        {datos?.disponible && (
          <>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Miembros · {datos.miembros.length}</p>
              {datos.miembros.length === 0 ? (
                <EstadoVacio compacto titulo="Sin miembros todavía" mensaje="Nadie puede entrar al panel de esta organización. Invita al primer dueño con el botón Invitar." />
              ) : (
                <ul className="divide-y divide-dashed divide-line2" aria-label="Miembros">
                  {datos.miembros.map((m) => (
                    <li key={m.userId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 text-ui">
                      <span className="min-w-0">
                        <span className="block truncate text-foreground">{m.correo}</span>
                        <span className="block truncate text-xs text-muted-foreground">{etiquetaSucursales(m.propertyIds, nombres)}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <StatusBadge tone="neutral">{NOMBRE_ROL_EQUIPO[m.rol] ?? m.rol}</StatusBadge>
                        <span className="text-xs text-muted-foreground">Alta {fechaHoraEsMx(m.altaEn)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Invitaciones pendientes · {datos.invitaciones.length}</p>
              {datos.invitaciones.length === 0 ? (
                <p className="py-1.5 text-ui text-muted-foreground">No hay invitaciones pendientes.</p>
              ) : (
                <ul className="divide-y divide-dashed divide-line2" aria-label="Invitaciones pendientes">
                  {datos.invitaciones.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-1.5 text-ui" data-invitacion={i.id}>
                      <span className="min-w-0">
                        <span className="block truncate text-foreground">{i.correo}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {NOMBRE_ROL_EQUIPO[i.rol] ?? i.rol} · {etiquetaSucursales(i.propertyIds, nombres)} · {i.vencida ? "Vencida" : `Vence ${fechaHoraEsMx(i.venceEn)}`}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setReenviando(i)}>
                          <RefreshCw className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                          Reenviar
                          <span className="sr-only"> a {i.correo}</span>
                        </Button>
                        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setRevocando(i)}>
                          <Trash2 className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                          Revocar
                          <span className="sr-only"> a {i.correo}</span>
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
          hayOwner={hayOwner}
          onCreada={(r) => {
            setEnlace(r);
            setInvitando(false);
            notify.success("Invitación creada.");
            void cargar();
          }}
        />
      )}

      <ConfirmDialog
        open={reenviando !== null}
        onOpenChange={(v) => !v && setReenviando(null)}
        titulo="Reenviar la invitación"
        descripcion={reenviando ? `Se genera un enlace nuevo para ${reenviando.correo}; el anterior deja de servir y la vigencia vuelve a 7 días.` : undefined}
        confirmar="Reenviar"
        campo={{ etiqueta: "Motivo", ayuda: `Obligatorio, mínimo ${MOTIVO_EQUIPO_MINIMO} caracteres.`, multilinea: true, minLength: MOTIVO_EQUIPO_MINIMO, maxLength: 500 }}
        onConfirm={reenviar}
      />
      <ConfirmDialog
        open={revocando !== null}
        onOpenChange={(v) => !v && setRevocando(null)}
        titulo="Revocar la invitación"
        tono="danger"
        descripcion={revocando ? `${revocando.correo} ya no podrá aceptar esta invitación. Se registra en la bitácora.` : undefined}
        confirmar="Revocar"
        campo={{ etiqueta: "Motivo", ayuda: `Obligatorio, mínimo ${MOTIVO_EQUIPO_MINIMO} caracteres.`, multilinea: true, minLength: MOTIVO_EQUIPO_MINIMO, maxLength: 500 }}
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
  hayOwner,
  onCreada,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly base: string;
  readonly sucursales: RespuestaEquipo["sucursales"];
  readonly hayOwner: boolean;
  readonly onCreada: (r: ResultadoInvitacion) => void;
}) {
  const [email, setEmail] = useState("");
  const [rol, setRol] = useState("owner");
  const [elegidas, setElegidas] = useState<ReadonlySet<string>>(new Set());
  const [motivo, setMotivo] = useState("");
  const [segundoOwner, setSegundoOwner] = useState(false);
  const [pideConfirmacion, setPideConfirmacion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (open) {
      setEmail("");
      setRol("owner");
      setElegidas(new Set());
      setMotivo("");
      setSegundoOwner(false);
      setPideConfirmacion(false);
      setError(null);
      setGuardando(false);
    }
  }, [open]);

  const mostrarSegundoOwner = rol === "owner" && (hayOwner || pideConfirmacion);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("Escribe un correo válido.");
    if (motivo.trim().length < MOTIVO_EQUIPO_MINIMO) return setError(`El motivo es obligatorio (mínimo ${MOTIVO_EQUIPO_MINIMO} caracteres).`);
    if (mostrarSegundoOwner && !segundoOwner) return setError("Esta organización ya tiene un owner: confirma que quieres invitar a un segundo owner.");
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
      titulo="Invitar al equipo"
      subtitulo="La persona define su contraseña al aceptar. Solo se guarda la huella del enlace."
      anchoClase="max-w-lg"
      bloquearCierre={guardando}
      footer={
        <>
          <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => onOpenChange(false)} disabled={guardando}>
            Cancelar
          </Button>
          <Button type="submit" form="form-invitar-equipo" className="rounded-full px-6" disabled={guardando}>
            {guardando ? "Invitando…" : "Invitar"}
          </Button>
        </>
      }
    >
      <form id="form-invitar-equipo" onSubmit={(ev) => void enviar(ev)} className="flex flex-col gap-3" noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="equipo-email">Correo</Label>
          <Input id="equipo-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="persona@restaurante.mx" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="equipo-rol">Rol</Label>
          <NativeSelect id="equipo-rol" value={rol} onChange={(e) => setRol(e.target.value)}>
            {ROLES_EQUIPO.map((r) => (
              <option key={r.valor} value={r.valor}>
                {r.nombre}
              </option>
            ))}
          </NativeSelect>
        </div>
        {sucursales.length > 0 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-ui font-medium text-foreground">Sucursales</legend>
            <p className="text-xs text-muted-foreground">Sin ninguna marcada tiene acceso a todas.</p>
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
          <Checkbox label="Confirmo invitar a un segundo owner" descripcion="Esta organización ya tiene un owner (activo o con invitación pendiente)." checked={segundoOwner} onChange={(e) => setSegundoOwner(e.target.checked)} />
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="equipo-motivo">Motivo (obligatorio, mínimo {MOTIVO_EQUIPO_MINIMO} caracteres)</Label>
          <Textarea id="equipo-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={3} placeholder="Ej. Alta del dueño de la organización para el arranque en producción." />
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
