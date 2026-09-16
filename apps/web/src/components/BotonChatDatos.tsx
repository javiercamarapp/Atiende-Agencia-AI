// Píldora "Chatea con tus datos" del header, mismo patrón visual que
// AdminDashboard.tsx de atiende-restaurantes (botón outline rounded-full con
// MessageCircle + texto). A diferencia de la versión anterior de este archivo
// (deshabilitado con solo un toast) -- ahora SÍ abre el panel real
// (`PanelChateaConTusDatos`, mismo nivel de pulido visual que la referencia de
// restaurantes: CampoPixeles de fondo, wordmark animado, hilo de conversación,
// historial) como overlay de pantalla completa, sin que el Shell que monta este
// botón necesite conocer ningún estado de sección nuevo.
//
// Sigue siendo honesto: este monorepo no tiene ningún backend de RAG/chat-con-
// datos en apps/api (sin ruta /pregunta, sin endpoint de embeddings -- se
// revisó de nuevo al construir el panel) -- `PanelChateaConTusDatos` responde
// SIEMPRE con el mismo aviso de roadmap, nunca una respuesta de IA fabricada
// (ver el comentario de cabecera de ese archivo).
import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { Button } from "@atiende/ui";
import { PanelChateaConTusDatos } from "./PanelChateaConTusDatos.tsx";

export function BotonChatDatos({ className, nombreNegocio }: { className?: string; nombreNegocio?: string }) {
  const [abierto, setAbierto] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setAbierto(true)}
        className={`h-8 rounded-full text-[13px] shrink-0 ${className ?? ""}`}
      >
        <MessageCircle className="w-3.5 h-3.5" />
        Chatea con tus datos
      </Button>
      {abierto && <PanelChateaConTusDatos onClose={() => setAbierto(false)} nombreNegocio={nombreNegocio} />}
    </>
  );
}
