// Rejilla de StatCard del tablero «Turno de hoy». Cada tarjeta con motivo de falta de dato usa el `sinDato` de StatCard («—» + explicacion).
import { StatCard } from "@atiende/ui";
import { Ban, Clock, CircleDollarSign, Flame, PackageCheck, Receipt, Timer, Trophy } from "lucide-react";
import type { ComponentProps } from "react";
import type { ClaveTarjeta, TarjetaTurno } from "../../lib/turno-hoy.ts";

const ICONO: Readonly<Record<ClaveTarjeta, ComponentProps<typeof StatCard>["icon"]>> = {
  pedidos: PackageCheck, ventas: CircleDollarSign, ticket: Receipt, puntuales: Clock, entrega: Timer, cancelados: Ban, horaPico: Flame, choferTop: Trophy,
};

export function TarjetasTurno({ tarjetas }: { readonly tarjetas: readonly TarjetaTurno[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tarjetas.map((t) => (
        <StatCard key={t.clave} icon={ICONO[t.clave]} label={t.label} value={t.value} {...(t.nota ? { nota: t.nota } : {})} {...(t.sinDato ? { sinDato: t.sinDato } : {})} />
      ))}
    </div>
  );
}
