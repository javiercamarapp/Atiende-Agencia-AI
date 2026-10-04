// R-38: boton flotante de WhatsApp. Abre wa.me con el numero de la sucursal y un texto prellenado (sin datos de la persona).
// Solo se muestra si el servidor dio un enlace wa.me valido; sin numero, no hay boton (nada deshabilitado ni de adorno).
import { MessageCircle } from "lucide-react";
import { Button } from "@atiende/ui";

export function enlaceWhatsappSeguro(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https:\/\/wa\.me\/\d{10,15}(\?text=[A-Za-z0-9%._~-]*)?$/.test(url) ? url : null;
}

export function BotonWhatsapp({ url, nombre }: { url: string | null | undefined; nombre?: string }) {
  const href = enlaceWhatsappSeguro(url);
  if (!href) return null;
  return (
    <Button asChild size="lg" className="fixed bottom-4 right-4 z-40 shadow-card">
      <a href={href} target="_blank" rel="noopener noreferrer" data-testid="boton-whatsapp">
        <MessageCircle aria-hidden="true" />
        WhatsApp
        <span className="sr-only">{nombre ? ` con ${nombre} (se abre en otra pestaña)` : " (se abre en otra pestaña)"}</span>
      </a>
    </Button>
  );
}
