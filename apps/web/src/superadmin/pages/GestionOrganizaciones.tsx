// Gestion de organizaciones: alta, suspender, reactivar y cambiar plan de cuenta
// (prueba <-> activa), SIEMPRE en dos pasos -- solicitar y confirmar -- con motivo
// obligatorio. Suspender una organizacion con contrato vigente pide ademas la
// aprobacion de un SEGUNDO superadmin (doble control, migracion 0038). Backend real: apps/api/src/routes/superadmin-organizaciones.ts (ver
// docs/SUPERADMIN_ORGANIZACIONES.md). Confirmar pide tu codigo MFA (step-up).
// "Plan de cuenta" NO es el plan de cobro: no toca Stripe ni la facturacion.
import { useEffect, useState, type FormEvent } from "react";
import { Building2, Plus } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, FormDialog, Input, Label, NativeSelect, PageContainer, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, etiquetasTraducidas, statusTone, traductorActivo, useConfirm, useT } from "@atiende/ui";
import { comun } from "@atiende/ui/i18n/comun";
import { superadminComun } from "@atiende/ui/i18n/superadmin/comun";
import { superadminGestion } from "@atiende/ui/i18n/superadmin/gestion";
import { ACCION_ESTADO_TONES, ORG_STATUS_TONES } from "../lib/status-tones.ts";
import { fetchConStepUp } from "../lib/stepup.ts";

type Tipo = "alta" | "suspender" | "reactivar" | "cambiar_plan";
type Estado = "pending" | "executed" | "cancelled" | "expired";

interface Organizacion {
  readonly id: string;
  readonly vertical: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "trial" | "active" | "suspended";
}

interface Accion {
  readonly id: string;
  readonly tipo: Tipo;
  readonly organizationId: string | null;
  readonly payload: Record<string, unknown>;
  readonly motivo: string;
  readonly estado: Estado;
  readonly venceEnMs: number;
  readonly resultado: Record<string, unknown> | null;
  // SA-06 (migracion 0038): una API/base sin ella no manda estos campos (se leen como "sin doble control").
  readonly requiereDobleControl?: boolean;
  readonly contratoVersion?: number | null;
  readonly aprobadoPor?: string | null;
  readonly esSolicitante?: boolean;
}

interface Solicitud {
  readonly tipo: Tipo;
  readonly organizationId: string | null;
  readonly etiqueta: string;
  readonly payload: Record<string, unknown>;
}

const VERTICALES = ["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"] as const;
// Etiquetas en el idioma activo (traducen en cada lectura; la pagina usa `useT` y se repinta al cambiarlo).
const ETIQUETA_TIPO: Readonly<Record<Tipo, string>> = etiquetasTraducidas(["alta", "suspender", "reactivar", "cambiar_plan"] as const, (k) => `superadmin.gestion.tipo.${k}` as const, superadminGestion);
const ETIQUETA_ESTADO: Readonly<Record<Estado, string>> = etiquetasTraducidas(["pending", "executed", "cancelled", "expired"] as const, (k) => `superadmin.gestion.estado.${k}` as const, superadminGestion);
const tr = traductorActivo(superadminComun);

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? tr("superadmin.comun.error.solicitud"));
  }
  return res.json() as Promise<T>;
}

function badgeDeEstado(status: Organizacion["status"]) {
  return <StatusBadge tone={statusTone(ORG_STATUS_TONES, status)}>{tr(`superadmin.comun.estadoOrg.${status}`)}</StatusBadge>;
}

/**
 * `embebida`: se monta como la pestana 'Gestion' de Organizaciones (SA-L-20): la pagina contenedora ya pone el `<h1>` y el `PageContainer`, asi que
 * aqui solo va el texto de apoyo y el boton de alta. Sin `embebida` (uso historico y pruebas) conserva su cabecera y su contenedor.
 */
export function SuperAdminGestionOrganizacionesPage({ apiBaseUrl, token, embebida = false }: { readonly apiBaseUrl: string; readonly token: string; readonly embebida?: boolean }) {
  const t = useT(comun, superadminComun, superadminGestion);
  const { confirmar, dialogo } = useConfirm();
  const [organizaciones, setOrganizaciones] = useState<readonly Organizacion[] | null>(null);
  const [acciones, setAcciones] = useState<readonly Accion[]>([]);
  const [disponible, setDisponible] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const [solicitud, setSolicitud] = useState<Solicitud | null>(null);
  const [alta, setAlta] = useState(false);
  const [vertical, setVertical] = useState<string>(VERTICALES[0]);
  const [nombre, setNombre] = useState("");
  const [slug, setSlug] = useState("");
  const [motivo, setMotivo] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState<string | null>(null);

  async function cargar() {
    setError(null);
    try {
      const [o, a] = await Promise.all([
        fetchJson<{ organizations: Organizacion[] }>(apiBaseUrl, token, "/superadmin/organizations"),
        fetchJson<{ disponible: boolean; acciones: Accion[] }>(apiBaseUrl, token, "/superadmin/organizaciones/acciones"),
      ]);
      setOrganizaciones(o.organizations);
      setAcciones(a.acciones);
      setDisponible(a.disponible);
    } catch {
      setError(t("superadmin.comun.error.organizaciones"));
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  function abrir(s: Solicitud) {
    setSolicitud(s);
    setAlta(false);
    setMotivo("");
    setFormError(null);
  }

  function abrirAlta() {
    setSolicitud({ tipo: "alta", organizationId: null, etiqueta: t("superadmin.gestion.alta"), payload: {} });
    setAlta(true);
    setNombre("");
    setSlug("");
    setVertical(VERTICALES[0]);
    setMotivo("");
    setFormError(null);
  }

  async function enviarSolicitud(e: FormEvent) {
    e.preventDefault();
    if (!solicitud) return;
    if (motivo.trim().length < 20) {
      setFormError(t("superadmin.gestion.error.motivoCorto"));
      return;
    }
    const payload = solicitud.tipo === "alta" ? { vertical, name: nombre.trim(), slug: slug.trim() } : solicitud.payload;
    if (solicitud.tipo === "alta" && (nombre.trim().length < 2 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u.test(slug.trim()))) {
      setFormError(t("superadmin.gestion.error.nombreSlug"));
      return;
    }
    setTrabajando("solicitud");
    setFormError(null);
    try {
      await fetchJson(apiBaseUrl, token, "/superadmin/organizaciones/acciones", { method: "POST", body: JSON.stringify({ tipo: solicitud.tipo, organizationId: solicitud.organizationId, payload, motivo }) });
      setSolicitud(null);
      setAviso(t("superadmin.gestion.aviso.creada"));
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("superadmin.gestion.error.crear"));
    } finally {
      setTrabajando(null);
    }
  }

  async function resolver(accion: Accion, que: "confirmar" | "cancelar" | "aprobar") {
    if (que === "aprobar") {
      // Aprobar es el segundo control: autoriza que el solicitante ejecute; cerrar o descartar el diálogo NO aprueba nada.
      const ok = await confirmar({
        titulo: t("superadmin.gestion.aprobarTitulo", {
          tipo: ETIQUETA_TIPO[accion.tipo].toLowerCase(),
          nombre: accion.organizationId ? (organizaciones?.find((o) => o.id === accion.organizationId)?.name ?? accion.organizationId) : t("superadmin.gestion.orgNueva"),
        }),
        descripcion: `${t("superadmin.gestion.motivoRegistrado", { motivo: accion.motivo })}${accion.contratoVersion ? ` · ${t("superadmin.gestion.contratoVigente", { v: String(accion.contratoVersion) })}` : ""} ${t("superadmin.gestion.aprobacionBitacora")}`,
        tono: "danger",
        confirmar: t("superadmin.gestion.aprobar"),
      });
      if (!ok) return;
    }
    if (que === "confirmar") {
      // Confirmar ejecuta el alta / suspensión / reactivación / cambio de cuenta de una organización: Cancelar / cerrar el diálogo NO ejecuta nada.
      const nombre = accion.organizationId ? (organizaciones?.find((o) => o.id === accion.organizationId)?.name ?? accion.organizationId) : String(accion.payload.name ?? t("superadmin.gestion.orgNueva"));
      const ok = await confirmar({
        titulo: `${ETIQUETA_TIPO[accion.tipo]}: ${nombre}`,
        descripcion: t("superadmin.gestion.motivoRegistrado", { motivo: accion.motivo }),
        tono: accion.tipo === "suspender" ? "danger" : "default",
        confirmar: t("superadmin.gestion.ejecutar"),
      });
      if (!ok) return;
    }
    setTrabajando(accion.id);
    setAviso(null);
    setError(null);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/organizaciones/acciones/${accion.id}/${que}`, { method: "POST", body: JSON.stringify({}) });
      setAviso(t(que === "confirmar" ? "superadmin.gestion.aviso.ejecutada" : que === "aprobar" ? "superadmin.gestion.aviso.aprobada" : "superadmin.gestion.aviso.cancelada"));
      await cargar();
    } catch (err) {
      setAviso(err instanceof Error ? err.message : t("superadmin.gestion.error.completar"));
    } finally {
      setTrabajando(null);
    }
  }

  if (error && !organizaciones) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!organizaciones) return <EstadoCargando etiqueta={t("superadmin.comun.cargandoOrganizaciones")} />;

  const pendientes = acciones.filter((a) => a.estado === "pending" && a.venceEnMs > Date.now());
  const nombreDe = (id: string | null) => (id ? (organizaciones.find((o) => o.id === id)?.name ?? id) : t("superadmin.gestion.orgNuevaParentesis"));

  const Contenedor = embebida ? "div" : PageContainer;
  const propsContenedor = embebida ? { className: "space-y-4 [&>*]:min-w-0" } : { padding: "none" as const, className: "[&>*]:min-w-0" };
  return (
    <Contenedor {...propsContenedor}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          {!embebida && (
            <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
              <Building2 className="w-5 h-5" strokeWidth={1.75} />
              {t("superadmin.gestion.titulo")}
            </h1>
          )}
          <p className={embebida ? "text-ui text-muted-foreground" : "text-sm text-muted-foreground mt-1"}>{t("superadmin.gestion.descripcion")}</p>
        </div>
        {disponible && (
          <Button className="rounded-full gap-1.5" onClick={abrirAlta}>
            <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
            {t("superadmin.gestion.alta")}
          </Button>
        )}
      </div>

      {!disponible && (
        <p role="alert" className="text-sm text-muted-foreground">
          {t("superadmin.gestion.noDisponible")}
        </p>
      )}
      {aviso && (
        <p role="status" className="text-sm text-muted-foreground">
          {aviso}
        </p>
      )}

      {disponible && pendientes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("superadmin.gestion.pendientes")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pendientes.map((a) => {
              const esMia = a.esSolicitante !== false;
              const dobleControl = a.requiereDobleControl === true;
              const aprobada = Boolean(a.aprobadoPor);
              return (
                <div key={a.id} className="flex items-center justify-between gap-3 flex-wrap rounded-md border border-border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {ETIQUETA_TIPO[a.tipo]} — {nombreDe(a.organizationId)}
                      {a.tipo === "cambiar_plan" ? ` → ${t(a.payload.plan === "active" ? "superadmin.gestion.plan.activa" : "superadmin.gestion.plan.prueba")}` : ""}
                      {a.tipo === "alta" ? ` (${String(a.payload.name)})` : ""}
                    </p>
                    <p className="text-sm text-muted-foreground truncate" title={a.motivo}>
                      {a.motivo}
                    </p>
                    {dobleControl && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("superadmin.gestion.dobleControl")}
                        {a.contratoVersion ? ` ${t("superadmin.gestion.version", { v: String(a.contratoVersion) })}` : ""}.{" "}
                        {t(aprobada ? "superadmin.gestion.aprobadaSegundo" : esMia ? "superadmin.gestion.faltaSegundo" : "superadmin.gestion.esperaTuAprobacion")}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {esMia && (
                      <Button variant="outline" size="sm" onClick={() => void resolver(a, "cancelar")} disabled={trabajando === a.id}>
                        {t("comun.cancelar")}
                      </Button>
                    )}
                    {dobleControl && !esMia && !aprobada && (
                      <Button size="sm" onClick={() => void resolver(a, "aprobar")} disabled={trabajando === a.id}>
                        {trabajando === a.id ? t("superadmin.gestion.aprobando") : t("superadmin.gestion.aprobar")}
                      </Button>
                    )}
                    {esMia && (
                      <Button size="sm" onClick={() => void resolver(a, "confirmar")} disabled={trabajando === a.id || (dobleControl && !aprobada)}>
                        {trabajando === a.id ? t("superadmin.gestion.ejecutando") : t("comun.confirmar")}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("superadmin.comun.organizaciones")}</CardTitle>
        </CardHeader>
        <CardContent>
          {organizaciones.length === 0 ? (
            <EstadoVacio mensaje={t("superadmin.gestion.vacio")} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("superadmin.comun.col.nombre")}</TableHead>
                    <TableHead>{t("superadmin.comun.col.vertical")}</TableHead>
                    <TableHead>{t("superadmin.comun.col.estado")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizaciones.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>
                        <span className="font-medium">{o.name}</span> <span className="text-xs text-muted-foreground">{o.slug}</span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{o.vertical}</TableCell>
                      <TableCell>{badgeDeEstado(o.status)}</TableCell>
                      <TableCell className="flex gap-2 justify-end">
                        {disponible && o.status === "suspended" && (
                          <Button variant="outline" size="sm" onClick={() => abrir({ tipo: "reactivar", organizationId: o.id, etiqueta: t("superadmin.gestion.reactivarNombre", { nombre: o.name }), payload: {} })}>
                            {ETIQUETA_TIPO.reactivar}
                          </Button>
                        )}
                        {disponible && o.status !== "suspended" && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                abrir({
                                  tipo: "cambiar_plan",
                                  organizationId: o.id,
                                  etiqueta: t(o.status === "active" ? "superadmin.gestion.aPruebaNombre" : "superadmin.gestion.aActivaNombre", { nombre: o.name }),
                                  payload: { plan: o.status === "active" ? "trial" : "active" },
                                })
                              }
                            >
                              {t(o.status === "active" ? "superadmin.gestion.aPrueba" : "superadmin.gestion.aActiva")}
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => abrir({ tipo: "suspender", organizationId: o.id, etiqueta: t("superadmin.gestion.suspenderNombre", { nombre: o.name }), payload: {} })}>
                              {ETIQUETA_TIPO.suspender}
                            </Button>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {disponible && acciones.some((a) => a.estado !== "pending") && (
        <Card>
          <CardHeader>
            <CardTitle>{t("superadmin.comun.historial")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("superadmin.gestion.col.accion")}</TableHead>
                    <TableHead>{t("superadmin.comun.col.organizacion")}</TableHead>
                    <TableHead>{t("superadmin.comun.col.estado")}</TableHead>
                    <TableHead>{t("superadmin.comun.col.motivo")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {acciones
                    .filter((a) => a.estado !== "pending")
                    .map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>{ETIQUETA_TIPO[a.tipo]}</TableCell>
                        <TableCell>{nombreDe(a.organizationId ?? (typeof a.resultado?.organization_id === "string" ? a.resultado.organization_id : null))}</TableCell>
                        <TableCell>
                          <StatusBadge tone={statusTone(ACCION_ESTADO_TONES, a.estado)}>{ETIQUETA_ESTADO[a.estado]}</StatusBadge>
                        </TableCell>
                        <TableCell className="max-w-[320px] truncate text-muted-foreground" title={a.motivo}>
                          {a.motivo}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <FormDialog
        open={solicitud !== null}
        onOpenChange={(open) => !open && setSolicitud(null)}
        titulo={solicitud?.etiqueta ?? ""}
        subtitulo={t("superadmin.gestion.subtitulo")}
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setSolicitud(null)} disabled={trabajando === "solicitud"}>
              {t("comun.cancelar")}
            </Button>
            <Button type="submit" form="form-solicitud-org" className="rounded-full px-6" disabled={trabajando === "solicitud"}>
              {trabajando === "solicitud" ? t("superadmin.gestion.enviando") : t("superadmin.gestion.solicitar")}
            </Button>
          </>
        }
      >
        <form id="form-solicitud-org" onSubmit={enviarSolicitud} className="flex flex-col gap-3">
          {alta && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-vertical">{t("superadmin.comun.col.vertical")}</Label>
                <NativeSelect id="org-vertical" value={vertical} onChange={(e) => setVertical(e.target.value)}>
                  {VERTICALES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-nombre">{t("superadmin.comun.col.nombre")}</Label>
                <Input id="org-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder={t("superadmin.gestion.placeholderNombre")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-slug">{t("superadmin.gestion.slug")}</Label>
                <Input id="org-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t("superadmin.gestion.placeholderSlug")} />
              </div>
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-motivo">{t("superadmin.comun.motivoEtiqueta", { n: 20 })}</Label>
            <Textarea
              id="org-motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={4}
              required
            />
          </div>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
        </form>
      </FormDialog>
      {dialogo}
    </Contenedor>
  );
}
