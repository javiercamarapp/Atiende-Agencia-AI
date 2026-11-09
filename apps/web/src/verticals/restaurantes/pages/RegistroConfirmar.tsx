// /restaurantes/registro/confirmar#token=...: el enlace del correo de registro. El token viaja en el fragmento (nunca llega al servidor
// ni a los escaneres de enlaces) y se canjea SOLO con el clic del dueño (POST), asi un escaner que abre el enlace no consume el registro.
// Al confirmar, el servidor crea la organizacion y devuelve un codigo de intercambio de 60 s; la pantalla lo pasa al mismo puente de
// sesion que magic link y Google (/restaurantes/auth/google/callback?code=...).
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Callout, Card, CardContent } from "@atiende/ui";
import { confirmarRegistro, RegistroError, tokenDelFragmento } from "../lib/registro-client.ts";

export interface RestaurantesRegistroConfirmarPageProps {
  readonly apiBaseUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** Fragmento de la URL (inyectable en pruebas). */
  readonly hash?: string;
}

export function RestaurantesRegistroConfirmarPage({ apiBaseUrl, fetchImpl = fetch, hash }: RestaurantesRegistroConfirmarPageProps) {
  const navigate = useNavigate();
  const token = tokenDelFragmento(hash ?? (typeof window !== "undefined" ? window.location.hash : ""));
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : "El enlace está incompleto. Ábrelo directo desde tu correo o vuelve a registrarte.");

  async function crear() {
    if (!token) return;
    setEnviando(true);
    setError(null);
    try {
      const { code } = await confirmarRegistro(fetchImpl, apiBaseUrl, token);
      navigate(`/restaurantes/auth/google/callback?code=${encodeURIComponent(code)}`, { replace: true });
    } catch (err) {
      setError(err instanceof RegistroError ? err.message : "Ocurrió un error inesperado. Intenta de nuevo.");
      setEnviando(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-6">
      <Card className="w-[min(480px,92vw)]">
        <CardContent className="flex flex-col gap-3 p-5">
          <h1 className="m-0 font-display text-xl font-semibold text-foreground">Crea tu restaurante</h1>
          <p className="m-0 text-sm text-foreground">Tu correo quedó confirmado. Toca el botón para crear tu restaurante con 14 días de prueba y tu primera sucursal.</p>
          {error ? (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          ) : null}
          <Button type="button" onClick={() => void crear()} disabled={!token || enviando} className="w-full">
            {enviando ? "Creando tu restaurante…" : "Crear mi restaurante"}
          </Button>
          <Link to="/restaurantes/registro" className="text-center text-sm text-primary">
            Volver al registro
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
