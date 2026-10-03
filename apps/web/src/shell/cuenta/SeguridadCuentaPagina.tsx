// Pagina "Seguridad de la cuenta" de las 6 consolas (PL-21): una sola pagina compartida, montada en el shell de
// cada vertical en `/<vertical>/:orgSlug/seguridad` (mismo patron que Notificaciones y Plan y uso). Reune las
// tarjetas de correo, contrasena, Google y sesiones activas; `extra` permite a una vertical anteponer lo suyo
// (licitaciones: verificacion en dos pasos, que es la unica que hoy tiene 2FA). Todo sale de endpoints reales
// (`/auth/account/estado`, `/auth/sessions/*`, `/auth/change-password`, `/auth/google/*`); con la base sin migrar
// las tarjetas lo dicen honestamente.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { EstadoError, PageContainer, PageHeader, useTituloBarra } from "@atiende/ui";
import { mensajeGoogleError } from "../../lib/google-auth.ts";
import { clienteCuenta } from "./cuenta-client.ts";
import type { CuentaEstado, SesionesEstado, VerticalCuenta } from "./cuenta-client.ts";
import { ContrasenaCard, CorreoCard, GoogleCard, SesionesCard } from "./SeguridadCuenta.tsx";

/** Mientras carga el estado de la cuenta: sin `available` ni identidades (las tarjetas no ofrecen nada). */
const CARGANDO: CuentaEstado = { available: false, email: "", emailVerified: true, hasPassword: true, google: { configured: false, available: false, identities: [] } };

export interface SeguridadCuentaPaginaProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly orgSlug: string;
  readonly vertical: VerticalCuenta;
  /** Nombre de la barra superior. `null` deja el del item activo del Sidebar (licitaciones ya la trae como "Seguridad"). @default "Seguridad de la cuenta" */
  readonly tituloBarra?: string | null;
  /** Tarjetas propias de la vertical, antes de las comunes; reciben los avisos globales de la pantalla. */
  readonly extra?: (avisos: { readonly onAviso: (mensaje: string | null) => void; readonly onError: (mensaje: string | null) => void }) => ReactNode;
}

export function SeguridadCuentaPagina({ apiBaseUrl, token, orgSlug, vertical, tituloBarra = "Seguridad de la cuenta", extra }: SeguridadCuentaPaginaProps) {
  useTituloBarra(tituloBarra, ShieldCheck);
  const [cuenta, setCuenta] = useState<CuentaEstado | null>(null);
  const [sesiones, setSesiones] = useState<SesionesEstado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const recargar = useCallback(async () => {
    const cliente = clienteCuenta(vertical);
    const [c, s] = await Promise.all([cliente.fetchCuentaEstado(fetch, apiBaseUrl, token), cliente.fetchSesiones(fetch, apiBaseUrl, token)]);
    setCuenta(c);
    setSesiones(s);
  }, [apiBaseUrl, token, vertical]);

  useEffect(() => {
    let vivo = true;
    const cliente = clienteCuenta(vertical);
    void Promise.all([cliente.fetchCuentaEstado(fetch, apiBaseUrl, token), cliente.fetchSesiones(fetch, apiBaseUrl, token)]).then(([c, s]) => {
      if (!vivo) return;
      setCuenta(c);
      setSesiones(s);
    });
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, token, vertical]);

  // Regreso del flujo "vincular Google" (`?google_link=ok|<codigo>`): se muestra una vez y se limpia de la URL.
  useEffect(() => {
    const resultado = new URLSearchParams(window.location.search).get("google_link");
    if (!resultado) return;
    if (resultado === "ok") setAviso("Cuenta de Google vinculada.");
    else setError(mensajeGoogleError(resultado));
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const comunes = { apiBaseUrl, token, vertical, onAviso: setAviso, onError: setError } as const;
  const estado = cuenta ?? CARGANDO;

  return (
    <PageContainer className="gap-3 [&>*]:min-w-0">
      <PageHeader titulo="Seguridad de la cuenta" descripcion="Tu correo, tu contraseña, Google y los dispositivos con la sesión abierta." />

      {error && <EstadoError mensaje={error} compacto />}
      {aviso && (
        <p role="status" className="text-ui text-foreground">
          {aviso}
        </p>
      )}

      {extra?.({ onAviso: setAviso, onError: setError })}
      <CorreoCard {...comunes} estado={estado} />
      <ContrasenaCard {...comunes} estado={estado} />
      <GoogleCard {...comunes} orgSlug={orgSlug} estado={estado} onCambio={recargar} />
      <SesionesCard {...comunes} sesiones={sesiones} onCambio={recargar} />
    </PageContainer>
  );
}
