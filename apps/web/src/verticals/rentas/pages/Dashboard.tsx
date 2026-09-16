// Landing real del panel de rentas (Fase 12) — cierra el hallazgo "login de rentas
// redirige a /rentas/:slug, ruta que no existía en la SPA (pantalla en blanco tras
// autenticarse)": RentasShell.tsx ya resuelve sesión + properties reales antes de
// llegar aquí, esta página solo las muestra. Real, no un stub: organización,
// propiedades y rol del staff logueado vienen todos de datos reales (sesión
// persistida + GET /v1/rentas/:orgSlug/admin/propiedades), nada inventado.
//
// Esta fase era específicamente "que el login deje de terminar en pantalla en
// blanco", no portar el resto del dashboard operativo -- el resto de páginas se
// fue agregando fase a fase (ver comentarios de cabecera de RentasShell.tsx). El
// calendario de reservas y bloqueos tiene UI real desde la Fase 13
// (pages/Calendario.tsx, link "Calendario"), el cotizador + configuración de
// pricing desde la Fase 14 (pages/Precios.tsx, link "Precios"), la bandeja de
// aprobación de mensajería desde la Fase 15 (pages/Aprobaciones.tsx, link
// "Aprobaciones"), y movimiento por reserva + owner statements + payouts desde la
// Fase 16 (pages/Finanzas.tsx, link "Finanzas").
//
// Fase 18 -- cierra la mitad del hallazgo de auditoría "en rentas, una empresa
// gestora con varias propiedades solo puede operar la primera" que le tocaba a esta
// página: hasta esta fase la lista de properties de abajo era solo informativa (un
// <li> sin ningún onClick). Ahora cada property es un botón real que cambia la
// property activa del Shell (RentasShellContext.setPropertyId, ver el selector real
// del nav en RentasShell.tsx -- esta lista es un segundo punto de entrada al mismo
// estado, no un selector paralelo) y la property activa queda resaltada.
//
// Ronda de portado del sistema de diseño real (@atiende/ui, mismo criterio que
// RentasShell.tsx): reemplaza los `style={{...}}` hechos a mano por Card/Button/
// Badge/EstadoVacio y clases de token (bg-card, text-muted-foreground, ...). CERO
// cambios de lógica: mismas props, mismo estado, mismo onClick/aria-pressed.
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@atiende/ui";
import { saludoConNombre } from "../../../lib/greeting.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

export function RentasDashboardPage({ orgSlug, properties, propertyId, setPropertyId, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);

  return (
    <div className="flex flex-col gap-4 max-w-[640px]">
      <div>
        <p className="text-sm text-muted-foreground m-0 mb-1">{saludoConNombre(session.fullName, session.email)}</p>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">{org?.nombre ?? orgSlug}</h1>
        {org ? (
          <p className="text-sm text-muted-foreground m-0">
            Rol <strong className="text-foreground font-medium">{org.rol}</strong>
          </p>
        ) : null}
      </div>

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground font-medium">
            Propiedades ({properties.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <ul className="list-none m-0 p-0 flex flex-col gap-2">
            {properties.map((p) => {
              const activa = p.propertyId === propertyId;
              return (
                <li key={p.propertyId}>
                  <Button
                    type="button"
                    variant={activa ? "default" : "outline"}
                    size="sm"
                    onClick={() => setPropertyId(p.propertyId)}
                    aria-pressed={activa}
                    className={activa ? "w-full justify-between rounded-lg" : "w-full justify-between rounded-lg font-normal"}
                  >
                    <span className="truncate">{p.nombre}</span>
                    {activa && (
                      <Badge variant="secondary" className="shrink-0">
                        activa
                      </Badge>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <p className="text-[13px] text-muted-foreground m-0">
        Elige una propiedad arriba (o desde el selector del panel lateral) para que Calendario, Precios, Aprobaciones, Finanzas y Mis tareas operen sobre ella. El calendario de reservas y bloqueos está disponible en "Calendario", y el cotizador con la configuración de pricing en "Precios".
      </p>
    </div>
  );
}
