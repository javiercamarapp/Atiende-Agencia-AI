// Banner persistente de agregados por validar: aparece en CUALQUIER pantalla del panel mientras haya pendientes (no se cierra solo ni se puede silenciar; solo el
// sonido). Con el sonido activado (el mismo toque que en la Cola) repite el aviso de dos tonos cada 60 s. En la propia pantalla de Agregados no se muestra
// (esa pantalla ya tiene su banner y su sonido).
import { useEffect, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { ListPlus } from "lucide-react";
import { AvisoPagina, useT } from "@atiende/ui";
import { restaurantesAgregados } from "@atiende/ui/i18n/restaurantes/agregados";
import { crearAlertaRepetida, vibrarAviso } from "../../lib/alerta-pedido-nuevo.ts";
import { textoPendientes } from "../../lib/agregados-presentacion.ts";
import { leerSonido, reproducirAviso } from "../../lib/sondeo-pedidos.ts";
import { useAgregadosPendientes } from "../../lib/use-agregados-pendientes.ts";

export function rutaAgregados(orgSlug: string): string {
  return `/restaurantes/${orgSlug}/operacion/agregados`;
}

export function BannerAgregados({ apiBaseUrl, token, propertyId, orgSlug, activo }: { readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly orgSlug: string; readonly activo: boolean }) {
  const t = useT(restaurantesAgregados);
  const { pathname } = useLocation();
  const destino = rutaAgregados(orgSlug);
  const enLaPantalla = pathname.startsWith(destino);
  const { pendientes } = useAgregadosPendientes({ apiBaseUrl, token, propertyId, orgSlug, activo });
  const alerta = useMemo(() => crearAlertaRepetida({ reproducir: reproducirAviso, vibrar: vibrarAviso, intervaloMs: 60_000 }), []);
  const sonido = (() => {
    try {
      return typeof window !== "undefined" && leerSonido(window.localStorage, orgSlug, propertyId);
    } catch {
      return false;
    }
  })();
  const debeSonar = activo && sonido && pendientes > 0 && !enLaPantalla;
  useEffect(() => {
    if (debeSonar) alerta.iniciar();
    else alerta.detener();
    return () => alerta.detener();
  }, [alerta, debeSonar]);

  if (!activo || pendientes === 0 || enLaPantalla) return null;
  // Va en la ranura de avisos de la pantalla (debajo de su encabezado), no entre el antetitulo y el contenido (auditoria R2 #5).
  return (
    <AvisoPagina>
      {/* Aviso de Rovaq con el azul de Atiende (auditoria R2 #8): tinte suave con borde de 1 px teñido, texto 13 px y la accion como primario
          suave de 32 px y radio de control (8 px bajo ds3), no una pildora solida de 48 px con borde de 2 px. */}
      <div role="status" aria-live="polite" data-testid="banner-agregados-global" className="ds3-aviso mb-3 flex flex-wrap items-center justify-between gap-2 rounded-control border border-primary/30 bg-primary-soft px-3 py-2">
        <p className="ds3-aviso-texto flex items-center gap-2 text-ui font-semibold text-foreground">
          <ListPlus className="size-4 shrink-0 text-primary-ink" aria-hidden="true" />
          {textoPendientes(pendientes)}
        </p>
        <Link
          to={destino}
          className="ds3-aviso-cta inline-flex h-8 items-center rounded-control border border-primary/30 bg-card px-3 text-ui font-medium text-primary-ink transition-colors duration-fast ease-brand hover:bg-primary-soft-hover"
        >
          {t("restaurantes.agregados.validarAhora")}
        </Link>
      </div>
    </AvisoPagina>
  );
}
