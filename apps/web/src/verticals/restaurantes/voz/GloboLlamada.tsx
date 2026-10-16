// Globo flotante «Iniciar llamada» del Agente de voz (ver globo-llamada.css): abre la vista previa de llamada. Se oculta mientras la vista previa
// está abierta, como el widget original (`display: none` con la vista previa activa).
import { createPortal } from "react-dom";
import "./globo-llamada.css";

export function GloboLlamada({ onAbrir }: { readonly onAbrir: () => void }) {
  return createPortal(
    <button type="button" className="globo-llamada" data-testid="globo-llamada" aria-label="Llamar al agente (vista previa)" onClick={onAbrir}>
      <span className="globo-llamada__orbe" aria-hidden="true" />
      <span>Iniciar llamada</span>
    </button>,
    document.body,
  );
}
