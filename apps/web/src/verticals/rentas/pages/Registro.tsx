// Onboarding self-serve del tenant de rentas (Fase 11/hallazgo de auditoría, severidad
// CRÍTICA: "el onboarding self-serve de rentas está bloqueado en producción y ni
// siquiera tiene pantalla"). Un solo submit real: organización + primera propiedad +
// al menos una unidad + admin (+ propietario opcional) — mismo patrón visual que
// Login.tsx/OwnerPortalActivar.tsx (formulario público, sin sesión, estilos inline).
//
// Nota HONESTA post-registro (nunca finge lo que no existe todavía): el admin recién
// creado queda con `created_via='registro_autoservicio'` y `email_verified_at: null`
// (`POST /auth/login` lo bloquea explícito con 403 hasta que se verifique el correo,
// ver `apps/api/src/routes/auth.ts`) — este monorepo TODAVÍA no envía/consume un
// correo real de verificación (gap documentado desde la Fase 11 original, ver
// `packages/domain-rentas/src/onboarding/tipos.ts`). Esta pantalla NUNCA promete "revisa
// tu correo" (sería mentir: no se envía nada) — en vez de eso dice con claridad qué
// pasó y qué falta para poder entrar.
import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { OnboardingError, registrarTenant, ZONAS_HORARIAS_FRECUENTES } from "../lib/onboarding-client.ts";
import type { RegistroTenantResultado, RegistroUnidadInput } from "../lib/onboarding-client.ts";

export interface RegistroPageProps {
  readonly apiBaseUrl: string;
}

const inputStyle = { display: "block", width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" as const };
const labelStyle = { fontSize: 13, display: "block" as const };
const sectionStyle = { display: "flex", flexDirection: "column" as const, gap: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 };

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
      <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", padding: 24 }}>
        <div style={{ width: "min(480px, 92vw)", display: "flex", flexDirection: "column", gap: 12 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Tu cuenta se creó</h1>
          <p style={{ margin: 0, fontSize: 14, color: "#374151" }}>
            Organización <strong>{organizacionNombre}</strong>, propiedad <strong>{propiedadNombre}</strong> y {resultado.unidadIds.length}{" "}
            {resultado.unidadIds.length === 1 ? "unidad" : "unidades"} quedaron registradas.
          </p>
          <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: 12, fontSize: 13, color: "#92400e" }}>
            Este entorno todavía no envía un correo de verificación automático, así que <strong>{adminCorreo}</strong> no puede iniciar sesión todavía
            (tu cuenta exige correo verificado antes del primer login). Contacta al equipo de Atiende con tu correo de registro para que activen tu
            acceso manualmente mientras esa pieza se conecta.
          </div>
          <button type="button" onClick={() => navigate("/rentas/login")} style={{ padding: 10, fontWeight: 600 }}>
            Ir a iniciar sesión
          </button>
        </div>
      </main>
    );
  }

  return (
    <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", padding: "40px 16px" }}>
      <form onSubmit={handleSubmit} style={{ width: "min(560px, 94vw)", display: "flex", flexDirection: "column", gap: 16 }} noValidate>
        <div>
          <h1 style={{ fontSize: 22, marginBottom: 4 }}>Crea tu cuenta de rentas</h1>
          <p style={{ margin: 0, fontSize: 13, color: "#6b7280" }}>Organización, primera propiedad, y las unidades que quieres administrar — todo en un solo paso.</p>
        </div>

        <fieldset style={sectionStyle}>
          <legend style={{ fontSize: 14, fontWeight: 600, padding: "0 4px" }}>Tu organización</legend>
          <label style={labelStyle} htmlFor="organizacionNombre">
            Nombre de la organización
            <input id="organizacionNombre" value={organizacionNombre} onChange={(e) => setOrganizacionNombre(e.target.value)} required style={inputStyle} />
          </label>
          <label style={labelStyle} htmlFor="tipoOrganizacion">
            ¿Cómo describirías tu operación?
            <select id="tipoOrganizacion" value={tipoOrganizacion} onChange={(e) => setTipoOrganizacion(e.target.value as "anfitrion" | "empresa_gestora")} style={inputStyle}>
              <option value="anfitrion">Anfitrión — administro mis propias propiedades</option>
              <option value="empresa_gestora">Empresa gestora — administro propiedades de otros dueños</option>
            </select>
          </label>
          {tipoOrganizacion === "empresa_gestora" && (
            <>
              <label style={labelStyle} htmlFor="primerOwnerNombre">
                Nombre del propietario dueño del inmueble (opcional)
                <input id="primerOwnerNombre" value={primerOwnerNombre} onChange={(e) => setPrimerOwnerNombre(e.target.value)} style={inputStyle} placeholder="Puedes agregarlo después" />
              </label>
              {primerOwnerNombre.trim() && (
                <label style={labelStyle} htmlFor="primerOwnerEmail">
                  Correo del propietario (opcional)
                  <input id="primerOwnerEmail" type="email" value={primerOwnerEmail} onChange={(e) => setPrimerOwnerEmail(e.target.value)} style={inputStyle} />
                </label>
              )}
            </>
          )}
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={{ fontSize: 14, fontWeight: 600, padding: "0 4px" }}>Tu primera propiedad</legend>
          <label style={labelStyle} htmlFor="propiedadNombre">
            Nombre de la propiedad
            <input id="propiedadNombre" value={propiedadNombre} onChange={(e) => setPropiedadNombre(e.target.value)} required style={inputStyle} placeholder="Ej. Casa Sol, Edificio Marina" />
          </label>
          <div style={{ display: "flex", gap: 10 }}>
            <label style={{ ...labelStyle, flex: 1 }} htmlFor="zonaHoraria">
              Zona horaria
              <select id="zonaHoraria" value={zonaHoraria} onChange={(e) => setZonaHoraria(e.target.value)} style={inputStyle}>
                {ZONAS_HORARIAS_FRECUENTES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ ...labelStyle, flex: 1 }} htmlFor="moneda">
              Moneda (ISO 4217)
              <input id="moneda" value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} style={inputStyle} />
            </label>
          </div>
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={{ fontSize: 14, fontWeight: 600, padding: "0 4px" }}>Unidades de esta propiedad</legend>
          <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>Cada depa/habitación/casa que rentas por separado necesita su propia unidad. Puedes agregar más después.</p>
          {unidades.map((u, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <label style={{ ...labelStyle, flex: 1 }}>
                {`Unidad ${i + 1}`}
                <input value={u.nombre} onChange={(e) => actualizarUnidad(i, { nombre: e.target.value })} required style={inputStyle} placeholder="Ej. Depa 101" />
              </label>
              <label style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                Noches mín.
                <input
                  type="number"
                  min={1}
                  value={u.duracionMinimaNoches ?? 1}
                  onChange={(e) => actualizarUnidad(i, { duracionMinimaNoches: Number(e.target.value) || 1 })}
                  style={{ ...inputStyle, width: 70 }}
                />
              </label>
              <button type="button" onClick={() => quitarUnidad(i)} disabled={unidades.length === 1} style={{ padding: "8px 10px", cursor: unidades.length === 1 ? "not-allowed" : "pointer" }}>
                Quitar
              </button>
            </div>
          ))}
          <button type="button" onClick={agregarUnidad} style={{ alignSelf: "flex-start", padding: "6px 12px", fontSize: 13 }}>
            + Agregar otra unidad
          </button>
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={{ fontSize: 14, fontWeight: 600, padding: "0 4px" }}>Tu cuenta de administrador</legend>
          <label style={labelStyle} htmlFor="adminNombreCompleto">
            Nombre completo
            <input id="adminNombreCompleto" value={adminNombreCompleto} onChange={(e) => setAdminNombreCompleto(e.target.value)} required style={inputStyle} />
          </label>
          <label style={labelStyle} htmlFor="adminCorreo">
            Correo
            <input id="adminCorreo" type="email" autoComplete="email" value={adminCorreo} onChange={(e) => setAdminCorreo(e.target.value)} required style={inputStyle} />
          </label>
          <label style={labelStyle} htmlFor="adminPassword">
            Contraseña (mínimo 10 caracteres)
            <input
              id="adminPassword"
              type="password"
              autoComplete="new-password"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              required
              minLength={10}
              style={inputStyle}
            />
          </label>
        </fieldset>

        {error && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting} style={{ padding: 12, fontWeight: 600, fontSize: 15 }}>
          {submitting ? "Creando cuenta…" : "Crear mi cuenta"}
        </button>
        <button type="button" onClick={() => navigate("/rentas/login")} style={{ padding: 8, background: "transparent", border: "none", color: "#6b7280", cursor: "pointer" }}>
          Ya tengo cuenta — ir a iniciar sesión
        </button>
      </form>
    </main>
  );
}
