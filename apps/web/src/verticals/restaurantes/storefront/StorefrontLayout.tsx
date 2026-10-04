// Marco comun de las paginas publicas del storefront: encabezado con el restaurante, contenido principal y
// pie con el aviso de privacidad, el formulario de eventos y las redes (R-38). Sin sesion ni menu de panel: es una pagina para clientes.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BotonWhatsapp } from "./BotonWhatsapp.tsx";
import { redesDe, urlHttps } from "./MarcaPortada.tsx";
import type { MarcaPublica } from "./storefront-client.ts";

export function StorefrontLayout({
  orgSlug,
  nombre,
  marca,
  whatsappUrl,
  children,
}: {
  orgSlug: string;
  nombre?: string;
  marca?: MarcaPublica | null;
  /** wa.me de la sucursal elegida (R-38); sin enlace valido no hay boton flotante. */
  whatsappUrl?: string | null;
  children: ReactNode;
}) {
  const logo = urlHttps(marca?.logoUrl);
  const redes = redesDe(marca);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a href="#contenido" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">
        Saltar al contenido
      </a>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to={`/pedir/${orgSlug}`} className="flex min-w-0 items-center gap-2 text-base font-semibold tracking-tight">
            {logo && <img src={logo} alt="" width={28} height={28} loading="lazy" decoding="async" className="size-7 shrink-0 rounded-md object-cover" />}
            <span className="truncate">{nombre ?? "Pedir en línea"}</span>
          </Link>
          <span className="text-xs text-muted-foreground">Pago en sucursal · sin cuenta</span>
        </div>
      </header>
      <main id="contenido" className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {children}
      </main>
      <footer className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-20 pt-4 text-xs text-muted-foreground sm:px-6">
        <Link to={`/pedir/${orgSlug}/sucursales`} className="underline underline-offset-2">
          Sucursales
        </Link>
        <Link to={`/pedir/${orgSlug}/eventos`} className="underline underline-offset-2">
          Eventos y catering
        </Link>
        <Link to={`/pedir/${orgSlug}/privacidad`} className="underline underline-offset-2">
          Aviso de privacidad
        </Link>
        {redes.map((r) => (
          <a key={r.nombre} href={r.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            {r.nombre}
          </a>
        ))}
      </footer>
      <BotonWhatsapp url={whatsappUrl} nombre={nombre} />
    </div>
  );
}
