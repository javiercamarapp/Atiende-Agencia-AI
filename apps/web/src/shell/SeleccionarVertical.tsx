// Página raíz de app.useatiende.ai — antes de esta pieza, "/" redirigía
// incondicionalmente a /restaurantes/login (residuo de cuando este monorepo
// tenía una sola vertical real, ver el comentario de cabecera de App.tsx). Con
// las 6 verticales ya con login/shell reales, la raíz necesita un selector
// real: quien llega sin sesión (o sin saber a qué vertical pertenece su
// cuenta) elige aquí, en vez de aterrizar siempre en restaurantes. Ninguna
// vertical arbitrariamente "primero" -- las 6 en igualdad, orden alfabético.
//
// Deliberadamente SIN lógica de sesión propia: si el visitante ya tiene una
// sesión persistida de alguna vertical, su propio Shell (via `AppDeps`/rutas
// protegidas) lo redirige de cualquier forma al entrar a esa vertical -- esta
// página es solo el punto de entrada para quien todavía no eligió ninguna.
import { Link } from "react-router-dom";
import { AtiendeWordmark, Card, CardContent } from "@atiende/ui";
import {
  BedDouble,
  Building2,
  CalendarCheck,
  Gavel,
  Home,
  UtensilsCrossed,
} from "lucide-react";
import "../pages/login.css";

interface VerticalEntry {
  readonly slug: string;
  readonly nombre: string;
  readonly descripcion: string;
  readonly Icono: typeof BedDouble;
}

const VERTICALES: readonly VerticalEntry[] = [
  { slug: "despachos", nombre: "Despachos", descripcion: "CFDI, nómina, conciliación y cierres mensuales para tu despacho contable.", Icono: Building2 },
  { slug: "citas", nombre: "Citas", descripcion: "Reservas y turnos sincronizados con Google Calendar, por WhatsApp.", Icono: CalendarCheck },
  { slug: "hoteles", nombre: "Hoteles", descripcion: "Reservas y operación de tu hotel boutique, por WhatsApp.", Icono: BedDouble },
  { slug: "licitaciones", nombre: "Licitaciones", descripcion: "Convocatorias públicas rastreadas, evaluadas y respondidas a tiempo.", Icono: Gavel },
  { slug: "rentas", nombre: "Rentas vacacionales", descripcion: "Calendarios multi-unidad, sincronía con Booking, Airbnb y Vrbo.", Icono: Home },
  { slug: "restaurantes", nombre: "Restaurantes", descripcion: "Tus meseros y tu agente de IA, tomando el mismo pedido.", Icono: UtensilsCrossed },
];

export function SeleccionarVerticalPage() {
  return (
    <main className="login min-h-screen flex flex-col items-center px-6 py-14 sm:py-20">
      <header className="login-entra mb-12">
        <AtiendeWordmark />
      </header>

      <div className="login-entra w-full max-w-3xl text-center" style={{ animationDelay: "60ms" }}>
        <p className="login-kicker">Bienvenido a atiende.ai</p>
        <h1 className="login-serif mt-4 text-[32px] sm:text-[40px] text-foreground">¿A qué negocio quieres entrar?</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
          Elige tu vertical para ir a su panel de acceso.
        </p>
      </div>

      <div className="login-entra grid w-full max-w-3xl grid-cols-1 gap-3 mt-10 sm:grid-cols-2" style={{ animationDelay: "120ms" }}>
        {VERTICALES.map(({ slug, nombre, descripcion, Icono }) => (
          <Link key={slug} to={`/${slug}/login`} className="block no-underline">
            <Card className="h-full transition-colors hover:border-primary/50 hover:bg-muted/40">
              <CardContent className="flex items-start gap-3 p-5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Icono className="h-[18px] w-[18px]" />
                </span>
                <span className="text-left">
                  <span className="block text-[15px] font-semibold text-foreground">{nombre}</span>
                  <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{descripcion}</span>
                </span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <p className="login-entra mt-12 text-pretty text-center text-[12px] leading-[1.7] text-muted-foreground" style={{ animationDelay: "180ms" }}>
        Al continuar, aceptas los{" "}
        <Link to="/terminos" className="underline underline-offset-2 text-foreground hover:opacity-70 transition-opacity">
          Términos de Servicio
        </Link>{" "}
        y el{" "}
        <Link to="/privacidad" className="underline underline-offset-2 text-foreground hover:opacity-70 transition-opacity">
          Aviso de Privacidad
        </Link>{" "}
        de atiende.ai.
      </p>
    </main>
  );
}
