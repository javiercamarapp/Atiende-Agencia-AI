// Directorio PUBLICO de sucursales (`/pedir/:org/sucursales`): TODAS las sucursales que el negocio marco visibles,
// con direccion, telefono, horario semanal, "Como llegar" e insignias. Solo las activas llevan a pedir; las
// informativas se muestran sin boton. Todo sale del servidor (`GET .../storefront/directorio`): nada inventado.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, StatusBadge } from "@atiende/ui";
import { crearClienteStorefront, type SucursalDirectorio } from "./storefront-client.ts";
import { enlaceTel, lineasHorario } from "./horario-texto.ts";
import { StorefrontLayout } from "./StorefrontLayout.tsx";
import { SucursalSugerida } from "./SucursalSugerida.tsx";
import { useMetaPublica } from "./meta-publica.ts";

export function insigniasDe(s: SucursalDirectorio): Array<{ texto: string; tone: "success" | "info" | "warning" | "neutral" }> {
  const lista: Array<{ texto: string; tone: "success" | "info" | "warning" | "neutral" }> = [];
  if (s.soloInformativa) lista.push({ texto: "Solo informativa", tone: "neutral" });
  else lista.push({ texto: "Pide en línea", tone: "success" });
  if (s.soloRecoger) lista.push({ texto: "Solo recoger", tone: "info" });
  else if (s.insigniaDomicilio) lista.push({ texto: s.insigniaDomicilio, tone: "info" });
  if (s.deTemporada) lista.push({ texto: "Temporada", tone: "warning" });
  return lista;
}

export function SucursalesPage({ apiBaseUrl, orgSlug }: { apiBaseUrl: string; orgSlug: string }) {
  const cliente = useMemo(() => crearClienteStorefront(apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const [estado, setEstado] = useState<{ nombre: string; sucursales: SucursalDirectorio[] } | "cargando" | { error: string }>("cargando");

  const cargar = useCallback(() => {
    setEstado("cargando");
    cliente
      .directorio()
      .then((r) => setEstado({ nombre: r.restaurante.nombre, sucursales: r.sucursales }))
      .catch((e: unknown) => setEstado({ error: e instanceof Error ? e.message : "No pudimos cargar las sucursales." }));
  }, [cliente]);
  useEffect(cargar, [cargar]);

  const nombre = typeof estado === "object" && "nombre" in estado ? estado.nombre : undefined;
  useMetaPublica({
    titulo: nombre ? `Sucursales de ${nombre}` : "Sucursales",
    descripcion: nombre ? `Direcciones, teléfonos y horarios de las sucursales de ${nombre}.` : "Direcciones, teléfonos y horarios de las sucursales.",
    indexable: true,
  });

  return (
    <StorefrontLayout orgSlug={orgSlug} nombre={nombre}>
      <h1 className="text-lg font-semibold tracking-tight">{nombre ? `Sucursales de ${nombre}` : "Sucursales"}</h1>
      <p className="mt-1 text-sm text-muted-foreground">Dirección, teléfono y horario de cada sucursal. Para pedir en línea elija una sucursal que lo permita.</p>
      <div className="mt-4">
        <SucursalSugerida apiBaseUrl={apiBaseUrl} orgSlug={orgSlug} />
        {estado === "cargando" && <EstadoCargando />}
        {typeof estado === "object" && "error" in estado && <EstadoError mensaje={estado.error} onReintentar={cargar} />}
        {typeof estado === "object" && "sucursales" in estado && estado.sucursales.length === 0 && (
          <EstadoVacio titulo="Sin sucursales publicadas" mensaje="Este restaurante todavía no publica su directorio de sucursales." />
        )}
        {typeof estado === "object" && "sucursales" in estado && estado.sucursales.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2">
            {estado.sucursales.map((s) => {
              const tel = enlaceTel(s.phone);
              const horario = lineasHorario(s.horario);
              return (
                <li key={s.slug}>
                  <Card>
                    <CardContent className="flex flex-col gap-2 p-4">
                      <h2 className="text-sm font-semibold">{s.name}</h2>
                      <div className="flex flex-wrap gap-1.5" aria-label="Características de la sucursal">
                        {insigniasDe(s).map((i) => (
                          <StatusBadge key={i.texto} tone={i.tone}>
                            {i.texto}
                          </StatusBadge>
                        ))}
                      </div>
                      {s.address ? <p className="text-ui text-muted-foreground">{s.address}</p> : <p className="text-ui text-muted-foreground">Dirección no publicada.</p>}
                      {horario.length > 0 ? (
                        <ul className="text-ui text-muted-foreground" aria-label={`Horario de ${s.name}`}>
                          {horario.map((l) => (
                            <li key={l}>{l}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-ui text-muted-foreground">Consulte el horario con la sucursal.</p>
                      )}
                      <div className="mt-1 flex flex-wrap gap-2">
                        {tel && (
                          <Button asChild variant="outline" size="sm">
                            <a href={tel}>Llamar {s.phone}</a>
                          </Button>
                        )}
                        {s.comoLlegarUrl && (
                          <Button asChild variant="outline" size="sm">
                            <a href={s.comoLlegarUrl} target="_blank" rel="noreferrer">
                              Cómo llegar
                            </a>
                          </Button>
                        )}
                        {s.pideEnLinea && (
                          <Button asChild size="sm">
                            <Link to={`/pedir/${orgSlug}/${s.slug}`}>Pedir en {s.name}</Link>
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </StorefrontLayout>
  );
}
