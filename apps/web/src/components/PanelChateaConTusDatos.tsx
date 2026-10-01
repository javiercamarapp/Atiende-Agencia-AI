// Aviso de "Chatea con tus datos". Antes este archivo (~400 lineas) era una
// vista previa que FINGIA una conversacion: caja de pregunta, indicador
// "pensando", historial y sugerencias, y contestaba siempre con el mismo aviso
// de roadmap (hallazgo F-18/B-06 del informe de diseno-ux). Se verifico de
// nuevo que este monorepo no tiene ningun backend de RAG/chat-con-datos en
// apps/api (sin ruta /pregunta, sin endpoint de embeddings), asi que ahora el
// panel dice la verdad de entrada, sin simular una respuesta: es un Dialog real
// de @atiende/ui (foco atrapado, Escape, aria-modal gestionados por Radix).
// Cuando exista el backend, este componente se reemplaza por el chat real.
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@atiende/ui";

export interface PanelChateaConTusDatosProps {
  readonly onClose: () => void;
  /** Nombre del negocio activo (organizacion/property). Opcional, cae a "tu negocio". */
  readonly nombreNegocio?: string;
}

export function PanelChateaConTusDatos({ onClose, nombreNegocio }: PanelChateaConTusDatosProps) {
  return (
    <Dialog
      open
      onOpenChange={(abierto) => {
        if (!abierto) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Chatea con tus datos</DialogTitle>
          <DialogDescription>Esta función todavía no está disponible.</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-foreground leading-relaxed">
          Aún no hay una conexión real con los datos de {nombreNegocio ?? "tu negocio"}, así que no puede responder preguntas ni mostrar cifras. Cuando esté lista, la
          verás activa en este mismo botón.
        </p>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Entendido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
