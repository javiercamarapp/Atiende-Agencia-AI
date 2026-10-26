// Banner persistente de agregados por validar: aparece en CUALQUIER pantalla del panel mientras haya pendientes (no se cierra solo ni se puede silenciar; solo el
// sonido). Con el sonido activado (el mismo toque que en la Cola) repite el aviso de dos tonos cada 60 s. En la propia pantalla de Agregados no se muestra
// (esa pantalla ya tiene su banner y su sonido).
import { useEffect, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { ListPlus } from "lucide-react";
import { crearAlertaRepetida, vibrarAviso } from "../../lib/alerta-pedido-nuevo.ts";
import { textoPendientes } from "../../lib/agregados-presentacion.ts";
import { leerSonido, reproducirAviso } from "../../lib/sondeo-pedidos.ts";
import { useAgregadosPendientes } from "../../lib/use-agregados-pendientes.ts";

export function rutaAgregados(orgSlug: string): string {
  return `/restaurantes/${orgSlug}/operacion/agregados`;
}

export function BannerAgregados({ apiBaseUrl, token, propertyId, orgSlug, activo }: { readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly orgSlug: string; readonly activo: boolean }) {
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
  return (
    <div role="status" aria-live="polite" data-testid="banner-agregados-global" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border-2 border-primary bg-card p-3">
      <p className="flex items-center gap-2 text-base font-bold text-foreground">
        <ListPlus className="size-5 shrink-0 text-primary" aria-hidden="true" />
        {textoPendientes(pendientes)}
      </p>
      <Link to={destino} className="inline-flex h-12 items-center rounded-full bg-primary px-5 text-base font-semibold text-primary-foreground">
        Validar ahora
      </Link>
    </div>
  );
}
