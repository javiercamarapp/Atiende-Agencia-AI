// Huespedes (H-27) -- busqueda del catalogo de huespedes de la propiedad y acceso a su ficha. Consume el catalogo
// `GET /hoteles/:propertyId/huespedes` (reservas.ts). Los datos de contacto que se ven aqui son los mismos que el staff de
// reservas ya ve al crear una reserva; el detalle (historial, notas, consentimientos) esta en la ficha.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, FormField, Input, PageContainer, PageHeader } from "@atiende/ui";
import { HUESPED_CRM_ROLES, buscarHuespedes } from "../lib/huespedes-client.ts";
import type { GuestOption } from "../lib/huespedes-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

export function HuespedesPage({ apiBaseUrl, token, propertyId, orgSlug, role }: HotelesShellContext) {
  const [q, setQ] = useState("");
  const [huespedes, setHuespedes] = useState<readonly GuestOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const puedeVer = HUESPED_CRM_ROLES.has(role);

  const load = useCallback(
    async (query: string) => {
      if (!puedeVer) return;
      setError(null);
      try {
        setHuespedes(await buscarHuespedes(fetch, apiBaseUrl, token, propertyId, query.trim() || undefined));
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo cargar el catálogo de huéspedes.");
      }
    },
    [apiBaseUrl, token, propertyId, puedeVer],
  );

  // Busqueda con un pequeño retraso para no consultar en cada tecla.
  useEffect(() => {
    const t = setTimeout(() => void load(q), 250);
    return () => clearTimeout(t);
  }, [q, load]);

  if (!puedeVer) {
    return (
      <PageContainer padding="none" className="gap-4">
        <EstadoVacio mensaje="Tu rol no tiene acceso a la ficha de huéspedes." />
      </PageContainer>
    );
  }

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader titulo="Huéspedes" descripcion="Catálogo de huéspedes de la propiedad y acceso a su ficha." />
      <FormField label="Buscar por nombre, correo o teléfono" className="w-full sm:w-72">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ana Torres" />
      </FormField>

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load(q)} />}
      {!huespedes && !error && <EstadoCargando etiqueta="Cargando huéspedes…" />}
      {huespedes && huespedes.length === 0 && <EstadoVacio mensaje={q.trim() ? "Ningún huésped coincide con la búsqueda." : "Esta propiedad aún no tiene huéspedes registrados."} />}
      {huespedes && huespedes.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {huespedes.map((g) => (
            <Link key={g.id} to={`/hoteles/${orgSlug}/huespedes/${g.id}`} className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Card className="h-full hover:bg-muted transition-colors">
                <CardContent className="p-3 flex flex-col gap-0.5">
                  <p className="text-sm font-medium text-foreground truncate">{g.nombreCompleto}</p>
                  <p className="text-xs text-muted-foreground truncate">{g.email ?? "Sin correo"}</p>
                  <p className="text-xs text-muted-foreground">{g.telefono ?? "Sin teléfono"}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
