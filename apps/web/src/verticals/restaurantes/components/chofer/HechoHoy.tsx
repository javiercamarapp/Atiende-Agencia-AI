// «Hecho hoy» del chofer (PLAN-PANEL-OPERADOR §5.4 E): solo lo suyo, con numeros y sin datos de clientes. Cada tarjeta dice «—» con su motivo
// cuando el servidor aun no puede dar la cifra (p. ej. el efectivo por entregar necesita la actualizacion de base): nunca un 0 inventado.
import { useCallback, useEffect, useState } from "react";
import { EstadoCargando, EstadoError, StatCard, formatMoney } from "@atiende/ui";
import type { HoyChoferSalida } from "@atiende/domain-restaurantes/operacion";
import { Banknote, PackageCheck, Truck } from "lucide-react";
import { esFuncionNoDisponible, fetchHoyChofer } from "../../lib/repartidor-client.ts";

export interface HechoHoyProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly fetchImpl?: typeof fetch;
}

type Estado = { fase: "cargando" } | { fase: "error"; mensaje: string } | { fase: "no_disponible" } | { fase: "listo"; hoy: HoyChoferSalida };

export function HechoHoy({ apiBaseUrl, token, propertyId, fetchImpl = fetch }: HechoHoyProps) {
  const [estado, setEstado] = useState<Estado>({ fase: "cargando" });

  const cargar = useCallback(async () => {
    setEstado({ fase: "cargando" });
    try {
      setEstado({ fase: "listo", hoy: await fetchHoyChofer(fetchImpl, apiBaseUrl, token, propertyId) });
    } catch (err) {
      if (esFuncionNoDisponible(err, { rutaAusente: true })) setEstado({ fase: "no_disponible" });
      else setEstado({ fase: "error", mensaje: err instanceof Error ? err.message : "No se pudo cargar tu resumen del día." });
    }
  }, [apiBaseUrl, token, propertyId, fetchImpl]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (estado.fase === "cargando") return <EstadoCargando etiqueta="Cargando tu resumen…" />;
  if (estado.fase === "error") return <EstadoError mensaje={estado.mensaje} onReintentar={() => void cargar()} />;
  const hoy = estado.fase === "listo" ? estado.hoy : null;
  const sinServidor = "Disponible cuando el servidor del panel esté activo.";
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <StatCard icon={PackageCheck} label="Entregas de hoy" value={hoy ? String(hoy.entregasHoy) : "—"} {...(hoy ? {} : { sinDato: sinServidor })} />
      <StatCard icon={Truck} label="En camino ahora" value={hoy ? String(hoy.enCamino) : "—"} {...(hoy ? {} : { sinDato: sinServidor })} />
      <StatCard
        icon={Banknote}
        label="Efectivo por entregar"
        value={hoy?.efectivoPorEntregar != null ? `$${formatMoney(hoy.efectivoPorEntregar)}` : "—"}
        {...(hoy?.efectivoPorEntregar != null ? { nota: "Lo que cobraste en efectivo y falta rendir" } : { sinDato: hoy ? "Falta la actualización de base que registra los cobros." : sinServidor })}
        className="sm:col-span-2"
      />
    </div>
  );
}
