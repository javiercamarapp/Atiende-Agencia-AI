// «Revisa tu correo» despues de un registro autoservicio (onboarding P0, rentas): la cuenta nueva no puede iniciar sesion con contrasena
// hasta verificar su correo, y el registro ya encola ese correo (lo envia el despachador de la vertical, puede tardar unos minutos).
// El boton «Reenviar» llama al reenvio PUBLICO POST /auth/email-verification/reenviar (sin sesion). Ese endpoint responde el mismo 200
// exista o no la cuenta (anti-enumeracion), por eso el aviso de exito es uniforme; el 429 (tope por IP y por correo) se muestra con su
// propio texto para que la persona sepa que debe esperar. ES/EN segun `locale` (mismo criterio `?lang=en` del login).
import { useState } from "react";
import { Button } from "@atiende/ui";
import { DemasiadosIntentosError, reenviarVerificacionCorreoPublico } from "./cuenta-client.ts";
import type { VerticalCuenta } from "./cuenta-client.ts";

export interface RevisaTuCorreoProps {
  readonly apiBaseUrl: string;
  readonly vertical: VerticalCuenta;
  readonly correo: string;
  readonly locale?: "es" | "en";
}

type Estado = { readonly tipo: "reposo" } | { readonly tipo: "enviando" } | { readonly tipo: "enviado" } | { readonly tipo: "tope" } | { readonly tipo: "error" };

export function RevisaTuCorreo({ apiBaseUrl, vertical, correo, locale = "es" }: RevisaTuCorreoProps) {
  const tr = (es: string, en: string) => (locale === "en" ? en : es);
  const [estado, setEstado] = useState<Estado>({ tipo: "reposo" });

  async function reenviar() {
    if (estado.tipo === "enviando") return;
    setEstado({ tipo: "enviando" });
    try {
      await reenviarVerificacionCorreoPublico(fetch, apiBaseUrl, correo, vertical);
      setEstado({ tipo: "enviado" });
    } catch (err) {
      setEstado({ tipo: err instanceof DemasiadosIntentosError ? "tope" : "error" });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-border bg-muted px-3 py-3 text-sm text-muted-foreground">
        <p className="m-0 font-semibold text-foreground">{tr("Revisa tu correo", "Check your email")}</p>
        <p className="m-0 mt-1">
          {tr("Te enviamos un enlace a", "We sent a link to")} <strong className="break-all text-foreground">{correo}</strong>{" "}
          {tr(
            "para verificar tu cuenta. Puede tardar unos minutos; revisa también la carpeta de spam. Ábrelo y después inicia sesión.",
            "to verify your account. It can take a few minutes; also check your spam folder. Open it and then sign in.",
          )}
        </p>
      </div>
      <Button type="button" variant="outline" onClick={() => void reenviar()} disabled={estado.tipo === "enviando"} aria-busy={estado.tipo === "enviando" || undefined} className="w-full">
        {estado.tipo === "enviando" ? tr("Reenviando…", "Resending…") : tr("Reenviar correo", "Resend email")}
      </Button>
      {estado.tipo === "enviado" && (
        <p role="status" className="m-0 text-sm text-muted-foreground">
          {tr("Si tu cuenta aún no está verificada, te enviamos un enlace nuevo; el anterior deja de servir.", "If your account is not verified yet, we sent a new link; the previous one stops working.")}
        </p>
      )}
      {estado.tipo === "tope" && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {tr("Ya pediste varios correos. Espera 15 minutos antes de pedir otro.", "You have requested several emails. Wait 15 minutes before requesting another one.")}
        </p>
      )}
      {estado.tipo === "error" && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {tr("No se pudo reenviar el correo. Intenta de nuevo en unos minutos.", "We could not resend the email. Try again in a few minutes.")}
        </p>
      )}
    </div>
  );
}
