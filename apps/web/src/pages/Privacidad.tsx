// Aviso de Privacidad — página real mínima, ver el comentario de cabecera de
// Terminos.tsx (mismo alcance y mismo criterio honesto).
import { Link } from "react-router-dom";
import { AtiendeWordmark } from "@atiende/ui";
import "./login.css";

export function PrivacidadPage() {
  return (
    <main className="login min-h-screen px-6 py-10 sm:px-10 lg:px-16">
      <div className="mx-auto max-w-2xl">
        <header className="mb-10">
          <Link to="/">
            <AtiendeWordmark />
          </Link>
        </header>
        <p className="login-kicker">Legal</p>
        <h1 className="login-serif mt-4 text-[32px] sm:text-[38px] text-foreground">Aviso de Privacidad</h1>
        <div className="mt-8 flex flex-col gap-5 text-[15px] leading-relaxed text-muted-foreground">
          <p>
            Para entrar a tu panel guardamos tu correo, tu nombre y, si inicias sesión con Google, el identificador
            estable de tu cuenta de Google — nunca tu contraseña de Google, y nunca tu contraseña en texto plano en
            ningún caso (se guarda hasheada).
          </p>
          <p>
            Si usas "Continuar con correo", el enlace que te enviamos expira en 15 minutos y solo funciona una vez —
            no lo compartas, es equivalente a tu contraseña por ese tiempo.
          </p>
          <p>
            Los datos operativos de tu vertical (reservas, pedidos, mensajes de WhatsApp, documentos y expedientes)
            pertenecen a tu organización, no a atiende.ai — los tratamos únicamente para operar el panel que tu
            organización contrató.
          </p>
          <p>
            Puedes pedir a quien administra tu organización que revoque tu acceso en cualquier momento; eso cierra
            todas tus sesiones activas.
          </p>
          <p className="text-[13px] text-muted-foreground/80">
            Este es un resumen operativo, no un aviso de privacidad redactado conforme a la legislación de cada
            jurisdicción donde opere tu organización. Si lo necesitas, contáctanos.
          </p>
        </div>
      </div>
    </main>
  );
}
