// Boton "Chatea con tus datos" del header. Sin `chat` (hoteles, citas, rentas, despachos,
// licitaciones: su catalogo aun no esta enchufado) dice la verdad de frente: etiqueta "Pronto" y aviso
// honesto (ver PanelChateaConTusDatos.tsx), nunca una conversacion simulada. Con `chat` consulta al
// servidor si el asistente esta activo: solo entonces quita "Pronto". Con `href` (restaurantes, vertical
// piloto del Copiloto, CHAT-08) el boton disponible es un ENLACE a la pagina del Copiloto; sin `href`
// abre el dialogo de conversacion (verticales que aun lo usan). Si el servidor no confirma la
// disponibilidad, sigue siendo el aviso honesto con "Pronto".
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MessageCircle } from "lucide-react";
import { Button } from "@atiende/ui";
import { PanelChateaConTusDatos } from "./PanelChateaConTusDatos.tsx";
import type { ChatDatosConexion } from "./PanelChateaConTusDatos.tsx";

/**
 * Disponibilidad REAL del asistente: solo es `true` cuando el servidor lo confirma para la sucursal activa
 * (`chat.clave`). Sin `chat`, o si la consulta falla, es `false`. Lo comparten el boton de la barra y la
 * pildora "Pregunta a tus datos" del pie del Sidebar.
 */
export function useChatDatosDisponible(chat: ChatDatosConexion | undefined): boolean {
  const [disponible, setDisponible] = useState(false);
  useEffect(() => {
    if (!chat) {
      setDisponible(false);
      return;
    }
    let vigente = true;
    void chat.disponible().then((ok) => {
      if (vigente) setDisponible(ok);
    });
    return () => {
      vigente = false;
    };
    // `chat` se recrea en cada render del shell; la disponibilidad depende solo de la sucursal activa.
  }, [chat?.clave]);
  return disponible;
}

export function BotonChatDatos({ className, nombreNegocio, chat, href }: { className?: string; nombreNegocio?: string; chat?: ChatDatosConexion; href?: string }) {
  const [abierto, setAbierto] = useState(false);
  const disponible = useChatDatosDisponible(chat);

  if (href && disponible) {
    return (
      <Button asChild variant="outline" size="sm" className={`h-8 rounded-full text-sm shrink-0 ${className ?? ""}`}>
        <Link to={href}>
          <MessageCircle className="w-3.5 h-3.5" />
          Chatea con tus datos
        </Link>
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setAbierto(true)}
        className={`h-8 rounded-full text-sm shrink-0 ${className ?? ""}`}
      >
        <MessageCircle className="w-3.5 h-3.5" />
        Chatea con tus datos
        {disponible ? null : <span className="font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">Pronto</span>}
      </Button>
      {abierto && <PanelChateaConTusDatos onClose={() => setAbierto(false)} nombreNegocio={nombreNegocio} chat={disponible ? chat : undefined} />}
    </>
  );
}
