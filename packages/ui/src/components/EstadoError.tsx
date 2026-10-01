import { AlertTriangle } from "lucide-react";

import { cn } from "../lib/utils";

/**
 * `EstadoError` identico al de Likida (kit.tsx; spec UNI-3c 6.5): tarjeta p-4 con
 * chip de peligro (tinte + AlertTriangle de 17 px) y el boton "Reintentar" en
 * pildora, para un fallo de lectura explicito, nunca una pantalla en blanco ni
 * un stack trace. Cuando la causa es una integracion externa sin credenciales,
 * `integracion` nombra la integracion y el mensaje declara el estado "pendiente
 * de credenciales" (REQ-UX-002, ACEPTACION criterio 10).
 */
export function EstadoError({
  titulo = "No se pudo cargar la información",
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
  const descripcion =
    mensaje ??
    (integracion
      ? pendienteCredenciales
        ? `${integracion} está pendiente de credenciales. Conecta la integración para ver datos reales aquí.`
        : `No se pudo conectar con ${integracion}. Verifica la conexión e inténtalo de nuevo.`
      : "Ocurrió un problema al conectar con el servidor. Verifica la conexión e inténtalo de nuevo.");

  return (
    <div role="alert" className={cn("card flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card shadow-card", compacto ? "p-3" : "p-4", className)}>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive-tint">
        <AlertTriangle aria-hidden="true" className="size-[17px] text-destructive" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1 pt-0.5 text-sm">
        <p className="font-medium text-foreground">{titulo}</p>
        <p className="mt-0.5 text-muted-foreground">{descripcion}</p>
        {pendienteCredenciales && (
          <p className="mt-2 inline-flex items-center rounded-full border border-border bg-canvas px-2.5 py-0.5 font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground">
            Pendiente de credenciales
          </p>
        )}
        {onReintentar && (
          <div>
            <button
              type="button"
              onClick={onReintentar}
              className="mt-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-70"
            >
              Reintentar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
