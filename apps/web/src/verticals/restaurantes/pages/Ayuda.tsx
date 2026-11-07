// F4c (5) -- Centro de ayuda minimo: contenido estatico por vertical (ver lib/ayuda-contenido.ts). Sin backend: no hay controles que dependan de el.
import { useState } from "react";
import { LifeBuoy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, EstadoVacio, Input, PageContainer, useTituloBarra } from "@atiende/ui";
import { AYUDA_POR_VERTICAL, buscarAyuda } from "../lib/ayuda-contenido.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

export function RestaurantesAyudaPage(_ctx: RestaurantesShellContext) {
  useTituloBarra("Centro de ayuda", LifeBuoy);
  const [consulta, setConsulta] = useState("");
  const temas = buscarAyuda(AYUDA_POR_VERTICAL.restaurantes, consulta);
  return (
    <PageContainer padding="none">
      {/* El nombre de la pagina ya lo muestra la barra superior del shell (contrato de pagina UNI-4): solo queda el h1 para lectores de pantalla. */}
      <h1 className="sr-only">Centro de ayuda</h1>
      <Input type="search" value={consulta} onChange={(e) => setConsulta(e.target.value)} placeholder="Buscar en la ayuda (por ejemplo: borrar producto, idiomas, propina)" aria-label="Buscar en la ayuda" />
      {temas.length === 0 ? (
        <EstadoVacio titulo="No encontramos ese tema" mensaje="Prueba con otra palabra, por ejemplo «producto», «agente» o «idioma»." />
      ) : (
        <ul className="flex flex-col gap-2">
          {temas.map((t) => (
            <li key={t.id}>
              <Card>
                <CardHeader>
                  <CardTitle>{t.titulo}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <p className="m-0 text-xs text-muted-foreground">Quién puede: {t.roles}</p>
                  <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-sm text-foreground">
                    {t.pasos.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ol>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
