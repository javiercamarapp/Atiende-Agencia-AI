// CFO-07 · piezas compartidas de las pestañas del CFO: chip de confianza, avisos del servicio, estados de carga y aviso de no sustitución.
import type { ReactNode } from "react";
import { LockKeyhole, PlugZap } from "lucide-react";
import { AVISO_CFO } from "@atiende/domain-restaurantes/cfo";
import type { Cifra, Confianza, VistaCfoBase } from "@atiende/domain-restaurantes/cfo";
import { Callout, EstadoCargando, EstadoError, EstadoVacio, StatusBadge, useI18n, useT } from "@atiende/ui";
import { restaurantesCfo } from "@atiende/ui/i18n/restaurantes/cfo";
import type { StatusTone } from "@atiende/ui";
import { ETIQUETA_CONFIANZA } from "./formato.ts";
import type { CargaCfo } from "./use-carga-cfo.ts";

const TONO: Readonly<Record<Confianza, StatusTone>> = {
  medido: "neutral",
  estimado: "warning",
  capturado: "info",
  importado: "success",
  sin_dato: "neutral",
};

/**
 * Chip de confianza (siempre con TEXTO): estimado / capturado / SoftRestaurant. «Medido» solo se pinta si `mostrarMedido`
 * (en el estado de resultados cada línea lo lleva; en tarjetas sería ruido).
 */
export function ChipConfianza({ confianza, fuente, mostrarMedido = false }: { readonly confianza: Confianza; readonly fuente?: string; readonly mostrarMedido?: boolean }) {
  const t = useT(restaurantesCfo);
  if (confianza === "medido" && !mostrarMedido) return null;
  return (
    <StatusBadge tone={TONO[confianza]} data-testid="chip-confianza" data-confianza={confianza} title={fuente ? t("restaurantes.cfo.fuente", { fuente }) : undefined} className="px-1.5 py-0 text-2xs">
      {ETIQUETA_CONFIANZA[confianza]}
    </StatusBadge>
  );
}

export function ChipDeCifra({ cifra, mostrarMedido }: { readonly cifra: Cifra; readonly mostrarMedido?: boolean }) {
  return <ChipConfianza confianza={cifra.confianza} fuente={cifra.fuente} {...(mostrarMedido ? { mostrarMedido } : {})} />;
}

/** Avisos del servicio («Sin datos de mostrador de SoftRestaurant», «Envío de comandas apagado», «Costo de Meta no medido») + bloques sin migrar. */
export function AvisosCfo({ vista }: { readonly vista: Pick<VistaCfoBase, "avisos" | "bloques" | "disponible"> }) {
  const t = useT(restaurantesCfo);
  const faltantes: string[] = [];
  if (!vista.bloques.ventas) faltantes.push(t("restaurantes.cfo.faltaVentas"));
  if (!vista.bloques.clientes) faltantes.push(t("restaurantes.cfo.faltaClientes"));
  if (!vista.bloques.captura) faltantes.push(t("restaurantes.cfo.faltaCaptura"));
  if (vista.avisos.length === 0 && faltantes.length === 0) return null;
  return (
    <Callout tone={faltantes.length > 0 ? "warning" : "info"} titulo={t(faltantes.length > 0 ? "restaurantes.cfo.datosIncompletos" : "restaurantes.cfo.avisosDatos")} data-testid="cfo-avisos">
      {faltantes.length > 0 && <p>{t("restaurantes.cfo.sinDatosDe", { lista: faltantes.join(", ") })}</p>}
      {vista.avisos.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4">
          {vista.avisos.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
    </Callout>
  );
}

/** Aviso de no sustitución (siempre visible en el CFO). El del servidor viene en espanol: en ingles, si es el aviso estandar, va el del catalogo. */
export function AvisoNoSustitucion({ texto }: { readonly texto?: string }) {
  const { t, idioma } = useI18n(restaurantesCfo);
  const propio = texto && texto.length > 0 ? texto : AVISO_CFO;
  return (
    <p data-testid="cfo-aviso-legal" className="text-xs text-muted-foreground">
      {idioma !== "es" && propio === AVISO_CFO ? t("restaurantes.cfo.avisoLegal") : propio}
    </p>
  );
}

export function SinAccesoCfo() {
  const t = useT(restaurantesCfo);
  return <EstadoVacio icon={LockKeyhole} titulo={t("restaurantes.cfo.sinAcceso")} mensaje={t("restaurantes.cfo.sinAccesoMensaje")} />;
}

export function NoDisponibleCfo() {
  const t = useT(restaurantesCfo);
  return (
    <EstadoVacio
      icon={PlugZap}
      titulo={t("restaurantes.cfo.noDisponibleTitulo")}
      mensaje={t("restaurantes.cfo.noDisponibleMensaje")}
    />
  );
}


/** Pinta el estado de una carga y, solo con datos, llama a `children`. */
export function CargaCfoVista<T>({ carga, onReintentar, etiqueta, children }: { readonly carga: CargaCfo<T>; readonly onReintentar: () => void; readonly etiqueta: string; readonly children: (datos: T) => ReactNode }) {
  switch (carga.estado) {
    case "cargando":
      return <EstadoCargando etiqueta={etiqueta} />;
    case "sin_acceso":
      return <SinAccesoCfo />;
    case "no_disponible":
      return <NoDisponibleCfo />;
    case "error":
      return <EstadoError mensaje={carga.mensaje} onReintentar={onReintentar} />;
    case "listo":
      return <>{children(carga.datos)}</>;
  }
}
