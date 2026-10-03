// Sección 3 de Finanzas: payouts de canal + conciliación (ver un payout por id; importar solo admin_gestora).
import { useState } from "react";
import { Plus, Wallet } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, EstadoError, FormField, Input, StatusBadge, statusTone } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { fetchPayoutDetalle } from "../../lib/finanzas-client.ts";
import type { LineaConciliada, PayoutDetalle } from "../../lib/finanzas-client.ts";
import { dineroDeCentavos } from "../../lib/pricing-client.ts";
import { CONCILIACION_TONES } from "../../lib/status-tones.ts";
import { formatFechaSolo } from "../../../../lib/formato-fecha.ts";
import { ESTADO_CONCILIACION_LABELS } from "./comunes.tsx";
import type { SectionProps } from "./comunes.tsx";
import { ImportarPayoutForm } from "./ImportarPayoutForm.tsx";

export function PayoutsSection({ apiBaseUrl, token, propertyId, puedeEscribir }: SectionProps) {
  const [payoutId, setPayoutId] = useState("");
  const [detalle, setDetalle] = useState<PayoutDetalle | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importando, setImportando] = useState(false);

  async function verPayout(id: string) {
    if (!id.trim()) return setError("Se necesita el id del payout.");
    setError(null);
    setCargando(true);
    try {
      setDetalle(await fetchPayoutDetalle(fetch, apiBaseUrl, token, propertyId, id.trim()));
    } catch (err) {
      setDetalle(null);
      setError(err instanceof Error ? err.message : "No se pudo cargar el payout.");
    } finally {
      setCargando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>Payouts de canal + conciliación</CardTitle>
          <CardDescription>No hay un listado de payouts ya importados en el backend todavía: al importar uno aquí, su id queda precargado para consultarlo.</CardDescription>
        </div>
        {puedeEscribir && (
          <Button type="button" size="sm" onClick={() => setImportando(true)}>
            <Plus /> Importar payout
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2.5">
          <FormField label="Id del payout" className="min-w-[220px] flex-1">
            <Input value={payoutId} onChange={(e) => setPayoutId(e.target.value)} placeholder="uuid del payout" />
          </FormField>
          <Button type="button" variant="outline" size="sm" onClick={() => void verPayout(payoutId)} loading={cargando} loadingText="Consultando…">
            <Wallet /> Ver payout
          </Button>
        </div>

        {error && <EstadoError compacto titulo="No se pudo completar" mensaje={error} />}

        {detalle && <PayoutResumen detalle={detalle} />}
      </CardContent>

      {importando && (
        <ImportarPayoutForm
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
          onCerrar={() => setImportando(false)}
          onCreado={(creado) => {
            setPayoutId(creado.id);
            setDetalle({
              id: creado.id,
              propertyId,
              canalCodigo: creado.canalCodigo,
              moneda: creado.moneda,
              montoTotalCentavos: creado.montoTotalCentavos,
              fechaPayout: creado.fechaPayout,
              referenciaExterna: null,
              resumen: creado.resumen,
              lineas: creado.lineas,
            });
          }}
        />
      )}
    </Card>
  );
}

function PayoutResumen({ detalle }: { detalle: PayoutDetalle }) {
  const columnas: readonly DataTableColumna<{ readonly linea: LineaConciliada; readonly n: number }>[] = [
    { id: "referencia", encabezado: "Referencia", principal: true, celda: ({ linea }) => linea.referenciaExternaReserva ?? "—" },
    { id: "reserva", encabezado: "Reserva", celda: ({ linea }) => linea.ocupacionId ?? "sin match" },
    { id: "monto", encabezado: "Monto", alinear: "right", celda: ({ linea }) => <span className="tabular-nums">{dineroDeCentavos(linea.montoCentavos, detalle.moneda)}</span> },
    {
      id: "esperado",
      encabezado: "Esperado",
      alinear: "right",
      celda: ({ linea }) => <span className="tabular-nums">{linea.montoEsperadoCentavos !== null ? dineroDeCentavos(linea.montoEsperadoCentavos, detalle.moneda) : "—"}</span>,
    },
    { id: "estado", encabezado: "Estado", celda: ({ linea }) => <StatusBadge tone={statusTone(CONCILIACION_TONES, linea.estado)}>{ESTADO_CONCILIACION_LABELS[linea.estado] ?? linea.estado}</StatusBadge> },
  ];
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2.5">
      <p className="m-0 text-sm text-foreground">
        <strong>{detalle.canalCodigo}</strong> · {dineroDeCentavos(detalle.montoTotalCentavos, detalle.moneda)} · pagado {formatFechaSolo(detalle.fechaPayout)}
        {detalle.referenciaExterna ? ` · ref. ${detalle.referenciaExterna}` : ""}
      </p>
      <p className="m-0 text-xs text-muted-foreground">
        {detalle.resumen.conciliadas} conciliadas · {detalle.resumen.pendientes} pendientes · {detalle.resumen.discrepancias} con discrepancia
      </p>
      <DataTable
        etiqueta="Líneas del payout"
        columnas={columnas}
        filas={detalle.lineas.map((linea, n) => ({ linea, n }))}
        obtenerId={({ n }) => `linea-${n}`}
        paginacion={false}
        vacio={{ titulo: "Sin líneas", mensaje: "Este payout no tiene líneas." }}
      />
    </div>
  );
}
