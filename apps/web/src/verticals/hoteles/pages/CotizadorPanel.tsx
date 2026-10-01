// Cotizador (H-35) -- consulta de precio por tipo de habitacion y fechas contra el motor determinista del servidor
// (tarifas reales por noche, IVA e ISH). No reserva ni descuenta inventario: solo muestra el precio. Un error del motor
// (sin tarifa, cerrado a la llegada, estadia minima) se muestra tal cual, nunca se inventa un precio.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Card, CardContent, Input, Label, NativeSelect } from "@atiende/ui";
import { cotizar, validarCotizacion } from "../lib/cotizador-client.ts";
import type { Cotizacion } from "../lib/cotizador-client.ts";
import { fetchRoomTypes } from "../lib/reservas-client.ts";
import type { RoomTypeOption } from "../lib/reservas-client.ts";
import { dineroMx } from "../lib/dinero.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";

export interface CotizadorPanelProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

export function CotizadorPanel({ apiBaseUrl, token, propertyId }: CotizadorPanelProps) {
  const [tipos, setTipos] = useState<readonly RoomTypeOption[] | null>(null);
  const [roomTypeId, setRoomTypeId] = useState("");
  const [entrada, setEntrada] = useState("");
  const [salida, setSalida] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Cotizacion | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const lista = await fetchRoomTypes(fetch, apiBaseUrl, token, propertyId);
        if (!cancelled) setTipos(lista);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "No se pudo cargar el catálogo de tipos de habitación.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalido = validarCotizacion(roomTypeId, entrada, salida);
    if (invalido) return setError(invalido);
    setBusy(true);
    setError(null);
    setResultado(null);
    try {
      setResultado(await cotizar(fetch, apiBaseUrl, token, propertyId, { roomTypeId, checkInDate: entrada, checkOutDate: salida }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cotizar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-md">
      <CardContent className="p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Cotizador</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <Label htmlFor="cot-tipo">Tipo de habitación</Label>
            <NativeSelect id="cot-tipo" value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)}>
              <option value="">{tipos === null ? "Cargando…" : "Selecciona un tipo"}</option>
              {tipos?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.nombre}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <Label htmlFor="cot-entrada">Llegada</Label>
              <Input id="cot-entrada" type="date" value={entrada} onChange={(e) => setEntrada(e.target.value)} />
            </div>
            <div className="flex-1">
              <Label htmlFor="cot-salida">Salida</Label>
              <Input id="cot-salida" type="date" value={salida} onChange={(e) => setSalida(e.target.value)} />
            </div>
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Cotizando…" : "Cotizar"}
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {resultado && (
          <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm text-foreground">
            <p className="font-medium">
              {resultado.nights} noche{resultado.nights === 1 ? "" : "s"} · {resultado.currency}
            </p>
            {resultado.nightlyBreakdown.map((n) => (
              <p key={n.date} className="flex justify-between text-xs text-muted-foreground">
                <span>{formatFechaSolo(n.date)}</span>
                <span>{dineroMx(n.price)}</span>
              </p>
            ))}
            <p className="flex justify-between">
              <span>Neto</span>
              <span>{dineroMx(resultado.netAmount)}</span>
            </p>
            <p className="flex justify-between">
              <span>IVA</span>
              <span>{dineroMx(resultado.ivaAmount)}</span>
            </p>
            <p className="flex justify-between">
              <span>ISH</span>
              <span>{dineroMx(resultado.ishAmount)}</span>
            </p>
            <p className="flex justify-between font-semibold">
              <span>Total</span>
              <span>{dineroMx(resultado.totalAmount)}</span>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
