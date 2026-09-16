// Onboarding self-serve del tenant de rentas (Fase 11/hallazgo de auditoría, severidad
// CRÍTICA: "el onboarding self-serve de rentas está bloqueado en producción y ni
// siquiera tiene pantalla"). Un solo submit real: organización + primera propiedad +
// al menos una unidad + admin (+ propietario opcional) — mismo patrón visual que
// Login.tsx/OwnerPortalActivar.tsx (formulario público, sin sesión).
//
// Nota HONESTA post-registro (nunca finge lo que no existe todavía): el admin recién
// creado queda con `created_via='registro_autoservicio'` y `email_verified_at: null`
// (`POST /auth/login` lo bloquea explícito con 403 hasta que se verifique el correo,
// ver `apps/api/src/routes/auth.ts`) — este monorepo TODAVÍA no envía/consume un
// correo real de verificación (gap documentado desde la Fase 11 original, ver
// `packages/domain-rentas/src/onboarding/tipos.ts`). Esta pantalla NUNCA promete "revisa
// tu correo" (sería mentir: no se envía nada) — en vez de eso dice con claridad qué
// pasó y qué falta para poder entrar.
//
// Ronda de portado del sistema de diseño real (@atiende/ui): Card/Input/Label/Button
// y clases de token en vez de los `style={{...}}` hechos a mano. CERO cambios de
// lógica: mismos ids de campo, mismo payload, mismas ramas (formulario / éxito /
// error en role=alert), mismos textos exactos de botón que protegen los tests de
// apps/web/tests/rentas-registro-page.spec.tsx.
import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, CardContent, Input, Label } from "@atiende/ui";
import { OnboardingError, registrarTenant, ZONAS_HORARIAS_FRECUENTES } from "../lib/onboarding-client.ts";
import type { RegistroTenantResultado, RegistroUnidadInput } from "../lib/onboarding-client.ts";

export interface RegistroPageProps {
  readonly apiBaseUrl: string;
}

/** Mismos tokens que el <Input> de @atiende/ui, aplicados al <select> nativo: los
 * selectores de esta pantalla son dropdowns reales de opciones (zona horaria, tipo de
 * organización), no menús de acciones — se quedan nativos y solo se re-estilan. */
const SELECT_CLASES =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const LABEL_CLASES = "flex flex-col gap-1.5 text-[13px] text-foreground";

function nuevaUnidadVacia(): RegistroUnidadInput {
  return { nombre: "" };
}

export function RentasRegistroPage({ apiBaseUrl }: RegistroPageProps) {
  const navigate = useNavigate();

  const [organizacionNombre, setOrganizacionNombre] = useState("");
  const [tipoOrganizacion, setTipoOrganizacion] = useState<"anfitrion" | "empresa_gestora">("anfitrion");
  const [propiedadNombre, setPropiedadNombre] = useState("");
  const [zonaHoraria, setZonaHoraria] = useState("America/Mexico_City");
  const [moneda, setMoneda] = useState("MXN");
  const [unidades, setUnidades] = useState<RegistroUnidadInput[]>([nuevaUnidadVacia()]);
  const [adminNombreCompleto, setAdminNombreCompleto] = useState("");
  const [adminCorreo, setAdminCorreo] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [primerOwnerNombre, setPrimerOwnerNombre] = useState("");
  const [primerOwnerEmail, setPrimerOwnerEmail] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<RegistroTenantResultado | null>(null);

  function actualizarUnidad(indice: number, cambios: Partial<RegistroUnidadInput>) {
    setUnidades((prev) => prev.map((u, i) => (i === indice ? { ...u, ...cambios } : u)));
  }

  function agregarUnidad() {
    setUnidades((prev) => [...prev, nuevaUnidadVacia()]);
  }

  function quitarUnidad(indice: number) {
    setUnidades((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== indice)));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const salida = await registrarTenant(fetch, apiBaseUrl, {
        organizacionNombre,
        tipoOrganizacion,
        propiedadNombre,
        zonaHoraria,
        moneda,
        unidades,
        adminNombreCompleto,
        adminCorreo,
        adminPassword,
        primerOwnerNombre: tipoOrganizacion === "empresa_gestora" ? primerOwnerNombre : undefined,
        primerOwnerEmail: tipoOrganizacion === "empresa_gestora" ? primerOwnerEmail : undefined,
      });
      setResultado(salida);
    } catch (err) {
      setError(err instanceof OnboardingError ? err.message : "Ocurrió un error inesperado. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  if (resultado) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-[min(480px,92vw)]">
          <CardContent className="p-6 flex flex-col gap-3">
            <h1 className="font-display text-xl font-semibold text-foreground m-0">Tu cuenta se creó</h1>
            <p className="m-0 text-sm text-foreground">
              Organización <strong>{organizacionNombre}</strong>, propiedad <strong>{propiedadNombre}</strong> y {resultado.unidadIds.length}{" "}
              {resultado.unidadIds.length === 1 ? "unidad" : "unidades"} quedaron registradas.
            </p>
            <div className="rounded-lg border border-border bg-muted px-3 py-3 text-[13px] text-muted-foreground">
              Este entorno todavía no envía un correo de verificación automático, así que <strong className="text-foreground">{adminCorreo}</strong> no puede iniciar sesión todavía
              (tu cuenta exige correo verificado antes del primer login). Contacta al equipo de Atiende con tu correo de registro para que activen tu
              acceso manualmente mientras esa pieza se conecta.
            </div>
            <Button type="button" onClick={() => navigate("/rentas/login")} className="w-full">
              Ir a iniciar sesión
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <form onSubmit={handleSubmit} noValidate className="w-[min(560px,94vw)] flex flex-col gap-4">
        <div>
          <h1 className="font-display text-[22px] font-semibold text-foreground m-0 mb-1">Crea tu cuenta de rentas</h1>
          <p className="m-0 text-[13px] text-muted-foreground">Organización, primera propiedad, y las unidades que quieres administrar — todo en un solo paso.</p>
        </div>

        <fieldset className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4">
          <legend className="px-1 text-sm font-semibold text-foreground">Tu organización</legend>
          <Label className={LABEL_CLASES} htmlFor="organizacionNombre">
            Nombre de la organización
            <Input id="organizacionNombre" value={organizacionNombre} onChange={(e) => setOrganizacionNombre(e.target.value)} required />
          </Label>
          <Label className={LABEL_CLASES} htmlFor="tipoOrganizacion">
            ¿Cómo describirías tu operación?
            <select
              id="tipoOrganizacion"
              value={tipoOrganizacion}
              onChange={(e) => setTipoOrganizacion(e.target.value as "anfitrion" | "empresa_gestora")}
              className={SELECT_CLASES}
            >
              <option value="anfitrion">Anfitrión — administro mis propias propiedades</option>
              <option value="empresa_gestora">Empresa gestora — administro propiedades de otros dueños</option>
            </select>
          </Label>
          {tipoOrganizacion === "empresa_gestora" && (
            <>
              <Label className={LABEL_CLASES} htmlFor="primerOwnerNombre">
                Nombre del propietario dueño del inmueble (opcional)
                <Input id="primerOwnerNombre" value={primerOwnerNombre} onChange={(e) => setPrimerOwnerNombre(e.target.value)} placeholder="Puedes agregarlo después" />
              </Label>
              {primerOwnerNombre.trim() && (
                <Label className={LABEL_CLASES} htmlFor="primerOwnerEmail">
                  Correo del propietario (opcional)
                  <Input id="primerOwnerEmail" type="email" value={primerOwnerEmail} onChange={(e) => setPrimerOwnerEmail(e.target.value)} />
                </Label>
              )}
            </>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4">
          <legend className="px-1 text-sm font-semibold text-foreground">Tu primera propiedad</legend>
          <Label className={LABEL_CLASES} htmlFor="propiedadNombre">
            Nombre de la propiedad
            <Input id="propiedadNombre" value={propiedadNombre} onChange={(e) => setPropiedadNombre(e.target.value)} required placeholder="Ej. Casa Sol, Edificio Marina" />
          </Label>
          <div className="flex gap-2.5">
            <Label className={`${LABEL_CLASES} flex-1`} htmlFor="zonaHoraria">
              Zona horaria
              <select id="zonaHoraria" value={zonaHoraria} onChange={(e) => setZonaHoraria(e.target.value)} className={SELECT_CLASES}>
                {ZONAS_HORARIAS_FRECUENTES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </Label>
            <Label className={`${LABEL_CLASES} flex-1`} htmlFor="moneda">
              Moneda (ISO 4217)
              <Input id="moneda" value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} />
            </Label>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4">
          <legend className="px-1 text-sm font-semibold text-foreground">Unidades de esta propiedad</legend>
          <p className="m-0 text-xs text-muted-foreground">Cada depa/habitación/casa que rentas por separado necesita su propia unidad. Puedes agregar más después.</p>
          {unidades.map((u, i) => (
            <div key={i} className="flex gap-2 items-end">
              <Label className={`${LABEL_CLASES} flex-1`}>
                {`Unidad ${i + 1}`}
                <Input value={u.nombre} onChange={(e) => actualizarUnidad(i, { nombre: e.target.value })} required placeholder="Ej. Depa 101" />
              </Label>
              <Label className={`${LABEL_CLASES} w-[92px] shrink-0 whitespace-nowrap text-xs`}>
                Noches mín.
                <Input
                  type="number"
                  min={1}
                  value={u.duracionMinimaNoches ?? 1}
                  onChange={(e) => actualizarUnidad(i, { duracionMinimaNoches: Number(e.target.value) || 1 })}
                />
              </Label>
              <Button type="button" variant="outline" size="sm" onClick={() => quitarUnidad(i)} disabled={unidades.length === 1}>
                Quitar
              </Button>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={agregarUnidad} className="self-start">
            + Agregar otra unidad
          </Button>
        </fieldset>

        <fieldset className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4">
          <legend className="px-1 text-sm font-semibold text-foreground">Tu cuenta de administrador</legend>
          <Label className={LABEL_CLASES} htmlFor="adminNombreCompleto">
            Nombre completo
            <Input id="adminNombreCompleto" value={adminNombreCompleto} onChange={(e) => setAdminNombreCompleto(e.target.value)} required />
          </Label>
          <Label className={LABEL_CLASES} htmlFor="adminCorreo">
            Correo
            <Input id="adminCorreo" type="email" autoComplete="email" value={adminCorreo} onChange={(e) => setAdminCorreo(e.target.value)} required />
          </Label>
          <Label className={LABEL_CLASES} htmlFor="adminPassword">
            Contraseña (mínimo 10 caracteres)
            <Input
              id="adminPassword"
              type="password"
              autoComplete="new-password"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              required
              minLength={10}
            />
          </Label>
        </fieldset>

        {error && (
          <p role="alert" className="m-0 text-[13px] text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={submitting} size="lg" className="w-full">
          {submitting ? "Creando cuenta…" : "Crear mi cuenta"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => navigate("/rentas/login")} className="self-center text-muted-foreground font-normal">
          Ya tengo cuenta — ir a iniciar sesión
        </Button>
      </form>
    </main>
  );
}
