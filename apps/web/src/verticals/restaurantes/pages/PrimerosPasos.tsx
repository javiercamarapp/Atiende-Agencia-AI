// R-33 -- "Primeros pasos": checklist de onboarding del restaurante calculado por el servidor con datos reales (sucursales, menu,
// horarios, coordenadas, cobertura, WhatsApp, agente, pedidos). Los pendientes del dueño o de terceros se ven tal cual (con su
// responsable y el enlace a la pantalla donde se cierran): nada se marca como hecho a mano ni se inventa.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { Button, Callout, EstadoCargando, EstadoError, PageContainer, PrimerosPasos, iniciarRecorridoGuia } from "@atiende/ui";
import type { PrimerPaso } from "@atiende/ui";
import { RESPONSABLE_LABEL, fetchOnboarding, omitirGate, type OnboardingChecklist, type OnboardingItem } from "../lib/onboarding-client.ts";
import { etiquetaRol } from "../../../lib/roles.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

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
          {/* ds3: patrón /setup de Rovaq: avance honesto («n de m que puedes hacer ahora»), recomendado, quién lo cierra y celebración. */}
          <PrimerosPasos
            pasos={checklist.items.map((item) => aPrimerPaso(item, orgSlug))}
            rolEtiqueta={etiquetaRol(role) ?? role}
            claveCelebracion={`restaurantes:${orgSlug}`}
            onRecorrido={() => iniciarRecorridoGuia("corto")}
          />
        </>
      )}
    </PageContainer>
  );
}
