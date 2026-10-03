// Sección 3 de Finanzas: payouts de canal + conciliación (ver un payout por id; importar solo admin_gestora).
import { useState } from "react";
import { Wallet } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StatusBadge,
  statusTone,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import { centavosAPesos, fetchPayoutDetalle } from "../../lib/finanzas-client.ts";
import type { PayoutDetalle } from "../../lib/finanzas-client.ts";
import { CONCILIACION_TONES } from "../../lib/status-tones.ts";
import { ESTADO_CONCILIACION_LABELS, LABEL_CLASES } from "./comunes.tsx";
import type { SectionProps } from "./comunes.tsx";
import { ImportarPayoutForm } from "./ImportarPayoutForm.tsx";

export function PayoutsSection({ apiBaseUrl, token, propertyId, puedeEscribir }: SectionProps) {
  const [payoutId, setPayoutId] = useState("");
  const [detalle, setDetalle] = useState<PayoutDetalle | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verPayout(id: string) {
    if (!id.trim()) return setError("Se necesita el id del payout.");
    setError(null);
    setCargando(true);
    try {
      const d = await fetchPayoutDetalle(fetch, apiBaseUrl, token, propertyId, id.trim());
      setDetalle(d);
    } catch (err) {
      setDetalle(null);
      setError(err instanceof Error ? err.message : "No se pudo cargar el payout.");
    } finally {
      setCargando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base font-semibold">Payouts de canal + conciliación</CardTitle>
        <CardDescription className="text-xs">
          No hay un listado de payouts ya importados en el backend todavía — al crear uno aquí, su id queda precargado abajo para consultarlo.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0 flex flex-col gap-3">
        <div className="flex gap-2.5 flex-wrap items-end">
          <Label className={`${LABEL_CLASES} flex-1 min-w-[220px]`}>
            Id del payout
            <Input value={payoutId} onChange={(e) => setPayoutId(e.target.value)} placeholder="uuid del payout" />
          </Label>
          <Button type="button" variant="outline" size="sm" onClick={() => verPayout(payoutId)} disabled={cargando}>
            <Wallet className="w-4 h-4" strokeWidth={1.75} />
            {cargando ? "Consultando…" : "Ver payout"}
          </Button>
        </div>

        {error && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
        )}

        {detalle && <PayoutResumen detalle={detalle} />}

        {puedeEscribir && (
          <ImportarPayoutForm
            apiBaseUrl={apiBaseUrl}
            token={token}
            propertyId={propertyId}
            onCreado={(creado) => {
              setPayoutId(creado.id);
              setDetalle({ id: creado.id, propertyId, canalCodigo: creado.canalCodigo, moneda: creado.moneda, montoTotalCentavos: creado.montoTotalCentavos, fechaPayout: creado.fechaPayout, referenciaExterna: null, resumen: creado.resumen, lineas: creado.lineas });
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PayoutResumen({ detalle }: { detalle: PayoutDetalle }) {
  return (
    <div className="border-t border-border pt-2.5 flex flex-col gap-2">
      <p className="m-0 text-sm text-foreground">
        <strong>{detalle.canalCodigo}</strong> · {centavosAPesos(detalle.montoTotalCentavos)} {detalle.moneda} · pagado {detalle.fechaPayout}
        {detalle.referenciaExterna ? ` · ref. ${detalle.referenciaExterna}` : ""}
      </p>
      <p className="m-0 text-xs text-muted-foreground">
        {detalle.resumen.conciliadas} conciliadas · {detalle.resumen.pendientes} pendientes · {detalle.resumen.discrepancias} con discrepancia
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="h-8 px-2 text-xs">Referencia</TableHead>
            <TableHead className="h-8 px-2 text-xs">Reserva</TableHead>
            <TableHead className="h-8 px-2 text-xs text-right">Monto</TableHead>
            <TableHead className="h-8 px-2 text-xs text-right">Esperado</TableHead>
            <TableHead className="h-8 px-2 text-xs">Estado</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detalle.lineas.map((l, i) => (
            <TableRow key={i}>
              <TableCell className="p-2 text-xs">{l.referenciaExternaReserva ?? "—"}</TableCell>
              <TableCell className="p-2 text-xs">{l.ocupacionId ?? "sin match"}</TableCell>
              <TableCell className="p-2 text-xs text-right tabular-nums">{centavosAPesos(l.montoCentavos)}</TableCell>
              <TableCell className="p-2 text-xs text-right tabular-nums">{l.montoEsperadoCentavos !== null ? centavosAPesos(l.montoEsperadoCentavos) : "—"}</TableCell>
              <TableCell className="p-2 text-xs">
                <StatusBadge tone={statusTone(CONCILIACION_TONES, l.estado)}>{ESTADO_CONCILIACION_LABELS[l.estado] ?? l.estado}</StatusBadge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
