// Catalogo de planes y precios por vertical, limites por plan y asignacion a
// organizaciones (SA-03). Backend real: apps/api/src/routes/superadmin-planes.ts (ver
// docs/SUPERADMIN_COSTOS_PLANES.md). Asignar un plan es DOS pasos (solicitar con motivo ->
// confirmar con tu codigo MFA); editar el catalogo y los limites tambien pide MFA.
// Un plan NO cobra nada: define el contrato interno del que sale el ingreso esperado del
// margen. Un precio vacio significa "por configurar" (se muestra «—», nunca 0).
import { useEffect, useState, type FormEvent } from "react";
import { Tags } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, FormDialog, Input, Label, NativeSelect, PageContainer, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, formatMoney, statusTone, useConfirm } from "@atiende/ui";
import { ACCION_ESTADO_TONES } from "../lib/status-tones.ts";
import { fetchConStepUp } from "../lib/stepup.ts";

interface Limite {
  readonly metrica: string;
  readonly limite: number;
  readonly accion: string;
}

interface Plan {
  readonly id: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly precioBaseMxn: number | null;
  readonly precioAsientoMxn: number | null;
  readonly asientosIncluidos: number;
  readonly activo: boolean;
  readonly limites: readonly Limite[];
  readonly organizaciones: number;
}

interface Catalogo {
  readonly verticales: readonly string[];
  readonly metricas: readonly string[];
  readonly acciones: readonly string[];
}

interface Organizacion {
  readonly id: string;
  readonly vertical: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
}

interface Asignacion {
  readonly id: string;
  readonly organizationId: string;
  readonly organizacion: string | null;
  readonly planId: string;
  readonly motivo: string;
  readonly estado: "pending" | "executed" | "cancelled" | "expired";
  readonly venceEnMs: number;
}

const ETIQUETA_METRICA: Record<string, string> = {
  llm_costo_micro_usd_mes: "Costo de LLM al mes (USD)",
  minutos_voz_mes: "Minutos de voz al mes",
  mensajes_mes: "Mensajes al mes",
  sucursales: "Sucursales activas",
  asientos: "Asientos contratados",
};
const ETIQUETA_ESTADO: Record<Asignacion["estado"], string> = { pending: "Pendiente de confirmar", executed: "Aplicada", cancelled: "Cancelada", expired: "Vencida" };
const ETIQUETA_ACCION: Record<string, string> = { avisar: "avisar", cobrar: "cobrar excedente", pausar: "pausar" };

const pesos = (n: number | null) => (n === null ? "—" : `$${formatMoney(n)}`);

function textoLimite(l: Limite): string {
  const valor = l.metrica === "llm_costo_micro_usd_mes" ? `US$${formatMoney(l.limite / 1_000_000)}` : String(l.limite);
  return `${ETIQUETA_METRICA[l.metrica] ?? l.metrica}: ${valor} (${ETIQUETA_ACCION[l.accion] ?? l.accion})`;
}

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

/** "" -> null (por configurar); numero valido >= 0 -> numero; otra cosa -> undefined (error de captura). */
function parsePrecio(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function SuperAdminPlanesPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const { confirmar, dialogo } = useConfirm();
  const [planes, setPlanes] = useState<readonly Plan[] | null>(null);
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [disponible, setDisponible] = useState(true);
  const [orgs, setOrgs] = useState<readonly Organizacion[]>([]);
  const [planDeOrg, setPlanDeOrg] = useState<Readonly<Record<string, string | null>>>({});
  const [asignaciones, setAsignaciones] = useState<readonly Asignacion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState<string | null>(null);

  // Formulario de plan
  const [planForm, setPlanForm] = useState<{ nuevo: boolean } | null>(null);
  const [pId, setPId] = useState("");
  const [pNombre, setPNombre] = useState("");
  const [pVertical, setPVertical] = useState("restaurantes");
  const [pBase, setPBase] = useState("");
  const [pAsiento, setPAsiento] = useState("");
  const [pIncluidos, setPIncluidos] = useState("0");
  const [pActivo, setPActivo] = useState(true);
  const [pError, setPError] = useState<string | null>(null);

  // Limites
  const [limitesDe, setLimitesDe] = useState<string | null>(null);
  const [lMetrica, setLMetrica] = useState("minutos_voz_mes");
  const [lValor, setLValor] = useState("");
  const [lAccion, setLAccion] = useState("avisar");
  const [lError, setLError] = useState<string | null>(null);

  // Asignacion
  const [asignarA, setAsignarA] = useState<Organizacion | null>(null);
  const [aPlan, setAPlan] = useState("");
  const [aMotivo, setAMotivo] = useState("");
  const [aError, setAError] = useState<string | null>(null);

  async function cargar() {
    setError(null);
    try {
      const [p, a, o] = await Promise.all([
        fetchJson<{ disponible: boolean; catalogo: Catalogo; planes: Plan[] }>(apiBaseUrl, token, "/superadmin/planes"),
        fetchJson<{ asignaciones: Asignacion[] }>(apiBaseUrl, token, "/superadmin/planes/asignaciones"),
        fetchJson<{ organizations: Organizacion[] }>(apiBaseUrl, token, "/superadmin/organizations"),
      ]);
      setPlanes(p.planes);
      setCatalogo(p.catalogo);
      setDisponible(p.disponible);
      setAsignaciones(a.asignaciones);
      setOrgs(o.organizations);
      // El plan vigente de cada organizacion sale del reporte de costos (misma fuente que el margen).
      try {
        const r = await fetchJson<{ disponible: boolean; organizaciones: Array<{ organizationId: string; planId: string | null }> }>(apiBaseUrl, token, "/superadmin/costos/resumen");
        setPlanDeOrg(Object.fromEntries(r.organizaciones.map((x) => [x.organizationId, x.planId])));
      } catch {
        setPlanDeOrg({});
      }
    } catch {
      setError("No se pudo cargar el catálogo de planes.");
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  function abrirPlan(plan: Plan | null) {
    setPlanForm({ nuevo: plan === null });
    setPId(plan?.id ?? "");
    setPNombre(plan?.nombre ?? "");
    setPVertical(plan?.vertical ?? "restaurantes");
    setPBase(plan?.precioBaseMxn === null || plan === null ? "" : String(plan.precioBaseMxn));
    setPAsiento(plan?.precioAsientoMxn === null || plan === null ? "" : String(plan.precioAsientoMxn));
    setPIncluidos(String(plan?.asientosIncluidos ?? 0));
    setPActivo(plan?.activo ?? true);
    setPError(null);
  }

  async function guardarPlan(e: FormEvent) {
    e.preventDefault();
    const base = parsePrecio(pBase);
    const asiento = parsePrecio(pAsiento);
    const incluidos = Number(pIncluidos);
    if (!/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/u.test(pId)) return setPError("El id usa minúsculas, números y guiones (3 a 60 caracteres).");
    if (pNombre.trim().length < 2) return setPError("Indica el nombre del plan.");
    if (base === undefined || asiento === undefined) return setPError("Los precios deben ser montos en MXN mayores o iguales a 0 (vacío = por configurar).");
    if (!Number.isInteger(incluidos) || incluidos < 0) return setPError("Los asientos incluidos deben ser un entero mayor o igual a 0.");
    setTrabajando("plan");
    setPError(null);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/planes/${pId}`, { method: "PUT", body: JSON.stringify({ nombre: pNombre.trim(), vertical: pVertical, precioBaseMxn: base, precioAsientoMxn: asiento, asientosIncluidos: incluidos, activo: pActivo }) });
      setPlanForm(null);
      setAviso("Plan guardado.");
      await cargar();
    } catch (err) {
      setPError(err instanceof Error ? err.message : "No se pudo guardar el plan.");
    } finally {
      setTrabajando(null);
    }
  }

  async function guardarLimite(e: FormEvent) {
    e.preventDefault();
    if (!limitesDe) return;
    const n = Number(lValor);
    if (!Number.isFinite(n) || n < 0) return setLError("Indica un límite mayor o igual a 0.");
    const limite = lMetrica === "llm_costo_micro_usd_mes" ? Math.round(n * 1_000_000) : n;
    if (!Number.isInteger(limite)) return setLError("El límite debe ser un número entero.");
    setTrabajando("limite");
    setLError(null);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/planes/${limitesDe}/limites/${lMetrica}`, { method: "PUT", body: JSON.stringify({ limite, accion: lAccion }) });
      setLValor("");
      await cargar();
    } catch (err) {
      setLError(err instanceof Error ? err.message : "No se pudo guardar el límite.");
    } finally {
      setTrabajando(null);
    }
  }

  async function quitarLimite(planId: string, metrica: string) {
    // Quitar un límite cambia el tope de TODAS las organizaciones con ese plan: Cancelar / cerrar el diálogo NO ejecuta nada.
    const ok = await confirmar({
      titulo: `Quitar el límite «${ETIQUETA_METRICA[metrica] ?? metrica}»`,
      descripcion: "Las organizaciones con este plan dejarán de tener este tope. Para volver a ponerlo tendrás que capturarlo de nuevo.",
      tono: "danger",
      confirmar: "Quitar límite",
    });
    if (!ok) return;
    setTrabajando(`${planId}|${metrica}`);
    setLError(null);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/planes/${planId}/limites/${metrica}`, { method: "DELETE" });
      await cargar();
    } catch (err) {
      setLError(err instanceof Error ? err.message : "No se pudo quitar el límite.");
    } finally {
      setTrabajando(null);
    }
  }

  async function solicitarAsignacion(e: FormEvent) {
    e.preventDefault();
    if (!asignarA) return;
    if (!aPlan) return setAError("Elige el plan.");
    if (aMotivo.trim().length < 20) return setAError("El motivo debe tener al menos 20 caracteres.");
    setTrabajando("asignar");
    setAError(null);
    try {
      await fetchJson(apiBaseUrl, token, "/superadmin/planes/asignaciones", { method: "POST", body: JSON.stringify({ organizationId: asignarA.id, planId: aPlan, motivo: aMotivo }) });
      setAsignarA(null);
      setAviso("Solicitud creada. Nada cambió todavía: confírmala abajo (vence en 10 minutos).");
      await cargar();
    } catch (err) {
      setAError(err instanceof Error ? err.message : "No se pudo crear la solicitud.");
    } finally {
      setTrabajando(null);
    }
  }

  async function resolver(a: Asignacion, que: "confirmar" | "cancelar") {
    if (que === "confirmar") {
      // Confirmar aplica el cambio de plan (y su facturación) a la organización: Cancelar / cerrar el diálogo NO ejecuta nada.
      const ok = await confirmar({
        titulo: `Asignar el plan «${planes?.find((p) => p.id === a.planId)?.nombre ?? a.planId}» a ${a.organizacion ?? a.organizationId}`,
        descripcion: `Motivo registrado: ${a.motivo}`,
        confirmar: "Asignar plan",
      });
      if (!ok) return;
    }
    setTrabajando(a.id);
    setAviso(null);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/planes/asignaciones/${a.id}/${que}`, { method: "POST", body: JSON.stringify({}) });
      setAviso(que === "confirmar" ? "Plan asignado." : "Solicitud cancelada.");
      await cargar();
    } catch (err) {
      setAviso(err instanceof Error ? err.message : "No se pudo completar.");
    } finally {
      setTrabajando(null);
    }
  }

  if (error && !planes) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!planes || !catalogo) return <EstadoCargando etiqueta="Cargando el catálogo de planes…" />;

  const planPorId = new Map(planes.map((p) => [p.id, p]));
  const pendientes = asignaciones.filter((a) => a.estado === "pending" && a.venceEnMs > Date.now());
  const planEditando = limitesDe ? planPorId.get(limitesDe) : undefined;
  const planesParaOrg = asignarA ? planes.filter((p) => p.activo && p.vertical === asignarA.vertical) : [];

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            <Tags className="w-5 h-5" strokeWidth={1.75} />
            Planes y precios
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Catálogo por vertical, límites de cada plan y asignación a organizaciones. Asignar un plan se solicita con motivo y se confirma con tu código MFA. Un plan no cobra: define el ingreso esperado con el que se calcula el margen.
          </p>
        </div>
        {disponible && (
          <Button className="rounded-full" onClick={() => abrirPlan(null)}>
            Nuevo plan
          </Button>
        )}
      </div>

      {!disponible && (
        <p role="alert" className="text-sm text-muted-foreground">
          El catálogo de planes todavía no está disponible en esta base (migración 0028 pendiente de aplicar).
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
            <CardTitle>Pendientes de confirmar</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pendientes.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 flex-wrap rounded-md border border-border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {a.organizacion ?? a.organizationId} → {planPorId.get(a.planId)?.nombre ?? a.planId}
                  </p>
                  <p className="text-sm text-muted-foreground truncate" title={a.motivo}>
                    {a.motivo}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => void resolver(a, "cancelar")} disabled={trabajando === a.id}>
                    Cancelar
                  </Button>
                  <Button size="sm" onClick={() => void resolver(a, "confirmar")} disabled={trabajando === a.id}>
                    {trabajando === a.id ? "Aplicando…" : "Confirmar"}
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Catálogo</CardTitle>
        </CardHeader>
        <CardContent>
          {planes.length === 0 ? (
            <EstadoVacio mensaje="Todavía no hay planes." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plan</TableHead>
                    <TableHead>Vertical</TableHead>
                    <TableHead>Base / mes</TableHead>
                    <TableHead>Por asiento</TableHead>
                    <TableHead>Incluidos</TableHead>
                    <TableHead>Límites</TableHead>
                    <TableHead>Orgs</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {planes.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <span className="font-medium">{p.nombre}</span> {!p.activo && <StatusBadge tone="neutral">Inactivo</StatusBadge>}
                        <div className="text-xs text-muted-foreground">{p.id}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{p.vertical}</TableCell>
                      <TableCell className={p.precioBaseMxn === null ? "text-muted-foreground" : ""}>{pesos(p.precioBaseMxn)}</TableCell>
                      <TableCell className={p.precioAsientoMxn === null ? "text-muted-foreground" : ""}>{p.precioAsientoMxn === null && p.precioBaseMxn === null ? "— por configurar" : pesos(p.precioAsientoMxn)}</TableCell>
                      <TableCell>{p.asientosIncluidos}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.limites.length === 0 ? "sin límites" : (
                          <ul className="list-disc pl-4">
                            {p.limites.map((l) => (
                              <li key={l.metrica}>{textoLimite(l)}</li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                      <TableCell>{p.organizaciones}</TableCell>
                      <TableCell className="flex gap-2 justify-end">
                        {disponible && (
                          <>
                            <Button variant="outline" size="sm" onClick={() => abrirPlan(p)}>
                              Editar
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => { setLimitesDe(p.id); setLError(null); setLValor(""); }}>
                              Límites
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

      <Card>
        <CardHeader>
          <CardTitle>Organizaciones y su plan</CardTitle>
        </CardHeader>
        <CardContent>
          {orgs.length === 0 ? (
            <EstadoVacio mensaje="Todavía no hay organizaciones." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organización</TableHead>
                    <TableHead>Vertical</TableHead>
                    <TableHead>Plan asignado</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orgs.map((o) => {
                    const planId = planDeOrg[o.id] ?? null;
                    return (
                      <TableRow key={o.id}>
                        <TableCell className="font-medium">{o.name}</TableCell>
                        <TableCell className="text-muted-foreground">{o.vertical}</TableCell>
                        <TableCell className={planId ? "" : "text-muted-foreground"}>{planId ? (planPorId.get(planId)?.nombre ?? planId) : "sin plan asignado"}</TableCell>
                        <TableCell className="flex justify-end">
                          {disponible && o.status !== "suspended" && (
                            <Button variant="outline" size="sm" onClick={() => { setAsignarA(o); setAPlan(""); setAMotivo(""); setAError(null); }}>
                              {planId ? "Cambiar plan" : "Asignar plan"}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {disponible && asignaciones.some((a) => a.estado !== "pending" || a.venceEnMs <= Date.now()) && (
        <Card>
          <CardHeader>
            <CardTitle>Historial de asignaciones</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organización</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Motivo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {asignaciones
                    .filter((a) => a.estado !== "pending" || a.venceEnMs <= Date.now())
                    .map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>{a.organizacion ?? a.organizationId}</TableCell>
                        <TableCell>{planPorId.get(a.planId)?.nombre ?? a.planId}</TableCell>
                        <TableCell>
                          <StatusBadge tone={statusTone(ACCION_ESTADO_TONES, a.estado === "pending" ? "expired" : a.estado)}>{a.estado === "pending" ? ETIQUETA_ESTADO.expired : ETIQUETA_ESTADO[a.estado]}</StatusBadge>
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
        open={planForm !== null}
        onOpenChange={(open) => !open && setPlanForm(null)}
        titulo={planForm?.nuevo ? "Nuevo plan" : "Editar plan"}
        subtitulo="Precios en MXN. Déjalos vacíos si todavía no están definidos."
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setPlanForm(null)} disabled={trabajando === "plan"}>
              Cancelar
            </Button>
            <Button type="submit" form="form-plan" className="rounded-full px-6" disabled={trabajando === "plan"}>
              {trabajando === "plan" ? "Guardando…" : "Guardar"}
            </Button>
          </>
        }
      >
        <form id="form-plan" onSubmit={guardarPlan} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plan-id">Id</Label>
            <Input id="plan-id" value={pId} onChange={(e) => setPId(e.target.value)} disabled={planForm?.nuevo === false} placeholder="restaurantes-pro" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plan-nombre">Nombre</Label>
            <Input id="plan-nombre" value={pNombre} onChange={(e) => setPNombre(e.target.value)} placeholder="Restaurantes Pro" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plan-vertical">Vertical</Label>
            <NativeSelect id="plan-vertical" value={pVertical} onChange={(e) => setPVertical(e.target.value)}>
              {catalogo.verticales.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-base">Base al mes (MXN)</Label>
              <Input id="plan-base" inputMode="decimal" value={pBase} onChange={(e) => setPBase(e.target.value)} placeholder="5900" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-asiento">Por asiento (MXN)</Label>
              <Input id="plan-asiento" inputMode="decimal" value={pAsiento} onChange={(e) => setPAsiento(e.target.value)} placeholder="799" />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plan-incluidos">Asientos incluidos</Label>
            <Input id="plan-incluidos" inputMode="numeric" value={pIncluidos} onChange={(e) => setPIncluidos(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={pActivo} onChange={(e) => setPActivo(e.target.checked)} />
            Activo (asignable a organizaciones)
          </label>
          {pError && (
            <p role="alert" className="text-sm text-destructive">
              {pError}
            </p>
          )}
        </form>
      </FormDialog>

      <FormDialog
        open={limitesDe !== null}
        onOpenChange={(open) => !open && setLimitesDe(null)}
        titulo={`Límites — ${planEditando?.nombre ?? ""}`}
        subtitulo="Solo el tope de LLM con acción «pausar» se aplica de verdad (al asignar el plan); los demás se evalúan y se muestran en Costos y margen."
        anchoClase="max-w-lg"
        footer={
          <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setLimitesDe(null)}>
            Cerrar
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          {planEditando && planEditando.limites.length > 0 && (
            <ul className="flex flex-col gap-2 text-sm">
              {planEditando.limites.map((l) => (
                <li key={l.metrica} className="flex items-center justify-between gap-2">
                  <span>{textoLimite(l)}</span>
                  <Button variant="outline" size="sm" onClick={() => void quitarLimite(planEditando.id, l.metrica)} disabled={trabajando === `${planEditando.id}|${l.metrica}`}>
                    Quitar
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form id="form-limite" onSubmit={guardarLimite} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lim-metrica">Métrica</Label>
              <NativeSelect id="lim-metrica" value={lMetrica} onChange={(e) => setLMetrica(e.target.value)}>
                {catalogo.metricas.map((m) => (
                  <option key={m} value={m}>
                    {ETIQUETA_METRICA[m] ?? m}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lim-valor">Límite</Label>
                <Input id="lim-valor" inputMode="decimal" value={lValor} onChange={(e) => setLValor(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lim-accion">Al exceder</Label>
                <NativeSelect id="lim-accion" value={lAccion} onChange={(e) => setLAccion(e.target.value)}>
                  {catalogo.acciones.map((a) => (
                    <option key={a} value={a}>
                      {ETIQUETA_ACCION[a] ?? a}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
            {lError && (
              <p role="alert" className="text-sm text-destructive">
                {lError}
              </p>
            )}
            <Button type="submit" className="rounded-full self-start px-6" disabled={trabajando === "limite"}>
              {trabajando === "limite" ? "Guardando…" : "Fijar límite"}
            </Button>
          </form>
        </div>
      </FormDialog>

      <FormDialog
        open={asignarA !== null}
        onOpenChange={(open) => !open && setAsignarA(null)}
        titulo={`Asignar plan — ${asignarA?.name ?? ""}`}
        subtitulo="Se crea una solicitud; no cambia nada hasta que la confirmes."
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setAsignarA(null)} disabled={trabajando === "asignar"}>
              Cancelar
            </Button>
            <Button type="submit" form="form-asignar" className="rounded-full px-6" disabled={trabajando === "asignar"}>
              {trabajando === "asignar" ? "Enviando…" : "Solicitar"}
            </Button>
          </>
        }
      >
        <form id="form-asignar" onSubmit={solicitarAsignacion} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="asig-plan">Plan ({asignarA?.vertical})</Label>
            <NativeSelect id="asig-plan" value={aPlan} onChange={(e) => setAPlan(e.target.value)}>
              <option value="">Elige un plan…</option>
              {planesParaOrg.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="asig-motivo">Motivo (obligatorio, mínimo 20 caracteres)</Label>
            <Textarea
              id="asig-motivo"
              value={aMotivo}
              onChange={(e) => setAMotivo(e.target.value)}
              rows={4}
              required
            />
          </div>
          {aError && (
            <p role="alert" className="text-sm text-destructive">
              {aError}
            </p>
          )}
        </form>
      </FormDialog>
      {dialogo}
    </PageContainer>
  );
}
