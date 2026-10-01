// Aviso de privacidad SIMPLIFICADO del storefront: que datos se piden, para que, quien los ve y cuanto duran.
// Es un resumen operativo, no un aviso integral redactado por un abogado: el restaurante debe publicar el suyo.
import { StorefrontLayout } from "./StorefrontLayout.tsx";
import { useMetaPublica } from "./meta-publica.ts";

export function PrivacidadStorefrontPage({ orgSlug }: { orgSlug: string }) {
  useMetaPublica({ titulo: "Aviso de privacidad · Pedir en línea", descripcion: "Qué datos pedimos al hacer un pedido en línea, para qué los usamos y cómo ejercer tus derechos.", indexable: true });
  return (
    <StorefrontLayout orgSlug={orgSlug}>
      <article className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Aviso de privacidad (versión simplificada)</h1>
        <div className="mt-5 flex flex-col gap-4 text-[15px] leading-relaxed text-muted-foreground">
          <p>
            <strong className="text-foreground">Qué datos pedimos.</strong> Tu nombre y tu teléfono (obligatorios), tu dirección solo si pides a domicilio, y tu correo y
            notas solo si tú los escribes. No pedimos contraseña ni creamos una cuenta, y no guardamos datos de tarjeta: el pago se hace en la sucursal.
          </p>
          <p>
            <strong className="text-foreground">Para qué.</strong> Únicamente para preparar y entregar tu pedido, avisarte de su estado y atender dudas sobre él. Si dejas tu
            correo, te enviamos la confirmación del pedido.
          </p>
          <p>
            <strong className="text-foreground">Quién los ve.</strong> El personal del restaurante que prepara y entrega tu pedido. La página de seguimiento solo muestra el
            estado y los productos, nunca tu nombre, teléfono ni dirección, y el enlace de seguimiento funciona solo con su código y por pocos días.
          </p>
          <p>
            <strong className="text-foreground">Tus derechos.</strong> Puedes pedir acceso, corrección o eliminación de tus datos, u oponerte a su uso, llamando o escribiendo
            a la sucursal donde pediste.
          </p>
          <p className="text-[13px]">
            Este es un resumen operativo; no sustituye al aviso de privacidad integral del restaurante, que debe publicarlo conforme a la ley aplicable.
          </p>
        </div>
      </article>
    </StorefrontLayout>
  );
}
