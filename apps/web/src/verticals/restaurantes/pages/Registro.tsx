// Registro autoservicio de restaurantes (/restaurantes/registro): el dueño crea su restaurante con su correo (enlace de un solo uso) o
// con Google. Nace en prueba de 14 dias con su primera sucursal inactiva (backend real: apps/api/src/routes/registro-restaurantes.ts,
// migracion 0077). Sin la migracion o sin repositorio el servidor dice «no disponible aún» y esta pantalla lo muestra tal cual.
// Anti-abuso sin captcha: campo oculto `sitioWeb` (trampa) y el tiempo de llenado (`msLlenado`) que el servidor revisa.
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button, Callout, Card, CardContent, GoogleIcon, Input, Label } from "@atiende/ui";
import { ERRORES_REGISTRO, fetchRegistroEstado, iniciarRegistro, RegistroError } from "../lib/registro-client.ts";
import type { RegistroEstado } from "../lib/registro-client.ts";

export interface RestaurantesRegistroPageProps {
  readonly apiBaseUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** Navegacion a Google (inyectable en pruebas). */
  readonly irA?: (url: string) => void;
}

const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";

function zonaDelNavegador(): string | null {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof z === "string" && z.includes("/") ? z : null;
  } catch {
    return null;
  }
}

export function RestaurantesRegistroPage({ apiBaseUrl, fetchImpl = fetch, irA = (url) => window.location.assign(url) }: RestaurantesRegistroPageProps) {
  const [searchParams] = useSearchParams();
  const errorGoogle = searchParams.get("registro_error");
  const montadoEn = useRef(Date.now());
  const [estado, setEstado] = useState<RegistroEstado | null>(null);
  const [estadoError, setEstadoError] = useState(false);
  const [nombreNegocio, setNombreNegocio] = useState("");
  const [nombreSucursal, setNombreSucursal] = useState("");
  const [nombreCompleto, setNombreCompleto] = useState("");
  const [correo, setCorreo] = useState("");
  const [sitioWeb, setSitioWeb] = useState("");
  const [enviando, setEnviando] = useState<"correo" | "google" | null>(null);
  const [error, setError] = useState<string | null>(errorGoogle ? (ERRORES_REGISTRO[errorGoogle] ?? ERRORES_REGISTRO.error!) : null);
  const [enviadoA, setEnviadoA] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    fetchRegistroEstado(fetchImpl, apiBaseUrl)
      .then((e) => vivo && setEstado(e))
      .catch(() => vivo && setEstadoError(true));
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, fetchImpl]);

  async function enviar(metodo: "correo" | "google") {
    setError(null);
    if (nombreNegocio.trim().length < 2 || nombreSucursal.trim().length < 2 || nombreCompleto.trim().length < 2) {
      setError("Escribe el nombre del restaurante, de tu primera sucursal y el tuyo (mínimo 2 letras).");
      return;
    }
    if (metodo === "correo" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim())) {
      setError("Escribe un correo válido.");
      return;
    }
    setEnviando(metodo);
    try {
      const { url } = await iniciarRegistro(fetchImpl, apiBaseUrl, {
        metodo,
        ...(metodo === "correo" ? { correo: correo.trim() } : {}),
        nombreNegocio,
        nombreSucursal,
        nombreCompleto,
        zonaHoraria: zonaDelNavegador(),
        sitioWeb,
        msLlenado: Date.now() - montadoEn.current,
      });
      if (metodo === "google" && url) {
        irA(url);
        return;
      }
      setEnviadoA(correo.trim());
    } catch (err) {
      setError(err instanceof RegistroError ? err.message : "Ocurrió un error inesperado. Intenta de nuevo.");
    } finally {
      setEnviando(null);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void enviar("correo");
  }

  if (enviadoA) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4 py-6">
        <Card className="w-[min(480px,92vw)]">
          <CardContent className="flex flex-col gap-3 p-5">
            <h1 className="m-0 font-display text-xl font-semibold text-foreground">Revisa tu correo</h1>
            <p className="m-0 text-sm text-foreground">
              Te mandamos un enlace a <strong>{enviadoA}</strong>. Ábrelo en los próximos 30 minutos para crear tu restaurante. Si no llega, revisa la carpeta de spam.
            </p>
            <Button type="button" variant="outline" onClick={() => setEnviadoA(null)}>
              Corregir mis datos
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const noDisponible = estadoError || (estado !== null && !estado.disponible);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <form onSubmit={onSubmit} noValidate className="flex w-[min(520px,94vw)] flex-col gap-4" aria-label="Registro de restaurante">
        <div>
          <h1 className="m-0 mb-1 font-display text-xl font-semibold text-foreground">Crea tu restaurante en atiende</h1>
          <p className="m-0 text-sm text-muted-foreground">14 días de prueba. Tu agente de WhatsApp queda listo cuando cargues tu menú, horario y zonas.</p>
        </div>

        {noDisponible ? (
          <Callout tone="warning" titulo="No disponible aún">
            El registro de restaurantes todavía no está habilitado. Escríbenos para darte de alta.
          </Callout>
        ) : null}
        {error ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}

        <fieldset className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4" disabled={noDisponible || enviando !== null}>
          <legend className="px-1 text-sm font-semibold text-foreground">Tu restaurante</legend>
          <Label className={LABEL_CLASES} htmlFor="registro-negocio">
            Nombre del restaurante
            <Input id="registro-negocio" value={nombreNegocio} onChange={(e) => setNombreNegocio(e.target.value)} maxLength={120} autoComplete="organization" required />
          </Label>
          <Label className={LABEL_CLASES} htmlFor="registro-sucursal">
            Nombre de tu primera sucursal
            <Input id="registro-sucursal" value={nombreSucursal} onChange={(e) => setNombreSucursal(e.target.value)} maxLength={120} placeholder="Ej. Centro, Altabrisa" required />
          </Label>
          <Label className={LABEL_CLASES} htmlFor="registro-nombre">
            Tu nombre
            <Input id="registro-nombre" value={nombreCompleto} onChange={(e) => setNombreCompleto(e.target.value)} maxLength={120} autoComplete="name" required />
          </Label>
          {/* Trampa de bots: invisible y fuera del orden de tabulacion; una persona nunca la llena. */}
          <div aria-hidden="true" className="hidden">
            <label htmlFor="registro-sitio">Sitio web</label>
            <input id="registro-sitio" name="sitioWeb" tabIndex={-1} autoComplete="off" value={sitioWeb} onChange={(e) => setSitioWeb(e.target.value)} />
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4" disabled={noDisponible || enviando !== null}>
          <legend className="px-1 text-sm font-semibold text-foreground">Cómo vas a entrar</legend>
          {estado?.google ? (
            <>
              <Button type="button" variant="outline" className="w-full" onClick={() => void enviar("google")}>
                <GoogleIcon className="mr-2 h-4 w-4" />
                {enviando === "google" ? "Abriendo Google…" : "Continuar con Google"}
              </Button>
              <p className="m-0 text-center text-xs text-muted-foreground">o con tu correo</p>
            </>
          ) : null}
          <Label className={LABEL_CLASES} htmlFor="registro-correo">
            Correo
            <Input id="registro-correo" type="email" value={correo} onChange={(e) => setCorreo(e.target.value)} maxLength={254} autoComplete="email" />
          </Label>
          <Button type="submit" className="w-full">
            {enviando === "correo" ? "Enviando enlace…" : "Recibir enlace para crear mi restaurante"}
          </Button>
          <p className="m-0 text-xs text-muted-foreground">Sin contraseñas: entras con un enlace a tu correo o con Google.</p>
        </fieldset>

        <p className="m-0 text-center text-sm text-muted-foreground">
          ¿Ya tienes cuenta?{" "}
          <Link to="/restaurantes/login" className="font-medium text-primary">
            Inicia sesión
          </Link>
        </p>
      </form>
    </main>
  );
}
