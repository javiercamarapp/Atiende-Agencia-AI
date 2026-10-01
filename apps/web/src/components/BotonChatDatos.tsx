// Boton "Chatea con tus datos" del header. Sin `chat` (hoteles, citas, rentas, despachos,
// licitaciones: su catalogo aun no esta enchufado) dice la verdad de frente: etiqueta "Pronto" y aviso
// honesto (ver PanelChateaConTusDatos.tsx), nunca una conversacion simulada. Con `chat` (restaurantes,
// vertical piloto) consulta al servidor si el asistente esta activo: solo entonces quita "Pronto" y abre
// la conversacion real; si el servidor no lo confirma, sigue siendo el aviso honesto.
import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { Button } from "@atiende/ui";
import { PanelChateaConTusDatos } from "./PanelChateaConTusDatos.tsx";
import type { ChatDatosConexion } from "./PanelChateaConTusDatos.tsx";

export function BotonChatDatos({ className, nombreNegocio, chat }: { className?: string; nombreNegocio?: string; chat?: ChatDatosConexion }) {
  const [abierto, setAbierto] = useState(false);
  const [disponible, setDisponible] = useState(false);

  useEffect(() => {
    if (!chat) return;
    let vigente = true;
    void chat.disponible().then((ok) => {
      if (vigente) setDisponible(ok);
    });
    return () => {
      vigente = false;
    };
    // `chat` se recrea en cada render del shell; la disponibilidad depende solo de la sucursal activa.
  }, [chat?.clave]);

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
        {disponible ? null : <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-muted-foreground">Pronto</span>}
      </Button>
      {abierto && <PanelChateaConTusDatos onClose={() => setAbierto(false)} nombreNegocio={nombreNegocio} chat={disponible ? chat : undefined} />}
    </>
  );
}
