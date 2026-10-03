// Sección 1 de Finanzas: movimiento financiero por reserva (lectura para admin_gestora y contador; registrar solo admin_gestora).
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  NativeSelect,
} from "@atiende/ui";
import { fetchMovimiento, fetchOcupaciones, fetchUnidades } from "../../lib/finanzas-client.ts";
import type { MovimientoDetalle, OcupacionCalendario, UnidadOption } from "../../lib/finanzas-client.ts";
import { LABEL_CLASES, Linea } from "./comunes.tsx";
import type { SectionProps } from "./comunes.tsx";
import { RegistrarMovimientoForm } from "./RegistrarMovimientoForm.tsx";

export function MovimientoSection({ apiBaseUrl, token, propertyId, puedeEscribir }: SectionProps) {
  const [unidades, setUnidades] = useState<readonly UnidadOption[] | null>(null);
  const [unidadId, setUnidadId] = useState("");
  const [ocupaciones, setOcupaciones] = useState<readonly OcupacionCalendario[] | null>(null);
  const [ocupacionId, setOcupacionId] = useState("");
  const [cargando, setCargando] = useState(false);
  const [movimiento, setMovimiento] = useState<MovimientoDetalle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const list = await fetchUnidades(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setUnidades(list);
        setUnidadId((current) => current || list[0]?.id || "");
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las unidades de esta propiedad.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    if (!unidadId) return;
    let cancelado = false;
    setOcupaciones(null);
    setOcupacionId("");
    setMovimiento(null);
    (async () => {
      try {
        const list = await fetchOcupaciones(fetch, apiBaseUrl, token, propertyId, unidadId);
        if (cancelado) return;
        const reservas = list.filter((o) => o.capa === "reserva");
        setOcupaciones(reservas);
        setOcupacionId(reservas[0]?.id || "");
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las reservas de esta unidad.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, unidadId]);

  async function handleVerMovimiento() {
    if (!ocupacionId) return;
    setError(null);
    setCargando(true);
    setMovimiento(null);
    try {
      const m = await fetchMovimiento(fetch, apiBaseUrl, token, propertyId, ocupacionId);
      setMovimiento(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el movimiento financiero.");
    } finally {
      setCargando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base font-semibold">Movimiento financiero por reserva</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 flex flex-col gap-3">
        <div className="flex gap-2.5 flex-wrap">
          <Label className={`${LABEL_CLASES} flex-1 min-w-[180px]`}>
            Unidad
            <NativeSelect value={unidadId} onChange={(e) => setUnidadId(e.target.value)} disabled={!unidades}>
              {!unidades && <option>Cargando…</option>}
              {unidades?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nombre}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Label className={`${LABEL_CLASES} flex-1 min-w-[220px]`}>
            Reserva
            <NativeSelect value={ocupacionId} onChange={(e) => setOcupacionId(e.target.value)} disabled={!ocupaciones || ocupaciones.length === 0}>
              {!ocupaciones && <option>Cargando…</option>}
              {ocupaciones && ocupaciones.length === 0 && <option>Sin reservas en esta unidad</option>}
              {ocupaciones?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.rango.inicio} → {o.rango.fin} {o.huespedNombre ? `· ${o.huespedNombre}` : ""} ({o.estado})
                </option>
              ))}
            </NativeSelect>
          </Label>
        </div>

        <Button type="button" variant="outline" size="sm" onClick={handleVerMovimiento} disabled={!ocupacionId || cargando} className="self-start">
          <Search className="w-4 h-4" strokeWidth={1.75} />
          {cargando ? "Consultando…" : "Ver movimiento registrado"}
        </Button>

        {error && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
        )}

        {movimiento && <MovimientoResumen m={movimiento} />}

        {puedeEscribir && ocupacionId && (
          <RegistrarMovimientoForm
            apiBaseUrl={apiBaseUrl}
            token={token}
            propertyId={propertyId}
            ocupacionId={ocupacionId}
            onRegistrado={(m) => setMovimiento(m)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function MovimientoResumen({ m }: { m: MovimientoDetalle }) {
  return (
    <div className="flex flex-col gap-1 text-sm border-t border-border pt-2.5">
      <Linea label="Ingreso bruto" valorCentavos={m.ingresoBrutoCentavos} moneda={m.moneda} />
      <Linea label={`Comisión de canal (${m.comisionCanalFuente})`} valorCentavos={-m.comisionCanalCentavos} moneda={m.moneda} />
      <Linea label="Monto recibido del canal" valorCentavos={m.montoRecibidoCentavos} moneda={m.moneda} />
      <Linea label="Comisión de gestor" valorCentavos={-m.comisionGestorCentavos} moneda={m.moneda} />
      <Linea label="Gastos" valorCentavos={-m.gastosCentavos} moneda={m.moneda} />
      <Linea label="Impuestos" valorCentavos={-m.impuestosCentavos} moneda={m.moneda} />
      <Linea label="Neto" valorCentavos={m.netoCentavos} moneda={m.moneda} fuerte />
    </div>
  );
}
