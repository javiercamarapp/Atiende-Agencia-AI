// Cobro (superadmin): margen por organizacion con los costos unitarios capturados, cotizador de planes negociados (calcula
// margen al uso esperado y con la bolsa llena; debajo del minimo pide motivo, que queda auditado) y cotizaciones con su
// documento imprimible para el cliente. Backend real: apps/api/src/routes/cobro-consumo.ts. Crear el plan pide MFA (step-up).
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Receipt } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, PageContainer, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, formatMoney, resolverFormato, useTituloBarra } from "@atiende/ui";
import { fetchConStepUp } from "../lib/stepup.ts";

interface FilaOrg {
  readonly organizationId: string;
  readonly nombre: string;
  readonly plan: string;
  readonly disponible: boolean;
  readonly ingresoProyectadoMxn?: number | null;
  readonly costoProyectadoMxn?: number | null;
  readonly margenPct?: number | null;
  readonly margenConTarjetaPct?: number | null;
  readonly margenMinimoPct?: number;
  readonly bajoMinimo?: boolean;
}
interface Cotizacion {
  readonly id: string;
  readonly folio: number;
  readonly organizationId: string;
  readonly planId: string;
  readonly margenPct: number;
  readonly margenMinimoPct: number;
  readonly motivoExcepcion: string | null;
  readonly creadoEn: string;
}
interface Evaluacion {
  readonly esperado: { readonly factura: { readonly subtotalMxn: number; readonly totalMxn: number }; readonly costoMxn: number; readonly margenPct: number | null; readonly margenConTarjetaPct: number | null };
  readonly peorPunto: { readonly margenPct: number | null };
  readonly margenMinimoPct: number;
  readonly bajoMinimo: boolean;
}

// Un decimal: se redondea antes y el formateador canonico (es-MX, hasta 2 decimales) no agrega ceros.
const numeroEsMx = resolverFormato("numero");
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${numeroEsMx(Math.round(v * 10) / 10)} %`);
const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

export function SuperAdminCobroPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  useTituloBarra("Cobro y cotizador", Receipt);
  const base = apiBaseUrl.replace(/\/$/, "");
  const [orgs, setOrgs] = useState<readonly FilaOrg[] | null>(null);
  const [cotizaciones, setCotizaciones] = useState<readonly Cotizacion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [faltan, setFaltan] = useState<readonly string[]>([]);
  // Cotizador
  const [f, setF] = useState({ organizationId: "", planId: "", nombre: "", cuotaFijaMxn: "", precioSucursalMxn: "", sucursalesIncluidas: "", minutosVozIncluidos: "", conversacionesWaIncluidas: "", precioMinutoVozExcedenteMxn: "", precioConversacionWaExcedenteMxn: "", sucursales: "", llamadasMes: "", minutosPorLlamada: "2.3", conversacionesWa: "", motivo: "" });
  const [evaluacion, setEvaluacion] = useState<Evaluacion | null>(null);
  const [cotError, setCotError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      const h = { authorization: `Bearer ${token}` };
      const [r1, r2] = await Promise.all([fetch(`${base}/superadmin/cobro/organizaciones`, { headers: h }), fetch(`${base}/superadmin/cotizaciones`, { headers: h })]);
      if (!r1.ok || !r2.ok) throw new Error("No se pudo cargar el cobro.");
      const b1 = (await r1.json()) as { organizaciones: FilaOrg[]; costosFaltantes?: string[] };
      const b2 = (await r2.json()) as { cotizaciones: Cotizacion[] };
      setOrgs(b1.organizaciones);
      setFaltan(b1.costosFaltantes ?? []);
      setCotizaciones(b2.cotizaciones);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el cobro.");
    }
  }, [base, token]);

  useEffect(() => {
    if (token !== "") void cargar();
  }, [cargar, token]);

  function cuerpo() {
    const tarifa: Record<string, number | null> = {
      cuotaFijaMxn: num(f.cuotaFijaMxn),
      precioSucursalMxn: num(f.precioSucursalMxn),
      sucursalesIncluidas: num(f.sucursalesIncluidas) ?? 0,
      minutosVozIncluidos: num(f.minutosVozIncluidos) ?? 0,
      conversacionesWaIncluidas: num(f.conversacionesWaIncluidas) ?? 0,
      precioMinutoVozExcedenteMxn: num(f.precioMinutoVozExcedenteMxn),
      precioConversacionWaExcedenteMxn: num(f.precioConversacionWaExcedenteMxn),
    };
    const supuestos = { sucursales: num(f.sucursales) ?? 1, llamadasMes: num(f.llamadasMes) ?? 0, minutosPorLlamada: num(f.minutosPorLlamada) ?? 0, conversacionesWa: num(f.conversacionesWa) ?? 0 };
    return { tarifa, supuestos };
  }

  async function calcular(e: FormEvent) {
    e.preventDefault();
    setCotError(null);
    setAviso(null);
    setTrabajando(true);
    try {
      const res = await fetch(`${base}/superadmin/cotizador/calcular`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(cuerpo()) });
      const b = (await res.json()) as { evaluacion?: Evaluacion; message?: string };
      if (!res.ok || !b.evaluacion) throw new Error(b.message ?? "No se pudo calcular.");
      setEvaluacion(b.evaluacion);
    } catch (err) {
      setCotError(err instanceof Error ? err.message : "No se pudo calcular.");
    } finally {
      setTrabajando(false);
    }
  }

  async function crearPlan() {
    setCotError(null);
    setTrabajando(true);
    try {
      const res = await fetchConStepUp(base, token, `${base}/superadmin/cotizador/crear-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...cuerpo(), organizationId: f.organizationId.trim(), planId: f.planId.trim(), nombre: f.nombre.trim(), motivoExcepcion: f.motivo.trim() || undefined }),
      });
      const b = (await res.json()) as { cotizacion?: { folio: number }; message?: string };
      if (!res.ok || !b.cotizacion) throw new Error(b.message ?? "No se pudo crear el plan.");
      setAviso(`Plan creado (cotización ${b.cotizacion.folio}). Asígnalo a la organización desde Planes y precios.`);
      await cargar();
    } catch (err) {
      setCotError(err instanceof Error ? err.message : "No se pudo crear el plan.");
    } finally {
      setTrabajando(false);
    }
  }

  const campo = (k: keyof typeof f, etiqueta: string, tipo: "text" | "number" = "number") => (
    <div className="space-y-1">
      <Label htmlFor={`cot-${k}`}>{etiqueta}</Label>
      <Input id={`cot-${k}`} type={tipo} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </div>
  );

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      {error && <EstadoError titulo="No se pudo cargar" mensaje={error} onReintentar={() => void cargar()} compacto />}
      {faltan.length > 0 && <p className="text-eyebrow text-warning">Faltan costos unitarios para calcular márgenes: {faltan.join(", ")}.</p>}

      <Card>
        <CardHeader><CardTitle>Margen por organización (mes en curso, proyectado)</CardTitle></CardHeader>
        <CardContent>
          {orgs === null ? (
            <EstadoCargando variante="tarjeta" etiqueta="Cargando organizaciones…" />
          ) : orgs.length === 0 ? (
            <EstadoVacio titulo="Sin organizaciones con plan medido" mensaje="Asigna un plan medido para ver su ingreso, costo y margen." />
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Organización</TableHead><TableHead>Plan</TableHead><TableHead className="text-right">Ingreso</TableHead><TableHead className="text-right">Costo</TableHead><TableHead className="text-right">Margen</TableHead><TableHead className="text-right">Con tarjeta</TableHead></TableRow></TableHeader>
              <TableBody>
                {orgs.map((o) => (
                  <TableRow key={o.organizationId}>
                    <TableCell>{o.nombre}</TableCell>
                    <TableCell>{o.plan}</TableCell>
                    <TableCell className="text-right">{o.ingresoProyectadoMxn == null ? "—" : formatMoney(o.ingresoProyectadoMxn)}</TableCell>
                    <TableCell className="text-right">{o.costoProyectadoMxn == null ? "—" : formatMoney(o.costoProyectadoMxn)}</TableCell>
                    <TableCell className="text-right">{o.bajoMinimo ? <StatusBadge tone="danger">{pct(o.margenPct)}</StatusBadge> : pct(o.margenPct)}</TableCell>
                    <TableCell className="text-right">{pct(o.margenConTarjetaPct)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Cotizador de plan negociado</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={(e) => void calcular(e)} className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {campo("cuotaFijaMxn", "Cuota fija mensual (MXN, sin IVA)")}
            {campo("precioSucursalMxn", "Precio por sucursal (MXN)")}
            {campo("sucursalesIncluidas", "Sucursales incluidas")}
            {campo("minutosVozIncluidos", "Minutos de voz incluidos")}
            {campo("conversacionesWaIncluidas", "Conversaciones incluidas")}
            {campo("precioMinutoVozExcedenteMxn", "Minuto adicional (MXN)")}
            {campo("precioConversacionWaExcedenteMxn", "Conversación adicional (MXN)")}
            {campo("sucursales", "Sucursales del cliente")}
            {campo("llamadasMes", "Llamadas al mes esperadas")}
            {campo("minutosPorLlamada", "Minutos por llamada")}
            {campo("conversacionesWa", "Conversaciones al mes esperadas")}
            <div className="flex items-end"><Button type="submit" size="sm" disabled={trabajando}>Calcular margen</Button></div>
          </form>
          {cotError && <p role="alert" className="mt-2 text-eyebrow text-destructive">{cotError}</p>}
          {aviso && <p className="mt-2 text-eyebrow text-success">{aviso}</p>}
          {evaluacion && (
            <div className="mt-3 space-y-2" data-testid="cotizador-resultado">
              <p className="text-ui">
                Factura esperada {formatMoney(evaluacion.esperado.factura.subtotalMxn)} + IVA · costo {formatMoney(evaluacion.esperado.costoMxn)} · margen {pct(evaluacion.esperado.margenPct)} (con tarjeta {pct(evaluacion.esperado.margenConTarjetaPct)}) · con la bolsa llena {pct(evaluacion.peorPunto.margenPct)}
              </p>
              {evaluacion.bajoMinimo ? (
                <StatusBadge tone="danger">Debajo del mínimo de {evaluacion.margenMinimoPct} %: para crear el plan indica el motivo (queda auditado)</StatusBadge>
              ) : (
                <StatusBadge tone="success">Cumple el mínimo de {evaluacion.margenMinimoPct} %</StatusBadge>
              )}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {campo("organizationId", "Id de la organización", "text")}
                {campo("planId", "Id del plan (minúsculas y guiones)", "text")}
                {campo("nombre", "Nombre del plan", "text")}
              </div>
              {evaluacion.bajoMinimo && (
                <div className="space-y-1">
                  <Label htmlFor="cot-motivo">Motivo de la excepción (mínimo 20 caracteres)</Label>
                  <Textarea id="cot-motivo" value={f.motivo} onChange={(e) => setF({ ...f, motivo: e.target.value })} />
                </div>
              )}
              <Button type="button" size="sm" variant="outline" disabled={trabajando} onClick={() => void crearPlan()}>Crear plan a la medida (pide MFA)</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Cotizaciones</CardTitle></CardHeader>
        <CardContent>
          {cotizaciones.length === 0 ? (
            <EstadoVacio titulo="Sin cotizaciones" mensaje="Las cotizaciones convertidas en plan aparecen aquí." />
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Folio</TableHead><TableHead>Plan</TableHead><TableHead className="text-right">Margen</TableHead><TableHead>Excepción</TableHead><TableHead>Documento</TableHead></TableRow></TableHeader>
              <TableBody>
                {cotizaciones.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.folio}</TableCell>
                    <TableCell>{c.planId}</TableCell>
                    <TableCell className="text-right">{pct(c.margenPct)}</TableCell>
                    <TableCell>{c.motivoExcepcion ?? "—"}</TableCell>
                    <TableCell>
                      <Button type="button" size="xs" variant="outline" onClick={() => void abrirDocumento(base, token, c.id)}>Ver para imprimir</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}

/** El documento pide sesion: se descarga con el token y se abre como blob (nunca un enlace con el token en la URL). */
async function abrirDocumento(base: string, token: string, id: string): Promise<void> {
  const res = await fetch(`${base}/superadmin/cotizaciones/${encodeURIComponent(id)}/documento`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return;
  const url = URL.createObjectURL(new Blob([await res.text()], { type: "text/html" }));
  window.open(url, "_blank", "noopener");
}
