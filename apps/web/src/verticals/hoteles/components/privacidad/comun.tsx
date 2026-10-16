// Piezas compartidas de las secciones de Privacidad (UNI-C gestion). El aviso legal y la lista "un abogado debe confirmar"
// siguen viniendo del servidor; esto solo ordena la UX.
import { EstadoVacio } from "@atiende/ui";
export { errorMessage } from "../identidad/comun.ts";

export interface PrivacidadSectionProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** owner/gm (cosmetico: el servidor es la barrera real). */
  readonly isAdmin: boolean;
}

export const validarNota10 = (v: string): string | null => (v.trim().length < 10 ? "Escribe al menos 10 caracteres." : null);

export function NoDisponible() {
  return <EstadoVacio mensaje="Esta sección aún no está disponible en esta base (migración 032 pendiente de aplicar)." />;
}
