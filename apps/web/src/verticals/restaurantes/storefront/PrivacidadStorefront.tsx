// Aviso de privacidad SIMPLIFICADO del storefront: que datos se piden, para que, quien los ve y cuanto duran.
// Es un resumen operativo, no un aviso integral redactado por un abogado: el restaurante debe publicar el suyo.
import { useEffect, useMemo, useState } from "react";
import { crearClienteStorefront, type SeccionEncargados } from "./storefront-client.ts";
import { StorefrontLayout } from "./StorefrontLayout.tsx";
import { useMetaPublica } from "./meta-publica.ts";

/** Seccion "Encargados y transferencias": viene del servidor segun la configuracion REAL de la organizacion; es un BORRADOR. */
function EncargadosYTransferencias({ seccion }: { seccion: SeccionEncargados }) {
  if (seccion.encargados.length === 0) return null;
  return (
    <section aria-labelledby="encargados-titulo" className="rounded-lg border border-border bg-card p-4">
      <h2 id="encargados-titulo" className="text-sm font-semibold text-foreground">
        Encargados y transferencias
      </h2>
      <p className="mt-1 text-ui text-warning">Borrador pendiente de revisión legal.</p>
      <p className="mt-2 text-sm">{seccion.aviso}</p>
      <ul className="mt-3 flex flex-col gap-2 text-sm">
        {seccion.encargados.map((e) => (
          <li key={e.id}>
            <strong className="text-foreground">{e.proveedor}</strong> ({e.pais}): {e.finalidad}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PrivacidadStorefrontPage({ apiBaseUrl, orgSlug }: { apiBaseUrl: string; orgSlug: string }) {
  const cliente = useMemo(() => crearClienteStorefront(apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const [seccion, setSeccion] = useState<SeccionEncargados | null>(null);
  useEffect(() => {
    let vigente = true;
    cliente
      .privacidad()
      .then((r) => vigente && setSeccion(r.encargados))
      // Si el servidor no responde, el aviso simplificado sigue completo; la seccion de encargados simplemente no aparece.
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [cliente]);
  useMetaPublica({ titulo: "Aviso de privacidad · Pedir en línea", descripcion: "Qué datos pedimos al hacer un pedido en línea, para qué los usamos y cómo ejercer tus derechos.", indexable: true });
  return (
    <StorefrontLayout orgSlug={orgSlug}>
      <article className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Aviso de privacidad (versión simplificada)</h1>
        <div className="mt-5 flex flex-col gap-4 text-base leading-relaxed text-muted-foreground">
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
          {seccion && <EncargadosYTransferencias seccion={seccion} />}
          <p className="text-sm">
            Este es un resumen operativo; no sustituye al aviso de privacidad integral del restaurante, que debe publicarlo conforme a la ley aplicable.
          </p>
        </div>
      </article>
    </StorefrontLayout>
  );
}
