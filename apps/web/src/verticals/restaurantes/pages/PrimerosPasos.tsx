// R-33 -- "Primeros pasos": checklist de onboarding del restaurante calculado por el servidor con datos reales (sucursales, menu,
// horarios, coordenadas, cobertura, WhatsApp, agente, pedidos). Los pendientes del dueño o de terceros se ven tal cual (con su
// responsable y el enlace a la pantalla donde se cierran): nada se marca como hecho a mano ni se inventa.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, PageContainer, PrimerosPasos, StatusBadge, iniciarRecorridoGuia, leerDisenoDs3, useT } from "@atiende/ui";
import type { PrimerPaso } from "@atiende/ui";
import { restaurantesOnboarding } from "@atiende/ui/i18n/restaurantes/onboarding";
import { ESTADO_LABEL, RESPONSABLE_LABEL, fetchOnboarding, omitirGate, type OnboardingChecklist, type OnboardingEstado, type OnboardingItem } from "../lib/onboarding-client.ts";
import { etiquetaRol } from "../../../lib/roles.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const TONO: Record<OnboardingEstado, "success" | "warning" | "danger" | "info"> = { hecho: "success", parcial: "warning", pendiente: "danger", externo: "info" };

/** Un punto del checklist del servidor como tarjeta de «Primeros pasos». Son «tuyos» los que cierra el dueño y los de Meta (el número lo
 *  captura el dueño en Configuración con lo que Meta le da); los de la plataforma o del distribuidor del POS no cuentan para su avance. */
export function aPrimerPaso(item: OnboardingItem, orgSlug: string): PrimerPaso {
  return {
    id: item.id,
    titulo: item.titulo,
    detalle: item.detalle,
    estado: item.estado,
    obligatorio: item.obligatorio,
    responsable: RESPONSABLE_LABEL[item.responsable],
    faltantes: item.estado === "hecho" ? [] : item.faltantes,
    href: `/restaurantes/${orgSlug}/${item.pantalla}`,
    puedeHacerlo: item.responsable === "dueno" || item.responsable === "meta",
  };
}

export function RestaurantesPrimerosPasosPage({ apiBaseUrl, token, propertyId, orgSlug, role }: RestaurantesShellContext) {
  const t = useT(restaurantesOnboarding);
  const navigate = useNavigate();
  // ds3: el patrón /setup de Rovaq (y su «Hacer el recorrido», que solo funciona con la guía) vive bajo la bandera; sin ella, la lista de siempre.
  const [ds3] = useState(leerDisenoDs3);
  const [estado, setEstado] = useState<OnboardingChecklist | "cargando" | { error: string }>("cargando");

  const cargar = useCallback(() => {
    setEstado("cargando");
    fetchOnboarding(fetch, apiBaseUrl, token, propertyId)
      .then(setEstado)
      .catch((e: unknown) => setEstado({ error: e instanceof Error ? e.message : t("restaurantes.onboarding.error.cargar") }));
  }, [apiBaseUrl, token, propertyId]);
  useEffect(cargar, [cargar]);

  const checklist = typeof estado === "object" && "items" in estado ? estado : null;
  return (
    <PageContainer padding="none">
      {/* El nombre de la pagina ya lo muestra la barra superior del shell (contrato de pagina UNI-4): solo queda el h1 para lectores de pantalla. */}
      <h1 className="sr-only">{t("restaurantes.onboarding.titulo")}</h1>
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={cargar} disabled={estado === "cargando"}>
          <RefreshCw className={estado === "cargando" ? "animate-spin" : undefined} />
          {t("restaurantes.onboarding.actualizar")}
        </Button>
      </div>

      {estado === "cargando" && <EstadoCargando etiqueta={t("restaurantes.onboarding.revisando")} />}
      {typeof estado === "object" && "error" in estado && <EstadoError mensaje={estado.error} onReintentar={cargar} />}

      {checklist && (
        <>
          <Callout
            tone={checklist.listoParaOperar ? "success" : "warning"}
            titulo={t(checklist.listoParaOperar ? "restaurantes.onboarding.listo" : "restaurantes.onboarding.faltan")}
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
                  {t("restaurantes.onboarding.irPanel")}
                </Button>
              ) : undefined
            }
          >
            {t("restaurantes.onboarding.puntosListos", { hechos: checklist.resumen.hechos, total: checklist.resumen.total })}
            {checklist.resumen.obligatoriosPendientes > 0 ? t("restaurantes.onboarding.obligatoriosPendientes", { n: checklist.resumen.obligatoriosPendientes }) : t("restaurantes.onboarding.punto")}
            {t("restaurantes.onboarding.calculo")}
            {checklist.gate.operaConPedidos && checklist.resumen.obligatoriosPendientes > 0 ? t("restaurantes.onboarding.operaConPedidos") : ""}
          </Callout>
          {!checklist.listoParaOperar && (
            <Callout
              tone="info"
              titulo={t("restaurantes.onboarding.rutaCorta.titulo")}
              accion={
                <Link className="text-xs underline underline-offset-2" to={`/restaurantes/${orgSlug}/primer-valor`}>
                  {t("restaurantes.onboarding.rutaCorta.empezar")}
                </Link>
              }
            >
              {t("restaurantes.onboarding.rutaCorta.texto")}
            </Callout>
          )}
          {ds3 ? (
            /* ds3: patrón /setup de Rovaq: avance honesto («n de m que puedes hacer ahora»), recomendado, quién lo cierra y celebración. */
            <PrimerosPasos
              pasos={checklist.items.map((item) => aPrimerPaso(item, orgSlug))}
              rolEtiqueta={etiquetaRol(role) ?? role}
              claveCelebracion={`restaurantes:${orgSlug}`}
              onRecorrido={() => iniciarRecorridoGuia("corto")}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {checklist.items.map((item) => (
                <li key={item.id}>
                  <Card>
                    <CardContent className="flex flex-col gap-1.5 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="m-0 text-sm font-medium text-foreground">
                          {item.titulo}
                          {item.obligatorio && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{t("restaurantes.onboarding.obligatorio")}</span>}
                        </p>
                        <StatusBadge tone={TONO[item.estado]}>{ESTADO_LABEL[item.estado]}</StatusBadge>
                      </div>
                      <p className="m-0 text-xs text-muted-foreground">{item.detalle}</p>
                      {item.estado !== "hecho" && item.faltantes.length > 0 && <p className="m-0 text-xs text-foreground">{t("restaurantes.onboarding.faltaEn", { lista: item.faltantes.join(", ") })}</p>}
                      {item.estado !== "hecho" && (
                        <p className="m-0 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                          <span>{t("restaurantes.onboarding.loCierra", { responsable: RESPONSABLE_LABEL[item.responsable] })}</span>
                          <Link className="underline underline-offset-2" to={`/restaurantes/${orgSlug}/${item.pantalla}`}>
                            {t("restaurantes.onboarding.irPantalla")}
                          </Link>
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PageContainer>
  );
}
