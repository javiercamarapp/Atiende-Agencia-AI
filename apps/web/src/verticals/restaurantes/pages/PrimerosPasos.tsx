// R-33 -- "Primeros pasos": checklist de onboarding del restaurante calculado por el servidor con datos reales (sucursales, menu,
// horarios, coordenadas, cobertura, WhatsApp, agente, pedidos). Los pendientes del dueño o de terceros se ven tal cual (con su
// responsable y el enlace a la pantalla donde se cierran): nada se marca como hecho a mano ni se inventa.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, PageContainer, StatusBadge } from "@atiende/ui";
import { ESTADO_LABEL, RESPONSABLE_LABEL, fetchOnboarding, omitirGate, type OnboardingChecklist, type OnboardingEstado } from "../lib/onboarding-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const TONO: Record<OnboardingEstado, "success" | "warning" | "danger" | "info"> = { hecho: "success", parcial: "warning", pendiente: "danger", externo: "info" };

export function RestaurantesPrimerosPasosPage({ apiBaseUrl, token, propertyId, orgSlug }: RestaurantesShellContext) {
  const navigate = useNavigate();
  const [estado, setEstado] = useState<OnboardingChecklist | "cargando" | { error: string }>("cargando");

  const cargar = useCallback(() => {
    setEstado("cargando");
    fetchOnboarding(fetch, apiBaseUrl, token, propertyId)
      .then(setEstado)
      .catch((e: unknown) => setEstado({ error: e instanceof Error ? e.message : "No se pudo cargar el checklist." }));
  }, [apiBaseUrl, token, propertyId]);
  useEffect(cargar, [cargar]);

  const checklist = typeof estado === "object" && "items" in estado ? estado : null;
  return (
    <PageContainer padding="none">
      {/* El nombre de la pagina ya lo muestra la barra superior del shell (contrato de pagina UNI-4): solo queda el h1 para lectores de pantalla. */}
      <h1 className="sr-only">Primeros pasos</h1>
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={cargar} disabled={estado === "cargando"}>
          <RefreshCw className={estado === "cargando" ? "animate-spin" : undefined} />
          Actualizar
        </Button>
      </div>

      {estado === "cargando" && <EstadoCargando etiqueta="Revisando la configuración…" />}
      {typeof estado === "object" && "error" in estado && <EstadoError mensaje={estado.error} onReintentar={cargar} />}

      {checklist && (
        <>
          <Callout
            tone={checklist.listoParaOperar ? "success" : "warning"}
            titulo={checklist.listoParaOperar ? "Listo para operar" : "Faltan puntos obligatorios"}
            accion={
              checklist.gate.bloquea ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    omitirGate(orgSlug);
                    navigate(`/restaurantes/${orgSlug}`);
                  }}
                >
                  Ir al panel de todos modos
                </Button>
              ) : undefined
            }
          >
            {checklist.resumen.hechos} de {checklist.resumen.total} puntos listos
            {checklist.resumen.obligatoriosPendientes > 0 ? ` · ${checklist.resumen.obligatoriosPendientes} obligatorio(s) pendiente(s).` : "."} El estado se calcula con los datos reales de su negocio.{checklist.gate.operaConPedidos && checklist.resumen.obligatoriosPendientes > 0 ? " Su negocio ya opera con pedidos: esto no bloquea el panel." : ""}
          </Callout>
          <ul className="flex flex-col gap-2">
            {checklist.items.map((item) => (
              <li key={item.id}>
                <Card>
                  <CardContent className="flex flex-col gap-1.5 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="m-0 text-sm font-medium text-foreground">
                        {item.titulo}
                        {item.obligatorio && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(obligatorio)</span>}
                      </p>
                      <StatusBadge tone={TONO[item.estado]}>{ESTADO_LABEL[item.estado]}</StatusBadge>
                    </div>
                    <p className="m-0 text-xs text-muted-foreground">{item.detalle}</p>
                    {item.estado !== "hecho" && item.faltantes.length > 0 && <p className="m-0 text-xs text-foreground">Falta en: {item.faltantes.join(", ")}</p>}
                    {item.estado !== "hecho" && (
                      <p className="m-0 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                        <span>Lo cierra: {RESPONSABLE_LABEL[item.responsable]}</span>
                        <Link className="underline underline-offset-2" to={`/restaurantes/${orgSlug}/${item.pantalla}`}>
                          Ir a la pantalla
                        </Link>
                      </p>
                    )}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </PageContainer>
  );
}
