// "Chatea con tus datos". Sin `chat`: aviso honesto de "no disponible" (Dialog real de @atiende/ui) --
// antes este archivo FINGIA una conversacion (hallazgo F-18/B-06 del informe de diseno-ux), y no se
// vuelve a simular nada. Con `chat` (vertical con catalogo enchufado y asistente activo): conversacion
// real contra el backend (motor compartido, herramientas de solo lectura), con tablas, graficas y la
// fuente/periodo de cada cifra.
import { useRef, useState } from "react";
import { Button, ChatDatosDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@atiende/ui";
import type { ChatDatosMensaje } from "@atiende/ui";

/** Conexion de una vertical con su backend de chat: el shell la arma; este componente no conoce rutas ni verticales. */
export interface ChatDatosConexion {
  /** Cambia cuando cambia el contexto (sucursal activa): reevalua la disponibilidad. */
  readonly clave: string;
  readonly disponible: () => Promise<boolean>;
  readonly enviar: (pregunta: string, historial: readonly { role: "user" | "assistant"; text: string }[]) => Promise<{
    status: string;
    text: string;
    blocks: NonNullable<ChatDatosMensaje["blocks"]>;
    sources: NonNullable<ChatDatosMensaje["sources"]>;
  }>;
  readonly sugerencias: readonly string[];
}

export interface PanelChateaConTusDatosProps {
  readonly onClose: () => void;
  /** Nombre del negocio activo (organizacion/property). Opcional, cae a "tu negocio". */
  readonly nombreNegocio?: string;
  readonly chat?: ChatDatosConexion;
}

export function PanelChateaConTusDatos({ onClose, nombreNegocio, chat }: PanelChateaConTusDatosProps) {
  if (chat) return <ConversacionReal onClose={onClose} nombreNegocio={nombreNegocio} chat={chat} />;
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

function ConversacionReal({ onClose, nombreNegocio, chat }: { onClose: () => void; nombreNegocio?: string; chat: ChatDatosConexion }) {
  const [mensajes, setMensajes] = useState<readonly ChatDatosMensaje[]>([]);
  const [enviando, setEnviando] = useState(false);
  const contador = useRef(0);
  // Evita dos preguntas en vuelo si el usuario toca una sugerencia y envia a la vez.
  const enVuelo = useRef(false);

  async function enviar(pregunta: string) {
    if (enVuelo.current) return;
    enVuelo.current = true;
    const historial = mensajes.map((m) => ({ role: m.role, text: m.text }));
    contador.current += 1;
    const idPregunta = `u${contador.current}`;
    setMensajes((prev) => [...prev, { id: idPregunta, role: "user", text: pregunta }]);
    setEnviando(true);
    try {
      const r = await chat.enviar(pregunta, historial);
      contador.current += 1;
      setMensajes((prev) => [...prev, { id: `a${contador.current}`, role: "assistant", text: r.text, status: r.status, blocks: r.blocks, sources: r.sources }]);
    } finally {
      enVuelo.current = false;
      setEnviando(false);
    }
  }

  return (
    <ChatDatosDialog
      open
      onOpenChange={(abierto) => {
        if (!abierto) onClose();
      }}
      nombreNegocio={nombreNegocio}
      mensajes={mensajes}
      enviando={enviando}
      onEnviar={(p) => void enviar(p)}
      sugerencias={chat.sugerencias}
    />
  );
}
