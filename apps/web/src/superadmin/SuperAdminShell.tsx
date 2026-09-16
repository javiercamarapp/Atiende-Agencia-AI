// Shell del back office de plataforma — mismo patrón exacto que
// `HotelesShell.tsx`/`RestaurantesShell.tsx` (resuelve sesión, Sidebar real de
// `@atiende/ui`), pero SIN selector de organización/propiedad (aquí no hay
// "una" organización activa -- el superadmin ve TODAS a la vez) y sin
// `BotonChatDatos` (no aplica a un panel de plataforma, no de negocio).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Building2 } from "lucide-react";
import { Sidebar } from "@atiende/ui";
import { logout } from "../lib/auth-client.ts";
import { clearSuperadminSession, readPersistedSuperadminSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";

export interface SuperAdminShellProps {
  readonly apiBaseUrl: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: { readonly apiBaseUrl: string; readonly token: string }) => ReactNode;
}

const SECTIONS = [
  {
    title: "Plataforma",
    siempreAbierto: true,
    items: [{ to: "/superadmin", label: "Organizaciones", icon: Building2 }],
  },
];

export function SuperAdminShell({ apiBaseUrl, onRequireLogin, children }: SuperAdminShellProps) {
  const [session, setSession] = useState<LoginSession | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [resuelto, setResuelto] = useState(false);

  useEffect(() => {
    const s = readPersistedSuperadminSession(window.localStorage);
    setSession(s);
    setResuelto(true);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

  async function handleLogout() {
    if (!session) return;
    setLoggingOut(true);
    try {
      await logout(fetch, apiBaseUrl, session.refreshToken);
    } finally {
      clearSuperadminSession(window.localStorage);
      setSession(null);
      onRequireLogin();
    }
  }

  if (!resuelto) return null;
  if (!session) return null;

  return (
    <div className="min-h-screen bg-background flex gap-4 p-4">
      <Sidebar sections={SECTIONS} user={{ email: session.email, rol: loggingOut ? "Saliendo…" : "Superadmin" }} onLogout={handleLogout} />
      <main className="flex-1 min-w-0">{children({ apiBaseUrl, token: session.token })}</main>
    </div>
  );
}
