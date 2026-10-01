// Boton "Chatea con tus datos" del header. Este monorepo no tiene ningun backend
// de RAG/chat-con-datos en apps/api, asi que el boton lo dice de frente: lleva
// la etiqueta "Pronto" y abre un aviso honesto (ver PanelChateaConTusDatos.tsx),
// nunca una conversacion simulada.
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
        <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-muted-foreground">Pronto</span>
      </Button>
      {abierto && <PanelChateaConTusDatos onClose={() => setAbierto(false)} nombreNegocio={nombreNegocio} />}
    </>
  );
}
