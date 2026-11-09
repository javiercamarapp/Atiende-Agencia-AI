import { useState } from "react";

import { useT } from "../i18n/proveedor";
import { carga } from "../i18n/mensajes/carga.ts";
import { limpiarCacheYRecargar, type EntornoRecuperacion } from "../lib/recuperar-carga";
import { EstadoError } from "./EstadoError";

export interface RecuperarCargaProps {
  /** Solo para pruebas: reemplaza CacheStorage, service workers y la recarga real. */
  readonly entorno?: EntornoRecuperacion;
}

/**
 * Pantalla que no cargo (chunk roto): `EstadoError` con «Reintentar» (recarga la pagina; reintentar el render no sirve porque
 * React.lazy guarda el rechazo) y, como segundo paso, «Limpiar caché y recargar». Va en la entrada: sin dependencias nuevas.
 */
export function RecuperarCarga({ entorno }: RecuperarCargaProps) {
  const t = useT(carga);
  const [limpiando, setLimpiando] = useState(false);
  const recargar = entorno?.recargar ?? (() => window.location.reload());
  return (
    <div className="flex flex-col gap-2">
      <EstadoError titulo={t("carga.titulo")} mensaje={t("carga.mensaje")} onReintentar={recargar} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
        <span>{t("carga.ayudaCache")}</span>
        <button
          type="button"
          disabled={limpiando}
          aria-busy={limpiando}
          onClick={() => {
            setLimpiando(true);
            void limpiarCacheYRecargar(entorno);
          }}
          className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-opacity hover:opacity-70 disabled:opacity-50"
        >
          {limpiando ? t("carga.limpiando") : t("carga.limpiarCache")}
        </button>
      </div>
    </div>
  );
}
