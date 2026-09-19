// "Entrar a los otros paneles" — pedido real de Javier: desde superadmin, poder
// entrar a cada una de las 6 soluciones con tu propia sesión (sin credenciales
// ajenas) para ver cómo se ve y probar botones/comandos reales. Backend real: ver
// el comentario de cabecera de POST /superadmin/paneles/:vertical/entrar
// (apps/api/src/routes/superadmin.ts) y de la migración 0014 — esta página
// encadena esa ruta con POST /auth/select-org (ya existente, mismo Bearer) y
// GET /auth/me para obtener una sesión real del Shell de esa vertical, y navega
// ahí exactamente como decide un login normal (mismo patrón de
// `shell/GoogleCallback.tsx`: resolver `/auth/me` con el token nuevo, persistir
// con la función `persist<Vertical>Session` de esa vertical, navegar a
// `/<vertical>/<slug>`).
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { BedDouble, Calculator, CalendarCheck, Gavel, Home, UtensilsCrossed } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@atiende/ui";
import type { LoginSession } from "../../lib/auth-client.ts";
import { persistSession } from "../../lib/auth-client.ts";
import { persistHotelesSession } from "../../verticals/hoteles/lib/auth-client.ts";
import { persistCitasSession } from "../../verticals/citas/lib/auth-client.ts";
import { persistLicitacionesSession } from "../../verticals/licitaciones/lib/auth-client.ts";
import { persistDespachosSession } from "../../verticals/despachos/lib/auth-client.ts";
import { persistRentasSession } from "../../verticals/rentas/lib/auth-client.ts";

interface VerticalEntry {
  readonly slug: string;
  readonly nombre: string;
  readonly descripcion: string;
  readonly icon: LucideIcon;
}

// Mismos 6 slugs/nombres/descripciones reales que shell/SeleccionarVertical.tsx
// (el selector público de "¿a qué negocio quieres entrar?") — mismo vocabulario,
// para que un superadmin reconozca de inmediato cada tarjeta.
const VERTICALES: readonly VerticalEntry[] = [
  { slug: "restaurantes", nombre: "Restaurantes", descripcion: "Tus meseros y tu agente de IA, tomando el mismo pedido.", icon: UtensilsCrossed },
  { slug: "hoteles", nombre: "Hoteles", descripcion: "Reservas y operación de tu hotel boutique, por WhatsApp.", icon: BedDouble },
  { slug: "rentas", nombre: "Rentas vacacionales", descripcion: "Calendarios multi-unidad, sincronía con Booking, Airbnb y Vrbo.", icon: Home },
  { slug: "licitaciones", nombre: "Licitaciones", descripcion: "Convocatorias públicas rastreadas, evaluadas y respondidas a tiempo.", icon: Gavel },
  { slug: "despachos", nombre: "Despachos", descripcion: "CFDI, nómina, conciliación y cierres mensuales para tu despacho contable.", icon: Calculator },
  { slug: "citas", nombre: "Citas", descripcion: "Reservas y turnos sincronizados con Google Calendar, por WhatsApp.", icon: CalendarCheck },
];

// Mismo mapa que `shell/GoogleCallback.tsx::POR_VERTICAL`, pero solo la mitad de
// "persist" -- aquí ya conocemos el `slug` de destino (lo devuelve la ruta
// /superadmin/paneles/:vertical/entrar), así que no hace falta la mitad de
// "decide" que ese puente sí necesita.
const PERSISTIR_POR_VERTICAL: Record<string, (storage: Storage, session: LoginSession) => void> = {
  restaurantes: persistSession,
  hoteles: persistHotelesSession,
  citas: persistCitasSession,
  licitaciones: persistLicitacionesSession,
  despachos: persistDespachosSession,
  rentas: persistRentasSession,
};

export function SuperAdminPanelesPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const navigate = useNavigate();
  const [entrandoA, setEntrandoA] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function entrarAPanel(vertical: string) {
    setError(null);
    setEntrandoA(vertical);
    const base = apiBaseUrl.replace(/\/$/, "");
    try {
      // a) asegura la organización DEMO real de esta vertical + membresía real
      // del superadmin en ella (idempotente, ver migración 0014).
      const resEntrar = await fetch(`${base}/superadmin/paneles/${vertical}/entrar`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      if (!resEntrar.ok) throw new Error();
      const { organizationId, slug } = (await resEntrar.json()) as { organizationId: string; slug: string };

      // b) mismo Bearer del superadmin, ahora pidiendo un token REAL ya
      // escopado a esa organización (POST /auth/select-org, ya existente).
      const resSelect = await fetch(`${base}/auth/select-org`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ organizationId }),
      });
      if (!resSelect.ok) throw new Error();
      const { token: nuevoToken, refreshToken } = (await resSelect.json()) as { token: string; refreshToken: string };

      // c) resuelve la sesión completa con el token nuevo (mismo criterio que
      // GoogleCallback.tsx: /auth/me es la única fuente real de fullName/
      // organizations para armar un LoginSession).
      const resMe = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${nuevoToken}` } });
      if (!resMe.ok) throw new Error();
      const bodyMe = (await resMe.json()) as { email: string; fullName?: string; organizations: LoginSession["organizations"] };
      const session: LoginSession = { token: nuevoToken, refreshToken, email: bodyMe.email, fullName: bodyMe.fullName ?? "", organizations: bodyMe.organizations };

      // d) persiste bajo la llave de sesión propia de esa vertical (nunca la
      // del superadmin -- son sesiones/localStorage independientes, mismo
      // criterio que GoogleCallback.tsx).
      const persistir = PERSISTIR_POR_VERTICAL[vertical];
      if (!persistir) throw new Error();
      persistir(window.localStorage, session);

      // e) mismo puente que ya usa GoogleCallback.tsx: navega directo al Shell
      // real de esa vertical con la sesión ya persistida.
      navigate(`/${vertical}/${slug}`);
    } catch {
      setError("No se pudo entrar a ese panel. Intenta de nuevo.");
      setEntrandoA(null);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Entrar a los otros paneles</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Entra con tu propia sesión a una organización demo real de cada solución — sin datos de ningún cliente, pero con comandos y botones que funcionan de verdad.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {VERTICALES.map(({ slug, nombre, descripcion, icon: Icon }) => (
          <Card key={slug}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Icon className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
                {nombre}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">{descripcion}</p>
              <Button onClick={() => void entrarAPanel(slug)} disabled={entrandoA !== null} className="rounded-full self-start px-6">
                {entrandoA === slug ? "Entrando…" : "Ver panel"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
