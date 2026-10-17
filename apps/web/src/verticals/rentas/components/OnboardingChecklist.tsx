// Rn-36 -- tarjeta compacta "Configura tu gestora" del Resumen de rentas: progreso (BarraProgreso) y un renglon por punto con su
// estado REAL (lo calcula el servidor con los datos de la organizacion) enlazado a la pantalla que lo resuelve. Componente
// independiente: el Resumen solo lo monta con una linea. Se oculta cuando no hay nada que mostrar (membership acotada, rol sin
// acceso o todo listo); un error de red se ve con su reintento, nunca se finge un estado.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronRight, Circle, Minus } from "lucide-react";
import { Card, CardContent, EstadoCargando, EstadoError, StatusBadge } from "@atiende/ui";
import { BarraProgreso } from "../../../components/BarraProgreso.tsx";
import { fetchChecklistOnboarding } from "../lib/onboarding-checklist-client.ts";
import type { ChecklistOnboarding, EstadoPuntoOnboarding } from "../lib/onboarding-checklist-client.ts";

export interface OnboardingChecklistProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
}

type Carga = "cargando" | { readonly error: string } | { readonly estado: "sin_acceso" } | { readonly estado: "ok"; readonly checklist: ChecklistOnboarding };

const ICONO: Record<EstadoPuntoOnboarding, typeof Check> = { hecho: Check, pendiente: Circle, no_disponible: Minus };
const ETIQUETA: Record<EstadoPuntoOnboarding, string> = { hecho: "Listo", pendiente: "Pendiente", no_disponible: "No disponible aún" };
const TONO: Record<EstadoPuntoOnboarding, "success" | "warning" | "neutral"> = { hecho: "success", pendiente: "warning", no_disponible: "neutral" };

export function OnboardingChecklist({ apiBaseUrl, token, propertyId, orgSlug }: OnboardingChecklistProps) {
  const [carga, setCarga] = useState<Carga>("cargando");

  const cargar = useCallback(() => {
    let cancelado = false;
    setCarga("cargando");
    fetchChecklistOnboarding(fetch, apiBaseUrl, token, propertyId)
      .then((r) => {
        if (!cancelado) setCarga(r);
      })
      .catch((e: unknown) => {
        if (!cancelado) setCarga({ error: e instanceof Error ? e.message : "No se pudo cargar el checklist." });
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);
  useEffect(() => cargar(), [cargar]);

  if (carga === "cargando") return <EstadoCargando variante="tarjeta" etiqueta="Revisando la configuración…" />;
  if ("error" in carga) return <EstadoError mensaje={carga.error} onReintentar={() => void cargar()} />;
  if (carga.estado === "sin_acceso") return null;

  const c = carga.checklist;
  // Nada medible (base sin migrar) o todo listo: no hay nada que pedirle al usuario.
  if (c.medibles === 0 || c.hechos === c.medibles) return null;

  return (
    <Card data-testid="onboarding-checklist">
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 text-sm font-semibold text-foreground">Configura tu gestora</h2>
            <span className="text-xs text-muted-foreground">
              {c.hechos} de {c.medibles} listos
            </span>
          </div>
          <BarraProgreso valor={c.porcentaje} tono={c.listoParaOperar ? "success" : "primary"} aria-label={`Configuración al ${c.porcentaje}%`} />
          <p className="m-0 text-xs text-muted-foreground">
            {c.listoParaOperar ? "Lo obligatorio está listo; faltan puntos recomendados." : "Faltan puntos obligatorios para operar. El estado sale de los datos reales de tu organización."}
          </p>
        </div>
        <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
          {c.puntos.map((p) => {
            const Icono = ICONO[p.estado];
            return (
              <li key={p.clave}>
                <Link to={`/rentas/${orgSlug}/${p.pantalla}`} className="flex min-w-0 items-center gap-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Icono className={p.estado === "hecho" ? "size-4 shrink-0 text-success" : "size-4 shrink-0 text-muted-foreground"} aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={p.estado === "hecho" ? "truncate text-sm text-muted-foreground" : "truncate text-sm font-medium text-foreground"}>
                      {p.titulo}
                      {p.obligatorio && p.estado !== "hecho" && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(obligatorio)</span>}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{p.detalle ?? p.descripcion}</span>
                  </span>
                  <StatusBadge tone={TONO[p.estado]}>{ETIQUETA[p.estado]}</StatusBadge>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
