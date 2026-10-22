// Consentimiento de avisos por WhatsApp en la captura por personal. El encargado LEE el guion al cliente y marca Si o No: ninguna opcion
// viene preseleccionada y el pedido no se puede guardar sin respuesta. «No» es una opcion visible y valida (el aviso se omite y se avisa por llamada).
import { Button, cn } from "@atiende/ui";
import { Check, X } from "lucide-react";
import { GUION_CONSENTIMIENTO } from "../../lib/captura-pedido.ts";

export function ConsentimientoWhatsapp({ valor, alCambiar }: { readonly valor: boolean | null; readonly alCambiar: (v: boolean) => void }) {
  return (
    <fieldset className={cn("space-y-3 rounded-lg border-2 bg-card p-3", valor === null ? "border-primary" : "border-border")} data-testid="consentimiento-whatsapp">
      <legend className="px-1 text-base font-semibold text-foreground">Aviso por WhatsApp</legend>
      <p className="text-base text-muted-foreground">Lee esto al cliente y marca su respuesta:</p>
      <blockquote className="border-l-4 border-primary pl-3 text-lg font-medium text-foreground">«{GUION_CONSENTIMIENTO}»</blockquote>
      <div role="group" aria-label="Respuesta del cliente sobre el aviso por WhatsApp" className="grid grid-cols-2 gap-3">
        <Button type="button" className="h-14 text-lg" variant={valor === true ? "default" : "outline"} aria-pressed={valor === true} onClick={() => alCambiar(true)} iconLeft={<Check className="size-5" aria-hidden="true" />}>
          Sí, avisar
        </Button>
        <Button type="button" className="h-14 text-lg" variant={valor === false ? "default" : "outline"} aria-pressed={valor === false} onClick={() => alCambiar(false)} iconLeft={<X className="size-5" aria-hidden="true" />}>
          No
        </Button>
      </div>
      {valor === null && <p className="text-sm text-muted-foreground">Falta la respuesta del cliente para poder guardar.</p>}
      {valor === false && <p className="text-sm text-muted-foreground">No se enviará WhatsApp. Avísale al cliente por llamada cuando el pedido salga.</p>}
    </fieldset>
  );
}
