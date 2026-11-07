// Globo flotante «Iniciar llamada» del Agente de voz (ver globo-llamada.css): abre la vista previa de llamada. Se oculta mientras la vista previa
// está abierta, como el widget original (`display: none` con la vista previa activa).
import { createPortal } from "react-dom";
import { useT } from "@atiende/ui";
import { restaurantesAgenteVoz } from "@atiende/ui/i18n/restaurantes/agenteVoz";
import "./globo-llamada.css";

export function GloboLlamada({ onAbrir }: { readonly onAbrir: () => void }) {
  const t = useT(restaurantesAgenteVoz);
  return createPortal(
    <button type="button" className="globo-llamada" data-testid="globo-llamada" aria-label={t("restaurantes.agenteVoz.globo.etiqueta")} onClick={onAbrir}>
      <span className="globo-llamada__orbe" aria-hidden="true" />
      <span>{t("restaurantes.agenteVoz.globo.texto")}</span>
    </button>,
    document.body,
  );
}
