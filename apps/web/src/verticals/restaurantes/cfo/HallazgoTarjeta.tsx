// CFO-07 · tarjeta de «Lo más importante»: título, cifra, comparación, por qué importa, acción (enlace al drill-down) e impacto en pesos
// o «no cuantificable». La de mayor impacto va primero y más grande, con la cifra del impacto en `Odometro` y semáforo con texto.
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { Hallazgo, Urgencia } from "@atiende/domain-restaurantes/cfo";
import { Card, CifraTexto, Odometro, Semaforo } from "@atiende/ui";
import type { EstadoSemaforo } from "@atiende/ui";
import { cn, useT } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesCfo } from "@atiende/ui/i18n/restaurantes/cfo";
import { ChipDeCifra } from "./piezas.tsx";
import { pesos } from "./formato.ts";

const SEMAFORO_URGENCIA: Readonly<Record<Urgencia, { readonly estado: EstadoSemaforo; readonly clave: Clave }>> = {
  alta: { estado: "rojo", clave: "restaurantes.cfo.urgencia.alta" },
  media: { estado: "ambar", clave: "restaurantes.cfo.urgencia.media" },
  baja: { estado: "verde", clave: "restaurantes.cfo.urgencia.baja" },
};

export interface HallazgoTarjetaProps {
  readonly hallazgo: Hallazgo;
  /** La primera: más grande y con el impacto en Odometro. */
  readonly destacada?: boolean;
  /** Enlace de la acción; null = la pestaña de destino aún no existe (se muestra el texto sin enlace). */
  readonly enlace: string | null;
}

export function HallazgoTarjeta({ hallazgo: h, destacada = false, enlace }: HallazgoTarjetaProps) {
  const t = useT(restaurantesCfo);
  const sem = SEMAFORO_URGENCIA[h.urgencia];
  const impacto = h.impactoCentavos;
  return (
    <Card data-testid="hallazgo" data-tipo={h.tipo} data-urgencia={h.urgencia} data-destacada={destacada ? "1" : undefined} className={cn("flex min-w-0 flex-col gap-2 p-4", destacada && "border-primary/40 md:col-span-2 lg:p-5")}>
      <div className="flex flex-wrap items-center gap-2">
        <Semaforo estado={sem.estado} texto={t(sem.clave)} />
        {h.sucursal && <span className="rounded-full border border-border px-2 py-0.5 text-2xs text-muted-foreground">{h.sucursal}</span>}
        <ChipDeCifra cifra={h.cifra} />
      </div>
      <div className={cn("flex flex-wrap items-start justify-between gap-3", destacada && "sm:flex-nowrap")}>
        <div className="min-w-0">
          <h3 className={cn("font-display font-semibold", destacada ? "text-lg" : "text-sm")}>{h.titulo}</h3>
          <p className={cn("mt-1 font-display font-semibold tabular-nums", destacada ? "text-3xl" : "text-xl")} data-testid="hallazgo-cifra">
            <CifraTexto texto={h.cifraTexto} />
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{h.comparacion}</p>
        </div>
        {destacada && impacto !== null && impacto >= 0 && (
          <div aria-hidden="true" className="shrink-0">
            <Odometro valor={Math.round(impacto / 100)} digitos={5} prefijo="$" etiqueta={t("restaurantes.cfo.enJuego")} tamano="md" className="items-end" />
          </div>
        )}
      </div>
      <p className="text-ui">
        <span className="font-medium">{t("restaurantes.cfo.porQueImporta")}</span>
        {h.porQueImporta}
      </p>
      <p className="text-ui" data-testid="hallazgo-impacto">
        <span className="font-medium">{t("restaurantes.cfo.impacto")}</span>
        {impacto === null ? t("restaurantes.cfo.noCuantificable") : t("restaurantes.cfo.montoEnJuego", { monto: pesos(impacto) })}
      </p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-line2 pt-2">
        {enlace ? (
          <Link to={enlace} className="inline-flex min-h-8 items-center gap-1 rounded-md text-ui font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="hallazgo-accion">
            {h.accion.texto}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        ) : (
          <p className="text-ui" data-testid="hallazgo-accion-sin-enlace">
            {h.accion.texto} <span className="text-xs text-muted-foreground">{t("restaurantes.cfo.prontoSeccion")}</span>
          </p>
        )}
        <p className="text-2xs text-muted-foreground">{t("restaurantes.cfo.fuente", { fuente: h.fuentes.join(", ") })}</p>

      </div>
    </Card>
  );
}
