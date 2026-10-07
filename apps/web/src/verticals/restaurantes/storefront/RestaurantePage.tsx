// Pagina publica del restaurante: sus sucursales con estado de apertura y reglas basicas, para elegir donde pedir.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, StatusBadge } from "@atiende/ui";
import { formatoPesos } from "./carrito.ts";
import { crearClienteStorefront, type RestaurantePublico, type SucursalPublica } from "./storefront-client.ts";
import { enlaceWhatsappSeguro } from "./BotonWhatsapp.tsx";
import { PortadaMarca } from "./MarcaPortada.tsx";
import { PromocionesSeccion } from "./PromocionesSeccion.tsx";
import { StorefrontLayout } from "./StorefrontLayout.tsx";
import { SucursalSugerida } from "./SucursalSugerida.tsx";
import { useMetaPublica } from "./meta-publica.ts";

export function textoApertura(s: SucursalPublica): { texto: string; tone: "success" | "danger" | "neutral" } {
  if (s.abiertoAhora === null) return { texto: "Consulta el horario con la sucursal", tone: "neutral" };
  if (s.abiertoAhora) return { texto: s.cierraA ? `Abierto ahora · cierra a las ${s.cierraA}` : "Abierto ahora", tone: "success" };
  const p = s.proximaApertura;
  return { texto: p ? `Cerrado · abre ${p.hoy ? "hoy" : `el ${p.dia}`} a las ${p.hora}` : "Cerrado ahora", tone: "danger" };
}

export function RestaurantePage({ apiBaseUrl, orgSlug }: { apiBaseUrl: string; orgSlug: string }) {
  const cliente = useMemo(() => crearClienteStorefront(apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const [estado, setEstado] = useState<{ nombre: string; datos: RestaurantePublico; sucursales: SucursalPublica[] } | "cargando" | { error: string }>("cargando");

  const cargar = useCallback(() => {
    setEstado("cargando");
    cliente
      .sucursales()
      .then((r) => setEstado({ nombre: r.restaurante.nombre, datos: r, sucursales: r.sucursales }))
      .catch((e: unknown) => setEstado({ error: e instanceof Error ? e.message : "No pudimos cargar el restaurante." }));
  }, [cliente]);
  useEffect(cargar, [cargar]);

  const nombre = typeof estado === "object" && "nombre" in estado ? estado.nombre : undefined;
  const marca = typeof estado === "object" && "datos" in estado ? estado.datos.marca : undefined;
  const promociones = typeof estado === "object" && "datos" in estado ? estado.datos.promociones : undefined;
  const sucursalesCargadas = typeof estado === "object" && "sucursales" in estado ? estado.sucursales : [];
  // Boton flotante: solo si hay UNA sucursal con numero valido (con varias, cada tarjeta trae su propio enlace de WhatsApp).
  const conWhatsapp = sucursalesCargadas.filter((s) => enlaceWhatsappSeguro(s.whatsappUrl));
  const whatsappFlotante = conWhatsapp.length === 1 && sucursalesCargadas.length === 1 ? conWhatsapp[0]!.whatsappUrl : null;
  useMetaPublica({
    titulo: marca?.titular ? `${marca.titular} · ${nombre ?? "Pedir en línea"}` : nombre ? `${nombre} · Pedir en línea` : "Pedir en línea",
    descripcion: marca?.about ?? (nombre ? `Haz tu pedido en línea en ${nombre}: elige sucursal, arma tu pedido y paga en la sucursal.` : "Haz tu pedido en línea."),
    indexable: true,
    imagen: marca?.portadaUrl ?? marca?.logoUrl,
  });

  return (
    <StorefrontLayout orgSlug={orgSlug} nombre={nombre} marca={marca} whatsappUrl={whatsappFlotante}>
      {typeof estado === "object" && "datos" in estado ? <PortadaMarca nombre={nombre} marca={marca} /> : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{nombre ? `Pide en ${nombre}` : "Pedir en línea"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Elige la sucursal. Pagas en la sucursal (efectivo o tarjeta); no necesitas crear una cuenta.</p>
        </>
      )}
      {typeof estado === "object" && "datos" in estado && <PromocionesSeccion promociones={promociones} sucursales={sucursalesCargadas} />}
      <div className="mt-6">
        <SucursalSugerida apiBaseUrl={apiBaseUrl} orgSlug={orgSlug} />
        {estado === "cargando" && <EstadoCargando />}
        {typeof estado === "object" && "error" in estado && <EstadoError mensaje={estado.error} onReintentar={cargar} />}
        {typeof estado === "object" && "sucursales" in estado && estado.sucursales.length === 0 && (
          <EstadoVacio titulo="Sin sucursales disponibles" mensaje="Por ahora este restaurante no tiene sucursales abiertas para pedidos en línea." />
        )}
        {typeof estado === "object" && "sucursales" in estado && estado.sucursales.length > 0 && (
          <ul className="grid gap-4 sm:grid-cols-2">
            {estado.sucursales.map((s) => {
              const ap = textoApertura(s);
              return (
                <li key={s.slug}>
                  <Card>
                    <CardContent className="flex flex-col gap-3 p-5">
                      <h2 className="text-lg font-semibold">{s.name}</h2>
                      {s.address && <p className="text-sm text-muted-foreground">{s.address}</p>}
                      <StatusBadge tone={ap.tone} className="self-start">
                        {ap.texto}
                      </StatusBadge>
                      <p className="text-xs text-muted-foreground">
                        {s.pedidoMinimoDomicilio !== null ? `Mínimo a domicilio ${formatoPesos(s.pedidoMinimoDomicilio)}. ` : ""}
                        {s.zonasReparto.length > 0 ? `Reparto en ${s.zonasReparto.length} zonas.` : ""}
                      </p>
                      <Button asChild>
                        <Link to={`/pedir/${orgSlug}/${s.slug}`}>Ver menú y pedir en {s.name}</Link>
                      </Button>
                      {enlaceWhatsappSeguro(s.whatsappUrl) && (
                        <Button asChild variant="outline">
                          <a href={s.whatsappUrl!} target="_blank" rel="noopener noreferrer">
                            Escribir por WhatsApp a {s.name}
                          </a>
                        </Button>
                      )}
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
