import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import { cn } from "../lib/utils";
import { pareceErrorTecnico } from "./ds3-error-textos";
import { useT } from "../i18n/proveedor";
import { comun } from "../i18n/mensajes/comun.ts";

/**
 * `EstadoError` identico al de Likida (kit.tsx; spec UNI-3c 6.5): tarjeta p-4 con
 * chip de peligro (tinte + AlertTriangle de 17 px) y el boton "Reintentar" en
 * pildora, para un fallo de lectura explicito, nunca una pantalla en blanco ni
 * un stack trace. Cuando la causa es una integracion externa sin credenciales,
 * `integracion` nombra la integracion y el mensaje declara el estado "pendiente
 * de credenciales" (REQ-UX-002, ACEPTACION criterio 10).
 */
export function EstadoError({
  titulo: tituloProp,
  mensaje,
  integracion,
  pendienteCredenciales = false,
  onReintentar,
  compacto = false,
  className,
}: {
  titulo?: string;
  mensaje?: string;
  /** Nombre de la integración externa que falló (ej. "PMS Cloudbeds", "API de Atiende Hoteles"). */
  integracion?: string;
  /** Marca el mensaje como bloqueo de credenciales en vez de error transitorio. */
  pendienteCredenciales?: boolean;
  onReintentar?: () => void;
  /** Relleno p-3 en lugar de p-4, para errores dentro de una tarjeta o tabla. */
  compacto?: boolean;
  className?: string;
}) {
  const t = useT(comun);
  const titulo = tituloProp ?? t("comun.error.titulo");
  const descripcion =
    mensaje ??
    (integracion
      ? pendienteCredenciales
        ? t("comun.error.pendienteCredenciales", { integracion })
        : t("comun.error.integracion", { integracion })
      : t("comun.error.servidor"));

  // ds3 (Rovaq «No disponible ahora»): un texto tecnico (codigo HTTP, nombre de excepcion, JSON...) no se le muestra a la persona; va
  // plegado en «Ver detalle técnico» y en su lugar sale una explicacion humana. Sin la bandera, el texto de siempre.
  const tecnico = mensaje !== undefined && pareceErrorTecnico(mensaje);
  const [verDetalle, setVerDetalle] = useState(false);

  return (
    <div role="alert" className={cn("ds3-error card flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card shadow-card", compacto ? "p-3" : "p-4", className)}>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive-tint">
        <AlertTriangle aria-hidden="true" className="size-[17px] text-destructive" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1 pt-0.5 text-sm">
        <p className="font-medium text-foreground">{titulo}</p>
        {tecnico && (
          <p hidden className="ds3-solo ds3-error-humano mt-0.5 text-muted-foreground">
            {t("comun.error.explicacionTecnica")}
          </p>
        )}
        {/* El texto tecnico sigue en el DOM una sola vez: sin la bandera es la descripcion de siempre; bajo ds3 se pliega (ds3-no) hasta
            «Ver detalle técnico». */}
        <p className={cn("mt-0.5 text-muted-foreground", tecnico && "ds3-error-tecnico", tecnico && !verDetalle && "ds3-no")}>{descripcion}</p>
        {pendienteCredenciales && (
          <p className="mt-2 inline-flex items-center rounded-full border border-border bg-canvas px-2.5 py-0.5 font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground">
            {t("comun.error.etiquetaPendiente")}
          </p>
        )}
        {onReintentar && (
          <div>
            <button
              type="button"
              onClick={onReintentar}
              className="ds3-reintentar mt-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-70"
            >
              {t("comun.reintentar")}
            </button>
          </div>
        )}
        {tecnico && (
          <button type="button" hidden aria-expanded={verDetalle} onClick={() => setVerDetalle((v) => !v)} className="ds3-solo ds3-error-ver">
            {verDetalle ? t("comun.error.ocultarDetalle") : t("comun.error.verDetalle")}
          </button>
        )}
        {/* ds3: sin handler propio (y si no es falta de credenciales, que no se arregla reintentando) «Reintentar» recarga la pantalla. */}
        {!onReintentar && !pendienteCredenciales && (
          <button type="button" hidden onClick={() => window.location.reload()} className="ds3-solo ds3-reintentar mt-2">
            {t("comun.reintentar")}
          </button>
        )}
      </div>
    </div>
  );
}
