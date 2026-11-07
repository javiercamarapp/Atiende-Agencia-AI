// Regreso de Stripe Checkout (onboarding P0): `POST /billing/checkout` (apps/api/src/routes/billing.ts) manda a Stripe con
// success_url = /billing/success y cancel_url = /billing/cancel. Antes ninguna de las dos estaba en <Routes> y el cliente caia en NotFound
// justo despues de pagar.
//
// Pantalla publica y minima: no lee sesion ni llama a la API. El estado real de la suscripcion lo escribe el webhook de Stripe (puede
// tardar unos segundos) y se ve en la pantalla «Plan y uso» de la vertical; aqui solo se explica eso y se manda al login de la vertical
// (que ya entra directo si la sesion sigue abierta). La vertical llega en la URL de regreso y se valida contra la lista cerrada; el
// session_id de Stripe se ignora (nunca se muestra). Con metodos asincronos (OXXO/SPEI) Stripe regresa a success_url ANTES de cobrar, asi
// que el texto nunca afirma que el pago ya se confirmo.
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@atiende/ui";
import { MarcoPublico } from "../components/MarcoPublico.tsx";

const VERTICALES = new Set(["restaurantes", "citas", "hoteles", "rentas", "despachos", "licitaciones"]);

/** Ruta de regreso segura: `/<vertical>/login` solo si la vertical es de la lista cerrada; si no, la portada. */
export function destinoRegresoBilling(vertical: string | null): string {
  return vertical && VERTICALES.has(vertical) ? `/${vertical}/login` : "/";
}

export function BillingRegresoPage({ resultado }: { readonly resultado: "exito" | "cancelado" }) {
  const [params] = useSearchParams();
  const destino = destinoRegresoBilling(params.get("vertical"));
  const exito = resultado === "exito";
  return (
    <MarcoPublico
      titulo={exito ? "Gracias por tu pago" : "No se completó el pago"}
      descripcion={
        exito
          ? "Recibimos tu pago o está en proceso. Con tarjeta, tu plan se activa en unos segundos; con OXXO o transferencia (SPEI), en cuanto el banco confirme el cobro."
          : "Cancelaste el pago en Stripe. No se hizo ningún cargo y tu cuenta sigue igual."
      }
    >
      <p className="text-ui text-muted-foreground">
        {exito ? "Puedes revisar tu plan y tu consumo en «Plan y uso» dentro de tu panel." : "Cuando quieras, vuelve a elegir tu plan desde «Plan y uso» en tu panel."}
      </p>
      <Button asChild>
        <Link to={destino}>{destino === "/" ? "Ir al inicio" : "Ir a mi panel"}</Link>
      </Button>
    </MarcoPublico>
  );
}

export function BillingExitoPage() {
  return <BillingRegresoPage resultado="exito" />;
}

export function BillingCanceladoPage() {
  return <BillingRegresoPage resultado="cancelado" />;
}
