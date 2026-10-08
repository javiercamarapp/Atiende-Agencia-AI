// CFO-07 · piezas compartidas de las pestañas del CFO: chip de confianza, avisos del servicio, estados de carga y aviso de no sustitución.
import type { ReactNode } from "react";
import { LockKeyhole, PlugZap } from "lucide-react";
import { AVISO_CFO } from "@atiende/domain-restaurantes/cfo";
import type { Cifra, Confianza, VistaCfoBase } from "@atiende/domain-restaurantes/cfo";
import { Badge, Callout, EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import { ETIQUETA_CONFIANZA } from "./formato.ts";
import { MENSAJE_SIN_ACCESO_CFO } from "./cfo-client.ts";
import type { CargaCfo } from "./use-carga-cfo.ts";

const VARIANTE: Readonly<Record<Confianza, "outline" | "warning" | "info" | "secondary">> = {
  medido: "outline",
  estimado: "warning",
  capturado: "info",
  importado: "secondary",
  sin_dato: "outline",
};

/**
 * Chip de confianza (siempre con TEXTO): estimado / capturado / SoftRestaurant. «Medido» solo se pinta si `mostrarMedido`
 * (en el estado de resultados cada línea lo lleva; en tarjetas sería ruido).
 */
export function ChipConfianza({ confianza, fuente, mostrarMedido = false }: { readonly confianza: Confianza; readonly fuente?: string; readonly mostrarMedido?: boolean }) {
  if (confianza === "medido" && !mostrarMedido) return null;
  return (
    <Badge variant={VARIANTE[confianza]} data-testid="chip-confianza" data-confianza={confianza} title={fuente ? `Fuente: ${fuente}` : undefined} className="px-1.5 py-0 text-2xs">
      {ETIQUETA_CONFIANZA[confianza]}
    </Badge>
  );
}

export function ChipDeCifra({ cifra, mostrarMedido }: { readonly cifra: Cifra; readonly mostrarMedido?: boolean }) {
  return <ChipConfianza confianza={cifra.confianza} fuente={cifra.fuente} {...(mostrarMedido ? { mostrarMedido } : {})} />;
}

/** Avisos del servicio («Sin datos de mostrador de SoftRestaurant», «Envío de comandas apagado», «Costo de Meta no medido») + bloques sin migrar. */
export function AvisosCfo({ vista }: { readonly vista: Pick<VistaCfoBase, "avisos" | "bloques" | "disponible"> }) {
  const faltantes: string[] = [];
  if (!vista.bloques.ventas) faltantes.push("ventas");
  if (!vista.bloques.clientes) faltantes.push("clientes y operación");
  if (!vista.bloques.captura) faltantes.push("captura de costos");
  if (vista.avisos.length === 0 && faltantes.length === 0) return null;
  return (
    <Callout tone={faltantes.length > 0 ? "warning" : "info"} titulo={faltantes.length > 0 ? "Datos incompletos" : "Avisos de los datos"} data-testid="cfo-avisos">
      {faltantes.length > 0 && <p>Todavía no hay datos de {faltantes.join(", ")} en este negocio: esas cifras aparecen como «—» y no se estiman.</p>}
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

/** Aviso de no sustitución (siempre visible en el CFO). */
export function AvisoNoSustitucion({ texto }: { readonly texto?: string }) {
  return (
    <p data-testid="cfo-aviso-legal" className="text-xs text-muted-foreground">
      {texto && texto.length > 0 ? texto : AVISO_CFO}
    </p>
  );
}

export function SinAccesoCfo() {
  return <EstadoVacio icon={LockKeyhole} titulo={MENSAJE_SIN_ACCESO_CFO} mensaje="El tablero financiero es solo para el dueño y los administradores. Si lo necesitas, pídele acceso al dueño del negocio." />;
}

export function NoDisponibleCfo() {
  return (
    <EstadoVacio
      icon={PlugZap}
      titulo="El CFO aún no está disponible"
      mensaje="Falta aplicar la actualización de base de datos de este módulo en tu negocio. Cuando esté lista, aquí verás tus cifras; mientras tanto no se muestra ningún dato."
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
