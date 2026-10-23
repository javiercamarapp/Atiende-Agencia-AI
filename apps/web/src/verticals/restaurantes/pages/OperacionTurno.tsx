// Turno de hoy (PLAN-PANEL-OPERADOR §5.4 D): tablero movil con las cifras reales de `GET admin/operacion/hoy`, refresco por sondeo de 15 s.
// Estados honestos: cargando, error con Reintentar, «no disponible aun» si el servidor no tiene la ruta (501/404) y «—» con motivo por tarjeta.
// Visible para quien tiene `turno.ver` (owner, admin, staff): el acceso real lo impone el servidor; aqui solo se pinta lo que devuelve.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, EstadoCargando, EstadoError, EstadoVacio, PageContainer, RadioSegmentado, formatMoney } from "@atiende/ui";
import type { OperacionHoy, TurnoHoy } from "@atiende/domain-restaurantes/operacion";
import { Hourglass, RefreshCw } from "lucide-react";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";
import { AlertasTurno } from "../components/hoy/AlertasTurno.tsx";
import { BarraCanales } from "../components/hoy/BarraCanales.tsx";
import { TarjetasTurno } from "../components/hoy/TarjetasTurno.tsx";
import { fetchOperacionHoy } from "../lib/hoy-client.ts";
import { esFuncionNoDisponible } from "../lib/repartidor-client.ts";
import { etiquetaActualizado } from "../lib/sondeo-pedidos.ts";
import { useSondeoPedidos } from "../lib/use-sondeo-pedidos.ts";
import { alertasTurno, canalesTurno, etiquetaCorte, tarjetasTurno } from "../lib/turno-hoy.ts";
import { SessionExpiredError } from "../lib/repartidor-client.ts";

export const SONDEO_TURNO_MS = 15_000;

type Carga = { fase: "cargando" } | { fase: "error"; mensaje: string } | { fase: "no_disponible" } | { fase: "listo" };
const OPCIONES = [
  { id: "actual", rotulo: "Turno actual" },
  { id: "dia", rotulo: "Todo el día" },
] as const;

export function OperacionTurnoPage({ apiBaseUrl, token, propertyId, nombreSucursal }: RestaurantesShellContext) {
  const [turno, setTurno] = useState<TurnoHoy>("actual");
  const [carga, setCarga] = useState<Carga>({ fase: "cargando" });
  const [datos, setDatos] = useState<OperacionHoy | null>(null);
  const [ahora, setAhora] = useState(() => Date.now());

  const consultar = useCallback(async () => {
    try {
      setDatos(await fetchOperacionHoy((...a) => fetch(...a), apiBaseUrl, token, propertyId, turno));
      setCarga({ fase: "listo" });
    } catch (err) {
      if (esFuncionNoDisponible(err, { rutaAusente: true })) {
        setCarga({ fase: "no_disponible" });
        return;
      }
      if (err instanceof SessionExpiredError) return;
      // Con cifras ya en pantalla se conservan (se indica la hora de la ultima actualizacion); sin ellas, error con Reintentar.
      setCarga((previo) => (previo.fase === "listo" ? previo : { fase: "error", mensaje: err instanceof Error ? err.message : "No se pudo cargar el turno." }));
      throw err;
    }
  }, [apiBaseUrl, token, propertyId, turno]);

  const sondeo = useSondeoPedidos({ clave: `${propertyId}:${turno}`, activo: carga.fase !== "no_disponible", consulta: consultar, baseMs: SONDEO_TURNO_MS });

  useEffect(() => {
    setCarga({ fase: "cargando" });
    setDatos(null);
    void consultar().catch(() => undefined);
    // Al montar y al cambiar de sucursal o de corte; `consultar` ya depende de ambos.
  }, [consultar]);

  useEffect(() => {
    const id = window.setInterval(() => setAhora(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const tarjetas = useMemo(() => (datos ? tarjetasTurno(datos) : []), [datos]);
  const canales = useMemo(() => (datos ? canalesTurno(datos.porCanal) : []), [datos]);
  const alertas = useMemo(() => (datos ? alertasTurno(datos.alertas) : []), [datos]);

  return (
    <PageContainer padding="default" className="mx-auto max-w-4xl gap-3">
      <h1 className="m-0 font-display text-xl font-semibold text-foreground">Turno de hoy{nombreSucursal ? ` · ${nombreSucursal}` : ""}</h1>

      {carga.fase === "no_disponible" ? (
        <EstadoVacio icon={Hourglass} titulo="Turno de hoy" mensaje="No disponible aún: el resumen del turno se activa cuando el servidor del panel del operador esté listo." />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <RadioSegmentado name="corte-turno" label="Corte" opciones={OPCIONES} value={turno} onChange={setTurno} />
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground" aria-live="polite">
                {datos ? `${etiquetaActualizado(sondeo.ultimaActualizacion, ahora)}` : ""}
              </span>
              <Button type="button" variant="outline" size="sm" className="h-14" loading={sondeo.consultando} onClick={() => sondeo.refrescar()} aria-label="Actualizar el turno">
                <RefreshCw />
                Actualizar
              </Button>
            </div>
          </div>
          {carga.fase === "cargando" && <EstadoCargando etiqueta="Cargando el turno…" />}
          {carga.fase === "error" && <EstadoError mensaje={carga.mensaje} onReintentar={() => sondeo.refrescar()} />}
          {carga.fase === "listo" && datos && (
            <>
              {sondeo.fallosSeguidos > 0 && (
                <p role="status" className="m-0 rounded-lg bg-warning-tint px-3 py-2 text-sm text-warning">
                  Sin conexión — reintentando. Las cifras pueden no estar al día.
                </p>
              )}
              <p className="m-0 text-sm text-muted-foreground" data-testid="corte-turno">
                Corte: {etiquetaCorte(datos.corte)}
              </p>
              <AlertasTurno alertas={alertas} />
              <TarjetasTurno tarjetas={tarjetas} />
              <BarraCanales canales={canales} />
              <EfectivoPorChofer datos={datos} />
            </>
          )}
        </>
      )}
    </PageContainer>
  );
}

function EfectivoPorChofer({ datos }: { readonly datos: OperacionHoy }) {
  const { disponible, choferes } = datos.efectivoPorChofer;
  return (
    <section aria-label="Efectivo por cuadrar por chofer" className="rounded-xl border border-border bg-card p-4">
      <h2 className="m-0 mb-2 text-base font-semibold text-foreground">Efectivo por cuadrar</h2>
      {!disponible ? (
        <p className="m-0 text-sm text-muted-foreground">— Disponible tras actualizar la base: falta el registro de cobros por chofer.</p>
      ) : choferes.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">Ningún chofer tiene efectivo por entregar en este corte.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {choferes.map((c) => (
            <li key={c.repartidorId} className="flex items-baseline justify-between gap-2 text-base text-foreground">
              <span>
                {c.nombre} <span className="text-sm text-muted-foreground">({c.entregas} {c.entregas === 1 ? "entrega" : "entregas"})</span>
              </span>
              <span className="tabular-nums font-semibold">${formatMoney(c.efectivoPorEntregar)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
