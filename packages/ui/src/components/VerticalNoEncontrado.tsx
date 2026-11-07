import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { EstadoVacio } from "./EstadoVacio";
import { Button } from "./ui/button";
import { shell } from "../i18n/mensajes/shell.ts";
import { useT } from "../i18n/proveedor";

export interface VerticalNoEncontradoProps {
  /** Ruta del panel a la que vuelve el enlace (la landing de la vertical). */
  readonly volverA: string;
  readonly volverEtiqueta?: string;
}

/** 404 dentro del shell: la navegacion sigue disponible y hay un enlace de regreso al panel. */
export function VerticalNoEncontrado({ volverA, volverEtiqueta }: VerticalNoEncontradoProps) {
  const t = useT(shell);
  return (
    <EstadoVacio
      icon={Compass}
      titulo={t("shell.noEncontrada.titulo")}
      mensaje={t("shell.noEncontrada.mensaje")}
      accion={
        <Button asChild variant="outline" size="sm">
          <Link to={volverA}>{volverEtiqueta ?? t("shell.volverAlPanel")}</Link>
        </Button>
      }
    />
  );
}
