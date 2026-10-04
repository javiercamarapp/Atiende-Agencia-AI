// Sección 1 de Finanzas: movimiento financiero por reserva (lectura para admin_gestora y contador; registrar solo admin_gestora).
import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoError, FormField, NativeSelect } from "@atiende/ui";
import { fetchMovimiento, fetchOcupaciones, fetchUnidades } from "../../lib/finanzas-client.ts";
import type { MovimientoDetalle, OcupacionCalendario, UnidadOption } from "../../lib/finanzas-client.ts";
import { formatFechaSolo } from "../../../../lib/formato-fecha.ts";
import { Linea } from "./comunes.tsx";
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
  const [registrando, setRegistrando] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setError(null);
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
  }, [apiBaseUrl, token, propertyId, recarga]);

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
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Movimiento financiero por reserva</CardTitle>
        {puedeEscribir && (
          <Button type="button" size="sm" disabled={!ocupacionId} onClick={() => setRegistrando(true)}>
            <Plus /> Registrar movimiento
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Unidad">
            <NativeSelect value={unidadId} onChange={(e) => setUnidadId(e.target.value)} disabled={!unidades}>
              {!unidades && <option>Cargando…</option>}
              {unidades?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nombre}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Reserva">
            <NativeSelect value={ocupacionId} onChange={(e) => setOcupacionId(e.target.value)} disabled={!ocupaciones || ocupaciones.length === 0}>
              {!ocupaciones && <option>Cargando…</option>}
              {ocupaciones && ocupaciones.length === 0 && <option>Sin reservas en esta unidad</option>}
              {ocupaciones?.map((o) => (
                <option key={o.id} value={o.id}>
                  {formatFechaSolo(o.rango.inicio)} → {formatFechaSolo(o.rango.fin)} {o.huespedNombre ? `· ${o.huespedNombre}` : ""} ({o.estado})
                </option>
              ))}
            </NativeSelect>
          </FormField>
        </div>

        <Button type="button" variant="outline" size="sm" onClick={handleVerMovimiento} disabled={!ocupacionId} loading={cargando} loadingText="Consultando…" className="self-start">
          <Search /> Ver movimiento registrado
        </Button>

        {error && <EstadoError compacto titulo="No se pudo completar" mensaje={error} onReintentar={unidades ? undefined : () => setRecarga((n) => n + 1)} />}

        {movimiento && <MovimientoResumen m={movimiento} />}
      </CardContent>

      {registrando && ocupacionId && (
        <RegistrarMovimientoForm
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
          ocupacionId={ocupacionId}
          onCerrar={() => setRegistrando(false)}
          onRegistrado={(m) => setMovimiento(m)}
        />
      )}
    </Card>
  );
}

function MovimientoResumen({ m }: { m: MovimientoDetalle }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-2.5 text-sm">
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
