// Diálogos de alta/edición de la configuración de pricing (Rn-23). Cada uno es un FormDialog con
// FormField; no llama a la API: arma el payload (pesos -> centavos, % -> basis points) y delega
// en `onGuardar`, que el padre ejecuta contra el endpoint real y cuyo error vuelve por `error`.
import { useState } from "react";
import { Checkbox, EstadoError, FormDialog, FormField, Input, NativeSelect } from "@atiende/ui";
import { basisPointsAPorcentaje, CANALES_CON_MARKUP, centavosAPesos, pesosACentavos, porcentajeABasisPoints } from "../../lib/pricing-client.ts";
import type {
  DescuentoDuracionInput,
  DescuentoRegistro,
  MinStayInput,
  MinStayRegistro,
  ReglaCanalInput,
  ReglaCanalRegistro,
  TarifaBaseInput,
  TarifaBaseRegistro,
  TemporadaInput,
  TemporadaRegistro,
} from "../../lib/pricing-client.ts";

export const DIAS_SEMANA = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"] as const;

interface DialogoBase<I> {
  readonly onCerrar: () => void;
  readonly onGuardar: (payload: I) => void;
  readonly guardando: boolean;
  readonly error: string | null;
}

function Dialogo({
  titulo,
  subtitulo,
  textoGuardar,
  base,
  errorLocal,
  onEnviar,
  children,
}: {
  titulo: string;
  subtitulo?: string;
  textoGuardar: string;
  base: DialogoBase<never>;
  errorLocal: string | null;
  onEnviar: () => void;
  children: React.ReactNode;
}) {
  const mensaje = errorLocal ?? base.error;
  return (
    <FormDialog
      open
      onOpenChange={(abierto) => {
        if (!abierto && !base.guardando) base.onCerrar();
      }}
      titulo={titulo}
      subtitulo={subtitulo}
      anchoClase="max-w-lg"
      onGuardar={onEnviar}
      guardando={base.guardando}
      textoBotonGuardar={textoGuardar}
      bloquearCierre={base.guardando}
    >
      <div className="flex flex-col gap-3">
        {mensaje && <EstadoError compacto mensaje={mensaje} />}
        {children}
      </div>
    </FormDialog>
  );
}

function aNumero(texto: string): number {
  return texto.trim() === "" ? Number.NaN : Number(texto);
}

// ---- Tarifa base (se versiona por `vigenteDesde`: cambiarla agrega una fila nueva) ----
export function FormularioTarifaBase({ actual, ...base }: DialogoBase<TarifaBaseInput> & { readonly actual: TarifaBaseRegistro | null }) {
  const [precio, setPrecio] = useState(actual ? centavosAPesos(actual.precioNocheCentavos) : "");
  const [moneda, setMoneda] = useState(actual?.moneda ?? "MXN");
  const [vigenteDesde, setVigenteDesde] = useState("");
  const [errorLocal, setErrorLocal] = useState<string | null>(null);
  function enviar() {
    const p = aNumero(precio);
    if (!Number.isFinite(p) || p < 0) return setErrorLocal("Escribe un precio por noche válido (0 o más).");
    if (!/^[A-Z]{3}$/.test(moneda)) return setErrorLocal("La moneda es un código de 3 letras mayúsculas, p. ej. MXN.");
    setErrorLocal(null);
    base.onGuardar({ precioNocheCentavos: pesosACentavos(p), moneda, ...(vigenteDesde ? { vigenteDesde } : {}) });
  }
  return (
    <Dialogo titulo="Cambiar tarifa base" subtitulo="Se agrega una tarifa nueva; el historial anterior se conserva." textoGuardar="Guardar tarifa" base={base as DialogoBase<never>} errorLocal={errorLocal} onEnviar={enviar}>
      <FormField label="Precio por noche" required>
        <Input type="number" inputMode="decimal" min={0} step="0.01" value={precio} onChange={(e) => setPrecio(e.target.value)} />
      </FormField>
      <FormField label="Moneda" hint="Una unidad no mezcla monedas.">
        <Input value={moneda} maxLength={3} onChange={(e) => setMoneda(e.target.value.toUpperCase())} />
      </FormField>
      <FormField label="Vigente desde" hint="Si lo dejas vacío, rige desde hoy (día de la propiedad).">
        <Input type="date" value={vigenteDesde} onChange={(e) => setVigenteDesde(e.target.value)} />
      </FormField>
    </Dialogo>
  );
}

// ---- Temporada ----
export function FormularioTemporada({ registro, monedaSugerida, ...base }: DialogoBase<TemporadaInput> & { readonly registro: TemporadaRegistro | null; readonly monedaSugerida: string }) {
  const [nombre, setNombre] = useState(registro?.nombre ?? "");
  const [inicio, setInicio] = useState(registro?.rango.inicio ?? "");
  const [fin, setFin] = useState(registro?.rango.fin ?? "");
  const [precio, setPrecio] = useState(registro ? centavosAPesos(registro.precioNocheCentavos) : "");
  const [moneda, setMoneda] = useState(registro?.moneda ?? monedaSugerida);
  const [errorLocal, setErrorLocal] = useState<string | null>(null);
  function enviar() {
    const p = aNumero(precio);
    if (nombre.trim() === "") return setErrorLocal("El nombre es obligatorio.");
    if (!inicio || !fin) return setErrorLocal("Indica inicio y fin de la temporada.");
    if (fin <= inicio) return setErrorLocal("El fin debe ser posterior al inicio.");
    if (!Number.isFinite(p) || p < 0) return setErrorLocal("Escribe un precio por noche válido (0 o más).");
    setErrorLocal(null);
    base.onGuardar({ nombre: nombre.trim(), rango: { inicio, fin }, precioNocheCentavos: pesosACentavos(p), moneda });
  }
  return (
    <Dialogo titulo={registro ? "Editar temporada" : "Nueva temporada"} textoGuardar={registro ? "Guardar cambios" : "Crear temporada"} base={base as DialogoBase<never>} errorLocal={errorLocal} onEnviar={enviar}>
      <FormField label="Nombre" required>
        <Input value={nombre} maxLength={200} onChange={(e) => setNombre(e.target.value)} />
      </FormField>
      <div className="flex flex-wrap gap-3">
        <FormField label="Inicio" required className="flex-1 min-w-36">
          <Input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} />
        </FormField>
        <FormField label="Fin (exclusivo)" required className="flex-1 min-w-36" hint="El día de salida no se cobra.">
          <Input type="date" value={fin} onChange={(e) => setFin(e.target.value)} />
        </FormField>
      </div>
      <div className="flex flex-wrap gap-3">
        <FormField label="Precio por noche" required className="flex-1 min-w-36">
          <Input type="number" inputMode="decimal" min={0} step="0.01" value={precio} onChange={(e) => setPrecio(e.target.value)} />
        </FormField>
        <FormField label="Moneda" className="w-28">
          <Input value={moneda} maxLength={3} onChange={(e) => setMoneda(e.target.value.toUpperCase())} />
        </FormField>
      </div>
    </Dialogo>
  );
}

// ---- Descuento por duración ----
export function FormularioDescuento({ registro, ...base }: DialogoBase<DescuentoDuracionInput> & { readonly registro: DescuentoRegistro | null }) {
  const [noches, setNoches] = useState(registro ? String(registro.nochesMinimas) : "");
  const [porcentaje, setPorcentaje] = useState(registro ? basisPointsAPorcentaje(registro.porcentajeDescuentoBasisPoints) : "");
  const [fuente, setFuente] = useState(registro?.fuente ?? "");
  const [errorLocal, setErrorLocal] = useState<string | null>(null);
  function enviar() {
    const n = aNumero(noches);
    const pc = aNumero(porcentaje);
    if (!Number.isInteger(n) || n < 1) return setErrorLocal("Las noches mínimas deben ser un entero de 1 o más.");
    if (!Number.isFinite(pc) || pc < 0 || pc > 100) return setErrorLocal("El descuento es un porcentaje entre 0 y 100.");
    if (fuente.trim() === "") return setErrorLocal("Indica la fuente o política del descuento.");
    setErrorLocal(null);
    base.onGuardar({ nochesMinimas: n, porcentajeDescuentoBasisPoints: porcentajeABasisPoints(pc), fuente: fuente.trim() });
  }
  return (
    <Dialogo titulo={registro ? "Editar descuento" : "Nuevo descuento por duración"} textoGuardar={registro ? "Guardar cambios" : "Crear descuento"} base={base as DialogoBase<never>} errorLocal={errorLocal} onEnviar={enviar}>
      <div className="flex flex-wrap gap-3">
        <FormField label="Noches mínimas" required className="flex-1 min-w-36">
          <Input type="number" min={1} step={1} value={noches} onChange={(e) => setNoches(e.target.value)} />
        </FormField>
        <FormField label="Descuento (%)" required className="flex-1 min-w-36">
          <Input type="number" inputMode="decimal" min={0} max={100} step="0.01" value={porcentaje} onChange={(e) => setPorcentaje(e.target.value)} />
        </FormField>
      </div>
      <FormField label="Fuente" required hint="Política o contrato que respalda el porcentaje.">
        <Input value={fuente} maxLength={300} onChange={(e) => setFuente(e.target.value)} />
      </FormField>
    </Dialogo>
  );
}

// ---- Estancia mínima ----
export function FormularioMinStay({ registro, ...base }: DialogoBase<MinStayInput> & { readonly registro: MinStayRegistro | null }) {
  const [inicio, setInicio] = useState(registro?.rango.inicio ?? "");
  const [fin, setFin] = useState(registro?.rango.fin ?? "");
  const [dia, setDia] = useState(registro?.diaSemanaCheckIn === null || registro === null ? "" : String(registro.diaSemanaCheckIn));
  const [noches, setNoches] = useState(registro ? String(registro.nochesMinimas) : "");
  const [errorLocal, setErrorLocal] = useState<string | null>(null);
  function enviar() {
    const n = aNumero(noches);
    if (!inicio || !fin) return setErrorLocal("Indica inicio y fin del rango.");
    if (fin <= inicio) return setErrorLocal("El fin debe ser posterior al inicio.");
    if (!Number.isInteger(n) || n < 1) return setErrorLocal("Las noches mínimas deben ser un entero de 1 o más.");
    setErrorLocal(null);
    base.onGuardar({ rango: { inicio, fin }, diaSemanaCheckIn: dia === "" ? null : Number(dia), nochesMinimas: n });
  }
  return (
    <Dialogo titulo={registro ? "Editar estancia mínima" : "Nueva estancia mínima"} textoGuardar={registro ? "Guardar cambios" : "Crear regla"} base={base as DialogoBase<never>} errorLocal={errorLocal} onEnviar={enviar}>
      <div className="flex flex-wrap gap-3">
        <FormField label="Inicio" required className="flex-1 min-w-36">
          <Input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} />
        </FormField>
        <FormField label="Fin (exclusivo)" required className="flex-1 min-w-36">
          <Input type="date" value={fin} onChange={(e) => setFin(e.target.value)} />
        </FormField>
      </div>
      <div className="flex flex-wrap gap-3">
        <FormField label="Día de check-in" className="flex-1 min-w-36">
          <NativeSelect value={dia} onChange={(e) => setDia(e.target.value)}>
            <option value="">Todos los días</option>
            {DIAS_SEMANA.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField label="Noches mínimas" required className="flex-1 min-w-36">
          <Input type="number" min={1} step={1} value={noches} onChange={(e) => setNoches(e.target.value)} />
        </FormField>
      </div>
    </Dialogo>
  );
}

// ---- Regla de canal ----
export function FormularioReglaCanal({ registro, ...base }: DialogoBase<ReglaCanalInput> & { readonly registro: ReglaCanalRegistro | null }) {
  const [canal, setCanal] = useState(registro?.canalCodigo ?? CANALES_CON_MARKUP[0]!.codigo);
  const [markup, setMarkup] = useState(registro ? basisPointsAPorcentaje(registro.markupBasisPoints) : "");
  const [activo, setActivo] = useState(registro?.activo ?? false);
  const [errorLocal, setErrorLocal] = useState<string | null>(null);
  function enviar() {
    const m = aNumero(markup);
    if (!Number.isFinite(m) || m < 0 || m > 100) return setErrorLocal("El markup es un porcentaje entre 0 y 100.");
    setErrorLocal(null);
    base.onGuardar({ canalCodigo: canal, markupBasisPoints: porcentajeABasisPoints(m), activo });
  }
  return (
    <Dialogo titulo={registro ? "Editar regla de canal" : "Nueva regla de canal"} textoGuardar={registro ? "Guardar cambios" : "Crear regla"} base={base as DialogoBase<never>} errorLocal={errorLocal} onEnviar={enviar}>
      <FormField label="Canal" hint={registro ? "El canal no se cambia: crea otra regla si lo necesitas." : undefined}>
        <NativeSelect value={canal} disabled={registro !== null} onChange={(e) => setCanal(e.target.value)}>
          {CANALES_CON_MARKUP.map((c) => (
            <option key={c.codigo} value={c.codigo}>
              {c.nombre}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField label="Markup (%)" required hint="Se suma al precio publicado en ese canal para compensar su comisión.">
        <Input type="number" inputMode="decimal" min={0} max={100} step="0.01" value={markup} onChange={(e) => setMarkup(e.target.value)} />
      </FormField>
      <Checkbox checked={activo} onChange={(e) => setActivo(e.target.checked)} label="Activa (si no, el markup no se aplica en la cotización)" />
    </Dialogo>
  );
}
