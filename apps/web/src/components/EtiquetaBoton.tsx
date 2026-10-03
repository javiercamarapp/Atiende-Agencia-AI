// Texto de un boton que cambia entre "reposo" y "ocupado" (p. ej. "Continuar con correo" / "Enviando…") SIN mover nada:
// ambos textos viven apilados en la misma celda de una rejilla y el inactivo va `invisible` (fuera del arbol de
// accesibilidad), asi el ancho y la posicion del texto no cambian al enviar y el nombre accesible es solo el visible.
import "../pages/login.css";

export interface EtiquetaBotonProps {
  readonly ocupado: boolean;
  readonly reposo: string;
  readonly enCurso: string;
}

export function EtiquetaBoton({ ocupado, reposo, enCurso }: EtiquetaBotonProps) {
  return (
    <span className="login-etiqueta">
      <span className={ocupado ? "invisible" : undefined}>{reposo}</span>
      <span className={ocupado ? undefined : "invisible"}>{enCurso}</span>
    </span>
  );
}
