// Términos de Servicio — página real mínima, enlazada desde el pie de los 6
// logins ("Al continuar, aceptas los Términos de Servicio..."). Contenido
// genérico honesto para un SaaS B2B de agentes de WhatsApp/IA — no un
// placeholder "lorem ipsum", pero tampoco un documento legal completo
// redactado por un abogado (eso queda fuera de alcance de este pase; el aviso
// al pie lo deja explícito). Marco visual: `PaginaLegal` (port del de Likida).
import { PaginaLegal } from "../components/PaginaLegal.tsx";
import type { SeccionLegal } from "../components/PaginaLegal.tsx";

const SECCIONES: readonly SeccionLegal[] = [
  {
    titulo: "1. Alcance",
    parrafos: [
      "Estos términos rigen el uso de los paneles de atiende.ai (hoteles, restaurantes, citas y reservaciones, licitaciones, despachos y rentas vacacionales) por parte del personal autorizado de una organización cliente.",
    ],
  },
  {
    titulo: "2. Tu acceso",
    parrafos: [
      "Tu acceso es personal e intransferible, otorgado por quien administra tu organización. No debes compartir tu sesión ni tus credenciales con nadie fuera de tu organización.",
    ],
  },
  {
    titulo: "3. De quién son los datos",
    parrafos: [
      "atiende.ai actúa como procesador de los datos operativos de tu organización (reservas, pedidos, mensajes de WhatsApp, documentos y expedientes propios de tu vertical) — el control y la responsabilidad de esos datos frente a tus propios clientes es de tu organización.",
    ],
  },
  {
    titulo: "4. Terminación",
    parrafos: ["Puedes perder acceso si quien administra tu organización revoca tu invitación, o si tu organización cancela su suscripción."],
  },
];

export function TerminosPage() {
  return (
    <PaginaLegal
      etiqueta="atiende.ai · Legal"
      titulo="Términos de Servicio"
      bajada="Resumen operativo de las condiciones de uso de los paneles."
      secciones={SECCIONES}
      aviso="Este es un resumen operativo, no un contrato redactado por un despacho legal. Si tu organización necesita un acuerdo formal, contáctanos."
    />
  );
}
