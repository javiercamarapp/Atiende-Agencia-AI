// Herramientas de Revenue (H-35) -- tres calculos deterministas del servidor que ya existian sin boton: explicar un precio
// recomendado, verificar la paridad con canales (OTAs) y verificar el benchmark de compset. No guardan nada ni cambian
// tarifas; capturan el insumo, el servidor valida y calcula, y se muestra su respuesta tal cual (un rechazo se ve como rechazo).
import { useState } from "react";
import type { FormEvent } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, NativeSelect, StatusBadge } from "@atiende/ui";
import { explicarPrecio, verificarCompset, verificarParidad } from "../lib/revenue-client.ts";
import type { CanalParidad, ExplicacionPrecio, FactorPrecio, VerificacionCompset, VerificacionParidad } from "../lib/revenue-client.ts";
import { dineroMx } from "../lib/dinero.ts";

export interface RevenueHerramientasProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

const num = (v: string): number | null => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

function ExplicarPrecio({ apiBaseUrl, token, propertyId }: RevenueHerramientasProps) {
  const [f, setF] = useState({ fecha: "", actual: "", recomendado: "", moneda: "MXN", pickup: "", compset: "", eventoNombre: "", eventoImpacto: "alza_demanda" as "alza_demanda" | "baja_demanda", eventoMagnitud: "", cambioMoneda: "", cambioVar: "" });
  const [res, setRes] = useState<ExplicacionPrecio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const actual = num(f.actual);
    const recomendado = num(f.recomendado);
    if (!f.fecha || actual === null || recomendado === null || actual <= 0 || recomendado <= 0) return setError("Fecha y precios (mayores a 0) son obligatorios.");
    const factors: FactorPrecio[] = [];
    const pickup = num(f.pickup);
    if (pickup !== null) factors.push({ kind: "pickup", onTheBooksVsExpectedPct: pickup });
    const compset = num(f.compset);
    if (compset !== null) factors.push({ kind: "compset", ownRateVsMedianPct: compset });
    const magnitud = num(f.eventoMagnitud);
    if (f.eventoNombre.trim() && magnitud !== null) factors.push({ kind: "evento", nombre: f.eventoNombre.trim(), impacto: f.eventoImpacto, magnitudPct: magnitud });
    const variacion = num(f.cambioVar);
    if (f.cambioMoneda.trim() && variacion !== null) factors.push({ kind: "tipo_cambio", moneda: f.cambioMoneda.trim().toUpperCase(), variacionPct: variacion });
    if (factors.length === 0) return setError("Captura al menos un factor: una recomendación sin factores no se puede explicar.");
    setBusy(true);
    setError(null);
    setRes(null);
    try {
      setRes(await explicarPrecio(fetch, apiBaseUrl, token, propertyId, { fecha: f.fecha, currentPrice: actual, recommendedPrice: recomendado, currency: f.moneda.trim().toUpperCase() || "MXN", factors }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo explicar el precio.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Explicar un precio">
      <p className="text-sm font-semibold text-foreground">Explicar un precio recomendado</p>
      <div className="grid gap-2 sm:grid-cols-4">
        <div>
          <Label htmlFor="exp-fecha">Noche</Label>
          <Input id="exp-fecha" type="date" value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="exp-actual">Precio actual</Label>
          <Input id="exp-actual" type="number" min="0" step="0.01" value={f.actual} onChange={(e) => setF({ ...f, actual: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="exp-reco">Precio recomendado</Label>
          <Input id="exp-reco" type="number" min="0" step="0.01" value={f.recomendado} onChange={(e) => setF({ ...f, recomendado: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="exp-moneda">Moneda</Label>
          <Input id="exp-moneda" value={f.moneda} maxLength={3} onChange={(e) => setF({ ...f, moneda: e.target.value })} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Factores (deja vacío el que no aplique):</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <Label htmlFor="exp-pickup">Pickup vs. esperado (%)</Label>
          <Input id="exp-pickup" type="number" step="0.1" value={f.pickup} onChange={(e) => setF({ ...f, pickup: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="exp-compset">Tarifa propia vs. mediana del compset (%)</Label>
          <Input id="exp-compset" type="number" step="0.1" value={f.compset} onChange={(e) => setF({ ...f, compset: e.target.value })} />
        </div>
        <div className="flex gap-2 sm:col-span-2 flex-wrap">
          <div className="flex-[2] min-w-[140px]">
            <Label htmlFor="exp-ev-nombre">Evento</Label>
            <Input id="exp-ev-nombre" value={f.eventoNombre} onChange={(e) => setF({ ...f, eventoNombre: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="exp-ev-impacto">Impacto</Label>
            <NativeSelect id="exp-ev-impacto" value={f.eventoImpacto} onChange={(e) => setF({ ...f, eventoImpacto: e.target.value as "alza_demanda" | "baja_demanda" })}>
              <option value="alza_demanda">Alza de demanda</option>
              <option value="baja_demanda">Baja de demanda</option>
            </NativeSelect>
          </div>
          <div className="flex-1 min-w-[90px]">
            <Label htmlFor="exp-ev-mag">Magnitud (%)</Label>
            <Input id="exp-ev-mag" type="number" min="0" step="0.1" value={f.eventoMagnitud} onChange={(e) => setF({ ...f, eventoMagnitud: e.target.value })} />
          </div>
        </div>
        <div className="flex gap-2 sm:col-span-2 flex-wrap">
          <div className="min-w-[90px]">
            <Label htmlFor="exp-tc-moneda">Divisa</Label>
            <Input id="exp-tc-moneda" value={f.cambioMoneda} maxLength={3} placeholder="USD" onChange={(e) => setF({ ...f, cambioMoneda: e.target.value })} />
          </div>
          <div className="flex-1 min-w-[140px]">
            <Label htmlFor="exp-tc-var">Variación del tipo de cambio (%)</Label>
            <Input id="exp-tc-var" type="number" step="0.1" value={f.cambioVar} onChange={(e) => setF({ ...f, cambioVar: e.target.value })} />
          </div>
        </div>
      </div>
      <Button type="submit" size="sm" disabled={busy} className="self-start">
        {busy ? "Explicando…" : "Explicar precio"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {res && (
        <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm text-foreground">
          <p className="font-medium">{res.headline}</p>
          {res.factors.map((x, i) => (
            <p key={`${x.kind}-${i}`} className="text-xs text-muted-foreground">
              {x.text}
            </p>
          ))}
        </div>
      )}
    </form>
  );
}

function VerificarParidad({ apiBaseUrl, token, propertyId }: RevenueHerramientasProps) {
  const [modo, setModo] = useState<"bloquea" | "alerta">("bloquea");
  const [canales, setCanales] = useState<readonly { channel: string; referenceRate: string; tolerance: string }[]>([{ channel: "", referenceRate: "", tolerance: "0" }]);
  const [propuesta, setPropuesta] = useState("");
  const [res, setRes] = useState<VerificacionParidad | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function setCanal(i: number, patch: Partial<{ channel: string; referenceRate: string; tolerance: string }>) {
    setCanales((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const proposedRate = num(propuesta);
    if (proposedRate === null || proposedRate <= 0) return setError("La tarifa propuesta debe ser un número mayor a 0.");
    const channels: CanalParidad[] = [];
    for (const c of canales) {
      if (!c.channel.trim() && c.referenceRate === "") continue;
      const referenceRate = num(c.referenceRate);
      const toleranceAllowedPct = num(c.tolerance);
      if (!c.channel.trim() || referenceRate === null || referenceRate <= 0 || toleranceAllowedPct === null || toleranceAllowedPct < 0 || toleranceAllowedPct >= 100) {
        return setError("Cada canal necesita nombre, tarifa de referencia (> 0) y tolerancia entre 0 y 100.");
      }
      channels.push({ channel: c.channel.trim(), referenceRate, toleranceAllowedPct });
    }
    setBusy(true);
    setError(null);
    setRes(null);
    try {
      setRes(await verificarParidad(fetch, apiBaseUrl, token, propertyId, { mode: modo, channels, proposedRate }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo verificar la paridad.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Verificar paridad">
      <p className="text-sm font-semibold text-foreground">Verificar paridad con canales (OTAs)</p>
      <div className="flex gap-2 flex-wrap">
        <div>
          <Label htmlFor="par-modo">Modo</Label>
          <NativeSelect id="par-modo" value={modo} onChange={(e) => setModo(e.target.value as "bloquea" | "alerta")}>
            <option value="bloquea">Bloquea</option>
            <option value="alerta">Solo alerta</option>
          </NativeSelect>
        </div>
        <div>
          <Label htmlFor="par-propuesta">Tarifa directa propuesta</Label>
          <Input id="par-propuesta" type="number" min="0" step="0.01" value={propuesta} onChange={(e) => setPropuesta(e.target.value)} />
        </div>
      </div>
      {canales.map((c, i) => (
        <div key={i} className="flex gap-2 flex-wrap items-end">
          <div className="flex-[2] min-w-[140px]">
            <Label htmlFor={`par-canal-${i}`}>Canal</Label>
            <Input id={`par-canal-${i}`} placeholder="booking.com" value={c.channel} onChange={(e) => setCanal(i, { channel: e.target.value })} />
          </div>
          <div className="flex-1 min-w-[110px]">
            <Label htmlFor={`par-ref-${i}`}>Tarifa en el canal</Label>
            <Input id={`par-ref-${i}`} type="number" min="0" step="0.01" value={c.referenceRate} onChange={(e) => setCanal(i, { referenceRate: e.target.value })} />
          </div>
          <div className="flex-1 min-w-[110px]">
            <Label htmlFor={`par-tol-${i}`}>Tolerancia (%)</Label>
            <Input id={`par-tol-${i}`} type="number" min="0" max="99.99" step="0.1" value={c.tolerance} onChange={(e) => setCanal(i, { tolerance: e.target.value })} />
          </div>
          {canales.length > 1 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setCanales((prev) => prev.filter((_, j) => j !== i))}>
              Quitar
            </Button>
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setCanales((prev) => [...prev, { channel: "", referenceRate: "", tolerance: "0" }])}>
          Agregar canal
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Verificando…" : "Verificar paridad"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {res && (
        <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm text-foreground">
          <StatusBadge tone={res.violations.length === 0 ? "success" : res.allowed ? "warning" : "danger"} className="self-start">
            {res.violations.length === 0 ? "Respeta la paridad" : res.allowed ? "Rompe la paridad (solo alerta)" : "Rompe la paridad: bloqueada"}
          </StatusBadge>
          {res.violations.map((v) => (
            <p key={v.channel} className="text-xs text-muted-foreground">
              {v.channel}: piso {dineroMx(v.floorRate)} (referencia {dineroMx(v.referenceRate)}) · la propuesta queda {v.deficitPct.toFixed(2)}% por debajo
            </p>
          ))}
        </div>
      )}
    </form>
  );
}

function VerificarCompset({ apiBaseUrl, token, propertyId }: RevenueHerramientasProps) {
  const [competidores, setCompetidores] = useState("");
  const [meses, setMeses] = useState("");
  const [opinion, setOpinion] = useState(false);
  const [res, setRes] = useState<VerificacionCompset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const competitorCount = num(competidores);
    const monthsOfHistory = num(meses);
    if (competitorCount === null || monthsOfHistory === null || competitorCount < 0 || monthsOfHistory < 0) return setError("Captura el número de competidores y los meses de histórico.");
    setBusy(true);
    setError(null);
    setRes(null);
    try {
      setRes(await verificarCompset(fetch, apiBaseUrl, token, propertyId, { competitorCount, monthsOfHistory, hasAntitrustOpinion: opinion }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo verificar el compset.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Verificar compset">
      <p className="text-sm font-semibold text-foreground">Verificar el benchmark de compset</p>
      <p className="text-xs text-muted-foreground">Un agregado de competidores solo se puede usar con al menos 10 hoteles, 12 meses de histórico y una opinión antimonopolio documentada.</p>
      <div className="flex gap-2 flex-wrap items-end">
        <div>
          <Label htmlFor="cs-n">Hoteles competidores</Label>
          <Input id="cs-n" type="number" min="0" step="1" value={competidores} onChange={(e) => setCompetidores(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="cs-m">Meses de histórico</Label>
          <Input id="cs-m" type="number" min="0" step="1" value={meses} onChange={(e) => setMeses(e.target.value)} />
        </div>
        <Checkbox label="Opinión antimonopolio documentada" checked={opinion} onChange={(e) => setOpinion(e.target.checked)} wrapperClassName="pb-2" />
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Verificando…" : "Verificar compset"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {res && (
        <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm text-foreground">
          <StatusBadge tone={res.allowed ? "success" : "danger"} className="self-start">
            {res.allowed ? "Se puede usar el benchmark" : "No se puede usar el benchmark"}
          </StatusBadge>
          {res.motivo && <p className="text-xs text-muted-foreground">{res.motivo}</p>}
        </div>
      )}
    </form>
  );
}

export function RevenueHerramientas(props: RevenueHerramientasProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Herramientas</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <ExplicarPrecio {...props} />
        <VerificarParidad {...props} />
        <VerificarCompset {...props} />
      </CardContent>
    </Card>
  );
}
