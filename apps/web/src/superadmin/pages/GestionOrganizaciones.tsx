// Gestion de organizaciones: alta, suspender, reactivar y cambiar plan de cuenta
// (prueba <-> activa), SIEMPRE en dos pasos -- solicitar y confirmar -- con motivo
// obligatorio. Backend real: apps/api/src/routes/superadmin-organizaciones.ts (ver
// docs/SUPERADMIN_ORGANIZACIONES.md). Confirmar pide tu codigo MFA (step-up).
// "Plan de cuenta" NO es el plan de cobro: no toca Stripe ni la facturacion.
import { useEffect, useState, type FormEvent } from "react";
import { Building2, Plus } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { ModalFormularioLateral } from "../../components/ModalFormularioLateral.tsx";
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
}

interface Solicitud {
  readonly tipo: Tipo;
  readonly organizationId: string | null;
  readonly etiqueta: string;
  readonly payload: Record<string, unknown>;
}

const VERTICALES = ["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"] as const;
const ETIQUETA_TIPO: Record<Tipo, string> = { alta: "Alta", suspender: "Suspender", reactivar: "Reactivar", cambiar_plan: "Cambiar plan de cuenta" };
const ETIQUETA_ESTADO: Record<Estado, string> = { pending: "Pendiente de confirmar", executed: "Ejecutada", cancelled: "Cancelada", expired: "Vencida" };

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

function badgeDeEstado(status: Organizacion["status"]) {
  if (status === "active") return <Badge>Activa</Badge>;
  if (status === "suspended") return <Badge variant="destructive">Suspendida</Badge>;
  return <Badge variant="secondary">Prueba</Badge>;
}

export function SuperAdminGestionOrganizacionesPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
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
      setError("No se pudieron cargar las organizaciones.");
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
    setSolicitud({ tipo: "alta", organizationId: null, etiqueta: "Alta de organización", payload: {} });
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
      setFormError("El motivo debe tener al menos 20 caracteres.");
      return;
    }
    const payload = solicitud.tipo === "alta" ? { vertical, name: nombre.trim(), slug: slug.trim() } : solicitud.payload;
    if (solicitud.tipo === "alta" && (nombre.trim().length < 2 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u.test(slug.trim()))) {
      setFormError("Indica un nombre y un slug en minúsculas, números y guiones.");
      return;
    }
    setTrabajando("solicitud");
    setFormError(null);
    try {
      await fetchJson(apiBaseUrl, token, "/superadmin/organizaciones/acciones", { method: "POST", body: JSON.stringify({ tipo: solicitud.tipo, organizationId: solicitud.organizationId, payload, motivo }) });
      setSolicitud(null);
      setAviso("Solicitud creada. Nada cambió todavía: confírmala abajo (vence en 10 minutos).");
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo crear la solicitud.");
    } finally {
      setTrabajando(null);
    }
  }

  async function resolver(accion: Accion, que: "confirmar" | "cancelar") {
    setTrabajando(accion.id);
    setAviso(null);
    setError(null);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/organizaciones/acciones/${accion.id}/${que}`, { method: "POST", body: JSON.stringify({}) });
      setAviso(que === "confirmar" ? "Acción ejecutada." : "Solicitud cancelada.");
      await cargar();
    } catch (err) {
      setAviso(err instanceof Error ? err.message : "No se pudo completar.");
    } finally {
      setTrabajando(null);
    }
  }

  if (error && !organizaciones) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!organizaciones) return <EstadoCargando etiqueta="Cargando organizaciones…" />;

  const pendientes = acciones.filter((a) => a.estado === "pending" && a.venceEnMs > Date.now());
  const nombreDe = (id: string | null) => (id ? (organizaciones.find((o) => o.id === id)?.name ?? id) : "(organización nueva)");

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            <Building2 className="w-5 h-5" strokeWidth={1.75} />
            Gestión de organizaciones
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Alta, suspender, reactivar y plan de cuenta. Cada cambio se solicita con motivo y se confirma aparte con tu código MFA. Suspender corta el acceso del equipo de esa organización a su panel; no toca el cobro.
          </p>
        </div>
        {disponible && (
          <Button className="rounded-full gap-1.5" onClick={abrirAlta}>
            <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
            Alta de organización
          </Button>
        )}
      </div>

      {!disponible && (
        <p role="alert" className="text-[13px] text-muted-foreground">
          La gestión de organizaciones todavía no está disponible en esta base (migración 0025 pendiente de aplicar).
        </p>
      )}
      {aviso && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {aviso}
        </p>
      )}

      {disponible && pendientes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pendientes de confirmar</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pendientes.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 flex-wrap rounded-md border border-border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {ETIQUETA_TIPO[a.tipo]} — {nombreDe(a.organizationId)}
                    {a.tipo === "cambiar_plan" ? ` → ${a.payload.plan === "active" ? "activa" : "prueba"}` : ""}
                    {a.tipo === "alta" ? ` (${String(a.payload.name)})` : ""}
                  </p>
                  <p className="text-[13px] text-muted-foreground truncate" title={a.motivo}>
                    {a.motivo}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => void resolver(a, "cancelar")} disabled={trabajando === a.id}>
                    Cancelar
                  </Button>
                  <Button size="sm" onClick={() => void resolver(a, "confirmar")} disabled={trabajando === a.id}>
                    {trabajando === a.id ? "Ejecutando…" : "Confirmar"}
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Organizaciones</CardTitle>
        </CardHeader>
        <CardContent>
          {organizaciones.length === 0 ? (
            <EstadoVacio mensaje="Todavía no hay organizaciones." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nombre</TableHead>
                    <TableHead>Vertical</TableHead>
                    <TableHead>Estado</TableHead>
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
                          <Button variant="outline" size="sm" onClick={() => abrir({ tipo: "reactivar", organizationId: o.id, etiqueta: `Reactivar ${o.name}`, payload: {} })}>
                            Reactivar
                          </Button>
                        )}
                        {disponible && o.status !== "suspended" && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => abrir({ tipo: "cambiar_plan", organizationId: o.id, etiqueta: `Pasar ${o.name} a cuenta ${o.status === "active" ? "de prueba" : "activa"}`, payload: { plan: o.status === "active" ? "trial" : "active" } })}
                            >
                              {o.status === "active" ? "Pasar a prueba" : "Pasar a activa"}
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => abrir({ tipo: "suspender", organizationId: o.id, etiqueta: `Suspender ${o.name}`, payload: {} })}>
                              Suspender
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
            <CardTitle>Historial</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Acción</TableHead>
                    <TableHead>Organización</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Motivo</TableHead>
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
                          <Badge variant={a.estado === "executed" ? "default" : "outline"}>{ETIQUETA_ESTADO[a.estado]}</Badge>
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

      <ModalFormularioLateral
        open={solicitud !== null}
        onOpenChange={(open) => !open && setSolicitud(null)}
        titulo={solicitud?.etiqueta ?? ""}
        subtitulo="Se crea una solicitud; no cambia nada hasta que la confirmes."
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setSolicitud(null)} disabled={trabajando === "solicitud"}>
              Cancelar
            </Button>
            <Button type="submit" form="form-solicitud-org" className="rounded-full px-6" disabled={trabajando === "solicitud"}>
              {trabajando === "solicitud" ? "Enviando…" : "Solicitar"}
            </Button>
          </>
        }
      >
        <form id="form-solicitud-org" onSubmit={enviarSolicitud} className="flex flex-col gap-3">
          {alta && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-vertical">Vertical</Label>
                <select id="org-vertical" value={vertical} onChange={(e) => setVertical(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                  {VERTICALES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-nombre">Nombre</Label>
                <Input id="org-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Clínica San Rafael" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-slug">Slug (identificador público)</Label>
                <Input id="org-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="clinica-san-rafael" />
              </div>
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-motivo">Motivo (obligatorio, mínimo 20 caracteres)</Label>
            <textarea
              id="org-motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              required
            />
          </div>
          {formError && (
            <p role="alert" className="text-[13px] text-destructive">
              {formError}
            </p>
          )}
        </form>
      </ModalFormularioLateral>
    </div>
  );
}
