// L-33 (REQ-115): aviso reutilizable de uso de inteligencia artificial. Se monta SOLO cuando la pantalla muestra
// contenido que la API reporta como generado o asistido por IA (requisitos con `extractedBy === "llm"`, preguntas de
// junta con `origin === "agente"`); nunca de forma decorativa y nunca cuando el resultado vino de reglas o de captura
// manual. Dice que fue IA, para que sirvio y que una persona debe revisarlo antes de usarlo.
import { Sparkles } from "lucide-react";
import { Callout } from "@atiende/ui";

export const AVISO_IA_ETIQUETA = "Aviso de uso de inteligencia artificial";

export interface AvisoIaProps {
  /** Que parte del contenido fue asistida por IA y con que proposito (una frase, sin datos personales). */
  readonly proposito: string;
  readonly className?: string;
}

export function AvisoIa({ proposito, className }: AvisoIaProps) {
  return (
    <Callout role="note" aria-label={AVISO_IA_ETIQUETA} tone="info" icon={<Sparkles className="size-4" aria-hidden="true" />} titulo="Contenido asistido por inteligencia artificial" className={className}>
      {proposito} Puede contener errores u omisiones: una persona debe revisarlo y aprobarlo antes de usarlo en una propuesta.
    </Callout>
  );
}
