// Cotizador de Precios (Fase 14): fechas + canal opcional -> GET cotización. Disponible para
// CUALQUIER staff con acceso a la property (igual que el backend: cotizaciones.ts no exige
// PRICING_ESCRITURA_ROLES, solo requirePropertyMembership). Separado de Precios.tsx (Rn-23) para
// que la página no pase de ~400 líneas.
import { useState } from "react";
import type { FormEvent } from "react";
import { AlertTriangle, Calculator } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, NativeSelect, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { basisPointsAPorcentaje, dineroDeCentavos, fetchCotizacion, TODOS_LOS_CANALES } from "../../lib/pricing-client.ts";
import type { ResultadoCotizacion } from "../../lib/pricing-client.ts";

const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";
const DIA_SEMANA_LABELS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

interface UnidadPanelProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly unidadId: string;
}

export function Cotizador({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [canal, setCanal] = useState("");
  const [cotizando, setCotizando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoCotizacion | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCotizar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!checkIn || !checkOut) return setError("Check-in y check-out son requeridos.");
    setCotizando(true);
    setResultado(null);
    try {
      const r = await fetchCotizacion(fetch, apiBaseUrl, token, propertyId, unidadId, { inicio: checkIn, fin: checkOut }, canal || undefined);
      setResultado(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo calcular la cotización.");
    } finally {
      setCotizando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base font-semibold">Cotizador</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 flex flex-col gap-3">
        <form onSubmit={handleCotizar} className="flex flex-col gap-2.5">
          <div className="flex gap-2.5 flex-wrap">
            <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
              Check-in
              <Input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} required />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
              Check-out
              <Input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} required />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[160px]`}>
              Canal (opcional)
              <NativeSelect value={canal} onChange={(e) => setCanal(e.target.value)}>
                <option value="">Reserva directa (sin canal)</option>
                {TODOS_LOS_CANALES.map((c) => (
                  <option key={c.codigo} value={c.codigo}>
                    {c.nombre}
                  </option>
                ))}
              </NativeSelect>
            </Label>
          </div>
          {error && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={cotizando} className="self-start">
            <Calculator className="w-4 h-4" strokeWidth={1.75} />
            {cotizando ? "Cotizando…" : "Cotizar"}
          </Button>
        </form>

        {resultado && (
          <div className="flex flex-col gap-2.5 border-t border-border pt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-9 px-2">Noche</TableHead>
                  <TableHead className="h-9 px-2">Origen</TableHead>
                  <TableHead className="h-9 px-2 text-right">Precio</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resultado.desgloseNoches.map((n) => (
                  <TableRow key={n.fecha}>
                    <TableCell className="p-2">{n.fecha}</TableCell>
                    <TableCell className="p-2 text-muted-foreground">{n.origen === "temporada" ? `Temporada: ${n.temporadaNombre}` : "Base"}</TableCell>
                    <TableCell className="p-2 text-right tabular-nums">
                      {dineroDeCentavos(n.precioCentavos, resultado.moneda)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-col gap-1 text-sm">
              <Linea label={`Subtotal (${resultado.noches} noche${resultado.noches === 1 ? "" : "s"})`} valorCentavos={resultado.subtotalAntesDescuentoCentavos} moneda={resultado.moneda} />
              {resultado.descuentoAplicado && (
                <Linea
                  label={`Descuento (${resultado.descuentoAplicado.nochesMinimas}+ noches, ${basisPointsAPorcentaje(resultado.descuentoAplicado.porcentajeDescuentoBasisPoints)}% — ${resultado.descuentoAplicado.fuente})`}
                  valorCentavos={-resultado.descuentoAplicado.montoCentavos}
                  moneda={resultado.moneda}
                />
              )}
              {resultado.markupCanalCentavos > 0 && <Linea label="Markup de canal" valorCentavos={resultado.markupCanalCentavos} moneda={resultado.moneda} />}
              <Linea label="Total" valorCentavos={resultado.totalCentavos} moneda={resultado.moneda} fuerte />
            </div>

            {resultado.violacionesMinStay.length > 0 && (
              <div className="flex gap-2 rounded-lg border border-dashed border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" strokeWidth={1.75} />
                <div>
                  {resultado.violacionesMinStay.map((v, i) => (
                    <p key={i} className={i === 0 ? "m-0" : "mt-1 mb-0"}>
                      No cumple la estancia mínima de {v.regla.nochesMinimas} noches
                      {v.regla.diaSemanaCheckIn !== null ? ` para check-in en ${DIA_SEMANA_LABELS[v.regla.diaSemanaCheckIn]}` : ""} ({v.regla.rango.inicio}..{v.regla.rango.fin}) — se
                      solicitaron {v.nochesSolicitadas}. Esto es informativo: el precio de arriba SÍ es el precio real, la decisión de bloquear la reserva es del calendario, no del
                      cotizador.
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Linea({ label, valorCentavos, moneda, fuerte }: { label: string; valorCentavos: number; moneda: string; fuerte?: boolean }) {
  const signo = valorCentavos < 0 ? "-" : "";
  return (
    <div className={fuerte ? "flex justify-between font-bold text-foreground" : "flex justify-between text-foreground"}>
      <span>{label}</span>
      <span className="tabular-nums">
        {signo}
        {dineroDeCentavos(Math.abs(valorCentavos), moneda)}
      </span>
    </div>
  );
}
