// Consentimiento de avisos por WhatsApp en la captura por personal. El encargado LEE el guion al cliente y marca Si o No: ninguna opcion
// viene preseleccionada y el pedido no se puede guardar sin respuesta. «No» es una opcion visible y valida (el aviso se omite y se avisa por llamada).
import { Button, cn, useT } from "@atiende/ui";
import { restaurantesCaptura } from "@atiende/ui/i18n/restaurantes/captura";
import { Check, X } from "lucide-react";
import { GUION_CONSENTIMIENTO } from "../../lib/captura-pedido.ts";

export function ConsentimientoWhatsapp({ valor, alCambiar }: { readonly valor: boolean | null; readonly alCambiar: (v: boolean) => void }) {
  const t = useT(restaurantesCaptura);
  return (
    <fieldset className={cn("space-y-3 rounded-lg border-2 bg-card p-3", valor === null ? "border-primary" : "border-border")} data-testid="consentimiento-whatsapp">
      <legend className="px-1 text-base font-semibold text-foreground">{t("restaurantes.captura.consentimiento.titulo")}</legend>
      <p className="text-base text-muted-foreground">{t("restaurantes.captura.consentimiento.lee")}</p>
      <blockquote className="border-l-4 border-primary pl-3 text-lg font-medium text-foreground">«{GUION_CONSENTIMIENTO}»</blockquote>
      <div role="group" aria-label={t("restaurantes.captura.consentimiento.aria")} className="grid grid-cols-2 gap-3">
        <Button type="button" className="h-14 text-lg" variant={valor === true ? "default" : "outline"} aria-pressed={valor === true} onClick={() => alCambiar(true)} iconLeft={<Check className="size-5" aria-hidden="true" />}>
          {t("restaurantes.captura.consentimiento.si")}
        </Button>
        <Button type="button" className="h-14 text-lg" variant={valor === false ? "default" : "outline"} aria-pressed={valor === false} onClick={() => alCambiar(false)} iconLeft={<X className="size-5" aria-hidden="true" />}>
          {t("restaurantes.captura.consentimiento.no")}
        </Button>
      </div>
      {valor === null && <p className="text-sm text-muted-foreground">{t("restaurantes.captura.consentimiento.falta")}</p>}
      {valor === false && <p className="text-sm text-muted-foreground">{t("restaurantes.captura.consentimiento.sinWhatsapp")}</p>}

    </fieldset>
  );
}
