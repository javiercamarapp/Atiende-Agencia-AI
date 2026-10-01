import { Printer } from "lucide-react";
import { renderTicketCocinaHtml, TICKET_COCINA_CSS, type TicketCocina } from "../lib/ticketCocina.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";

export interface TicketCocinaVistaProps {
  readonly ticket: TicketCocina;
}

/** Vista de pantalla del ticket: el MISMO HTML que sale por la impresora (ver
 * renderTicketCocinaHtml). Todo el contenido está escapado ahí, por eso es seguro inyectarlo. */
export function TicketCocinaVista({ ticket }: TicketCocinaVistaProps) {
  return (
    <div className="max-h-[60vh] overflow-auto rounded-md border border-border bg-white p-2" data-testid="ticket-cocina-vista">
      <style>{TICKET_COCINA_CSS}</style>
      <div dangerouslySetInnerHTML={{ __html: renderTicketCocinaHtml(ticket) }} />
    </div>
  );
}

export interface TicketCocinaDialogProps {
  readonly ticket: TicketCocina | null;
  readonly onClose: () => void;
  readonly onImprimir: (ticket: TicketCocina) => void;
  /** "Imprimir" para la primera salida, "Reimprimir" cuando ya se imprimió. */
  readonly etiquetaImprimir?: string;
}

export function TicketCocinaDialog({ ticket, onClose, onImprimir, etiquetaImprimir = "Imprimir" }: TicketCocinaDialogProps) {
  return (
    <Dialog open={ticket !== null} onOpenChange={(abierto) => !abierto && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ticket de cocina</DialogTitle>
          <DialogDescription>Formato de rollo térmico de 80 mm. No se envía a ningún servicio externo.</DialogDescription>
        </DialogHeader>
        {ticket && <TicketCocinaVista ticket={ticket} />}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cerrar
          </Button>
          <Button type="button" onClick={() => ticket && onImprimir(ticket)}>
            <Printer className="mr-1.5 h-4 w-4" strokeWidth={1.75} />
            {etiquetaImprimir}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
