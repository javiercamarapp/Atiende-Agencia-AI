import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { EstadoVacio } from "./EstadoVacio";
import { Button } from "./ui/button";

export interface VerticalNoEncontradoProps {
  /** Ruta del panel a la que vuelve el enlace (la landing de la vertical). */
  readonly volverA: string;
  readonly volverEtiqueta?: string;
}

/** 404 dentro del shell: la navegacion sigue disponible y hay un enlace de regreso al panel. */
export function VerticalNoEncontrado({ volverA, volverEtiqueta = "Volver al panel" }: VerticalNoEncontradoProps) {
  return (
    <EstadoVacio
      icon={Compass}
      titulo="Página no encontrada"
      mensaje="La dirección que abriste no existe en este panel o cambió de lugar."
      accion={
        <Button asChild variant="outline" size="sm">
          <Link to={volverA}>{volverEtiqueta}</Link>
        </Button>
      }
    />
  );
}
