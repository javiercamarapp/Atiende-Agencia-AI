// R-38: portada de marca del storefront. Imagen de portada, logo, titular, eslogan, descripcion y redes salen de la marca que
// owner/admin guardan en Configuracion > Sitio publico. Sin marca guardada: portada generica con el nombre del restaurante
// (nada inventado). Imagenes: la portada es lo primero que se ve (carga prioritaria, tamano declarado para no mover el
// layout); el logo es pequeno y carga diferido. Solo se pintan URLs https (el servidor ya las valida; aqui se vuelve a filtrar).
import { ExternalLink } from "lucide-react";
import { Button, Card } from "@atiende/ui";
import type { MarcaPublica } from "./storefront-client.ts";

export function urlHttps(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https:\/\/[^\s<>"']+$/.test(url) ? url : null;
}

const REDES: ReadonlyArray<{ readonly clave: "instagramUrl" | "facebookUrl" | "tiktokUrl"; readonly nombre: string }> = [
  { clave: "instagramUrl", nombre: "Instagram" },
  { clave: "facebookUrl", nombre: "Facebook" },
  { clave: "tiktokUrl", nombre: "TikTok" },
];

/** Redes con enlace https valido, en orden fijo. */
export function redesDe(marca: MarcaPublica | null | undefined): Array<{ nombre: string; url: string }> {
  if (!marca) return [];
  const redes: Array<{ nombre: string; url: string }> = [];
  for (const r of REDES) {
    const url = urlHttps(marca[r.clave]);
    if (url) redes.push({ nombre: r.nombre, url });
  }
  return redes;
}

/** `vistaPrevia`: dentro del panel la portada es una muestra, no el titulo de la pagina (el panel ya tiene su <h1>): usa <h2>. */
export function PortadaMarca({ nombre, marca, vistaPrevia = false }: { nombre: string | undefined; marca: MarcaPublica | null | undefined; vistaPrevia?: boolean }) {
  const Titulo = vistaPrevia ? "h2" : "h1";
  const portada = urlHttps(marca?.portadaUrl);
  const logo = urlHttps(marca?.logoUrl);
  const titular = marca?.titular ?? (nombre ? `Pide en ${nombre}` : "Pedir en línea");
  const redes = redesDe(marca);
  return (
    <Card className="overflow-hidden" data-testid="portada-marca">
      {portada && <img src={portada} alt="" width={1200} height={400} fetchPriority="high" decoding="async" className="h-36 w-full object-cover sm:h-48" />}
      <div className="flex items-start gap-3 p-4">
        {logo && <img src={logo} alt={nombre ? `Logo de ${nombre}` : "Logo"} width={48} height={48} loading="lazy" decoding="async" className="size-12 shrink-0 rounded-md border border-border object-cover" />}
        <div className="min-w-0 flex-1">
          <Titulo className="text-xl font-semibold tracking-tight">{titular}</Titulo>
          {marca?.eslogan && <p className="mt-0.5 text-sm font-medium text-foreground">{marca.eslogan}</p>}
          {marca?.about && <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{marca.about}</p>}
          {!marca?.about && <p className="mt-1 text-sm text-muted-foreground">Elige la sucursal. Pagas en la sucursal (efectivo o tarjeta); no necesitas crear una cuenta.</p>}
          {redes.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {redes.map((r) => (
                <Button key={r.nombre} asChild variant="outline" size="xs">
                  <a href={r.url} target="_blank" rel="noopener noreferrer" aria-label={`${r.nombre} (se abre en otra pestaña)`}>
                    {r.nombre}
                    <ExternalLink aria-hidden="true" />
                  </a>
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
