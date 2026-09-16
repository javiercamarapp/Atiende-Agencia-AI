// Términos de Servicio — página real mínima, enlazada desde el pie de los 6
// logins ("Al continuar, aceptas los Términos de Servicio..."). Contenido
// genérico honesto para un SaaS B2B de agentes de WhatsApp/IA — no un
// placeholder "lorem ipsum", pero tampoco un documento legal completo
// redactado por un abogado (eso queda fuera de alcance de este pase; el aviso
// al pie lo deja explícito).
import { Link } from "react-router-dom";
import { AtiendeWordmark } from "@atiende/ui";
import "./login.css";

export function TerminosPage() {
  return (
    <main className="login min-h-screen px-6 py-10 sm:px-10 lg:px-16">
      <div className="mx-auto max-w-2xl">
        <header className="mb-10">
          <Link to="/">
            <AtiendeWordmark />
          </Link>
        </header>
        <p className="login-kicker">Legal</p>
        <h1 className="login-serif mt-4 text-[32px] sm:text-[38px] text-foreground">Términos de Servicio</h1>
        <div className="mt-8 flex flex-col gap-5 text-[15px] leading-relaxed text-muted-foreground">
          <p>
            Estos términos rigen el uso de los paneles de atiende.ai (hoteles, restaurantes, citas y reservaciones,
            licitaciones, despachos y rentas vacacionales) por parte del personal autorizado de una organización cliente.
          </p>
          <p>
            Tu acceso es personal e intransferible, otorgado por quien administra tu organización. No debes compartir tu
            sesión ni tus credenciales con nadie fuera de tu organización.
          </p>
          <p>
            atiende.ai actúa como procesador de los datos operativos de tu organización (reservas, pedidos, mensajes de
            WhatsApp, documentos y expedientes propios de tu vertical) — el control y la responsabilidad de esos datos
            frente a tus propios clientes es de tu organización.
          </p>
          <p>
            Puedes perder acceso si quien administra tu organización revoca tu invitación, o si tu organización cancela
            su suscripción.
          </p>
          <p className="text-[13px] text-muted-foreground/80">
            Este es un resumen operativo, no un contrato redactado por un despacho legal. Si tu organización necesita un
            acuerdo formal, contáctanos.
          </p>
        </div>
      </div>
    </main>
  );
}
