// Formulario "Importar payout" (solo admin_gestora): sube las líneas normalizadas del reporte de un canal y concilia.
import { useState } from "react";
import type { FormEvent } from "react";
import { Plus } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  NativeSelect,
} from "@atiende/ui";
import { CANALES_PAYOUT, importarPayout, pesosACentavos } from "../../lib/finanzas-client.ts";
import type { PayoutCreado } from "../../lib/finanzas-client.ts";
import { LABEL_CLASES, NOTA_CLASES, nuevaKey } from "./comunes.tsx";

interface LineaPayoutRow {
  readonly key: string;
  referencia: string;
  monto: string;
}

export function ImportarPayoutForm({ apiBaseUrl, token, propertyId, onCreado }: { apiBaseUrl: string; token: string; propertyId: string; onCreado: (creado: PayoutCreado) => void }) {
  const [canalCodigo, setCanalCodigo] = useState(CANALES_PAYOUT[0]!.codigo);
  const [moneda, setMoneda] = useState("MXN");
  const [fechaPayout, setFechaPayout] = useState("");
  const [referenciaExterna, setReferenciaExterna] = useState("");
  const [lineas, setLineas] = useState<readonly LineaPayoutRow[]>([{ key: nuevaKey(), referencia: "", monto: "" }]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ultimoResumen, setUltimoResumen] = useState<string | null>(null);

  function agregarLinea() {
    setLineas((prev) => [...prev, { key: nuevaKey(), referencia: "", monto: "" }]);
  }
  function actualizarLinea(key: string, patch: Partial<LineaPayoutRow>) {
    setLineas((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function quitarLinea(key: string) {
    setLineas((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!/^[A-Za-z]{3}$/.test(moneda)) return setError("Moneda: se esperan 3 letras (código ISO 4217), ej. MXN.");
    if (!fechaPayout) return setError("La fecha del payout es requerida.");
    if (lineas.length === 0) return setError("Se necesita al menos una línea.");
    for (const l of lineas) {
      if (!l.monto || Number.isNaN(Number(l.monto)) || Number(l.monto) < 0) return setError("Cada línea necesita un monto válido.");
    }

    setGuardando(true);
    try {
      const creado = await importarPayout(fetch, apiBaseUrl, token, propertyId, {
        canalCodigo,
        moneda: moneda.toUpperCase(),
        fechaPayout,
        referenciaExterna: referenciaExterna.trim() || null,
        lineas: lineas.map((l) => ({ referenciaExternaReserva: l.referencia.trim() || null, montoCentavos: pesosACentavos(Number(l.monto)) })),
      });
      onCreado(creado);
      setUltimoResumen(`Payout ${creado.id}: ${creado.resumen.conciliadas} conciliadas · ${creado.resumen.pendientes} pendientes · ${creado.resumen.discrepancias} con discrepancia.`);
      setFechaPayout("");
      setReferenciaExterna("");
      setLineas([{ key: nuevaKey(), referencia: "", monto: "" }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo importar el payout.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card className="border-dashed">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold">Importar payout</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex gap-2.5 flex-wrap">
            <Label className={`${LABEL_CLASES} flex-1 min-w-[150px]`}>
              Canal
              <NativeSelect value={canalCodigo} onChange={(e) => setCanalCodigo(e.target.value)}>
                {CANALES_PAYOUT.map((c) => (
                  <option key={c.codigo} value={c.codigo}>
                    {c.nombre}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label className={`${LABEL_CLASES} w-[90px]`}>
              Moneda
              <Input value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} required placeholder="MXN" />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[140px]`}>
              Fecha de pago
              <Input type="date" value={fechaPayout} onChange={(e) => setFechaPayout(e.target.value)} required />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[160px]`}>
              Referencia externa (opcional)
              <Input value={referenciaExterna} onChange={(e) => setReferenciaExterna(e.target.value)} placeholder="Id del reporte del canal" />
            </Label>
          </div>

          <div>
            <p className="m-0 mb-1.5 text-sm text-foreground">Líneas del payout (según el reporte del canal, ya normalizadas)</p>
            {lineas.map((l) => (
              <div key={l.key} className="flex gap-2.5 flex-wrap mb-1.5">
                <Input
                  value={l.referencia}
                  onChange={(e) => actualizarLinea(l.key, { referencia: e.target.value })}
                  placeholder="Referencia externa de la reserva (opcional)"
                  className="flex-1 min-w-[200px]"
                />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={l.monto}
                  onChange={(e) => actualizarLinea(l.key, { monto: e.target.value })}
                  placeholder="Monto"
                  required
                  className="w-[110px]"
                />
                <Button type="button" variant="outline" size="sm" onClick={() => quitarLinea(l.key)} disabled={lineas.length === 1}>
                  Quitar
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={agregarLinea}>
              <Plus className="w-4 h-4" strokeWidth={1.75} />+ Agregar línea
            </Button>
          </div>

          {error && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={guardando} className="self-start">
            {guardando ? "Importando…" : "Importar payout"}
          </Button>
          {ultimoResumen && <p className={NOTA_CLASES}>{ultimoResumen}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
