// Aceptar invitación (Fase 14) — hallazgo de auditoría (severidad ALTA,
// "Invitaciones de staff (Fase 10) sin ninguna UI"): `routes/auth.ts::POST
// /auth/accept-invite` ya existía (genérico de core, ver el comentario de cabecera
// de esa ruta), pero ninguna pantalla lo llamaba — un invitado con un token real no
// tenía dónde pegarlo. Vive en `shell/` (no bajo `verticals/restaurantes/`) por el
// MISMO motivo que `lib/auth-client.ts::acceptInvite`: aceptar una invitación es
// login/registro genérico a las 6 verticales, fuera del shell autenticado de
// cualquiera de ellas — mismo criterio que Login.tsx de cada vertical, pero sin
// vertical todavía (la sesión que resulta SÍ trae una, ver `session.organizations`).
//
// Hoy la única vertical que expone crear invitaciones es restaurantes (ver
// `verticals/restaurantes/lib/admin-staff.ts`), así que en la práctica esta pantalla
// solo la usa un invitado de restaurantes — pero no asume eso: navega según el
// `vertical` real que trae la organización de la sesión aceptada, no un valor fijo.
import { useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, FormField, Input } from "@atiende/ui";
import { acceptInvite, decideLandingPathForInvite, LoginError, persistSession } from "../lib/auth-client.ts";
import type { LoginSession } from "../lib/auth-client.ts";

export interface AceptarInvitacionPageProps {
  readonly apiBaseUrl: string;
  readonly onAccepted: (session: LoginSession, landingPath: string) => void;
}

export function AceptarInvitacionPage({ apiBaseUrl, onAccepted }: AceptarInvitacionPageProps) {
  const [searchParams] = useSearchParams();
  const [token, setToken] = useState(searchParams.get("token") ?? "");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setSubmitting(true);
    try {
      const session = await acceptInvite(fetch, apiBaseUrl, { token, fullName, password });
      // Mismo storage genérico ("atiende.restaurantes.session") que ya usa
      // RestaurantesLoginPage — es el único consumidor real hoy (ver comentario de
      // cabecera). Cuando otra vertical exponga crear invitaciones, este mismo
      // `persistSession` seguirá sirviendo (la llave vive en lib/auth-client.ts, no
      // aquí), y decideLandingPathForInvite ya navega por `org.vertical` real.
      persistSession(window.localStorage, session);
      onAccepted(session, decideLandingPathForInvite(session));
    } catch (err) {
      setError(err instanceof LoginError ? err.message : "Ocurrió un error inesperado. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
      <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-3" noValidate>
        <h1 className="text-xl font-semibold">Aceptar invitación</h1>
        <p className="text-sm text-muted-foreground">Pega el token que te compartió quien te invitó y fija tu contraseña para entrar.</p>
        <FormField label="Token de invitación" required>
          <Input type="text" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className="font-mono" />
        </FormField>
        <FormField label="Nombre completo" required>
          <Input type="text" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </FormField>
        <FormField label="Contraseña (mínimo 8 caracteres)" required>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} />
        </FormField>
        <FormField label="Confirma tu contraseña" required>
          <Input type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={8} />
        </FormField>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? "Aceptando…" : "Aceptar y entrar"}
        </Button>
      </form>
    </main>
  );
}
