# Banco de pruebas de voz (proveedor-agnóstico)

Esqueleto de la fase T01-T04 del diseño del banco. **No llama a ningún proveedor, no lee llaves y no gasta saldo.**

- Base (T01): rama `feat/voz-medicion-real-limpio` (PR #696), commit `af90fa87c`. Trae `scripts/voz-medicion-real/guardas.ts` y sus specs; el banco las reutiliza (loopback, BD local, Meta simulado, `parseCorte`/`excedeTope`/`sumarCosto` con NaN = corte).
- `tipos.ts`, `registro.ts`, `correr-llamada.ts` (T02): contrato `AdaptadorBanco` sobre el puerto `AbrirSesionLlamada` de voice-core (que NO se modifica), registro por id y corredor M0. Único adaptador: `adaptadores/falso.ts` (doble determinista).
- `compuerta-pedidos.ts`, `traza-herramientas.ts` (T03): la compuerta `confirmacionAntesDeCrear` como decorador de `ejecutarTool` con modos `on | off | servidor`. Reutiliza la función de producción `ejecutarHerramientas` (no hay copia de la regla); producción queda intacta. La traza cuenta los intentos de crear sin confirmar y los que llegaron a ejecutarse.
- `cliente-simulado.ts`, `corpus.ts` (T04): cliente M0 en modo `texto` o `stt-final` (ruido de `ruido-stt.ts`, pareado por semilla) y esquema/validador de escenarios. El corpus sintético privado se lee de la variable `PM_CORPUS_SIM` (ruta absoluta FUERA del repo) y nunca se copia aquí; `ejemplos/` trae 3 escenarios inventados.
- `topes.ts`, `aislamiento.ts`: topes por llamada y por corrida (máximo por omisión 25 USD) y aislamiento reutilizando #696.

CLI: `npx vite-node scripts/voz-banco/banco.ts listar | validar-corpus | ejemplo [on|off|servidor]`.
Pruebas: `packages/domain-restaurantes/tests/voz-banco-*.spec.ts`.

## Reglas que el banco ya cumple (revision del PR #697)

- **La traza usa la compuerta.** `TrazaHerramientas(regla, compuerta)` toma el veredicto de `CompuertaPedidos.veredictoDe(llamada)`, que se evalua sobre una copia del estado ANTES de ejecutar y en los tres modos (`on`, `off`, `servidor`). Un `crear` cuenta como «sin confirmar» si la compuerta lo habria bloqueado (afirmacion pura, total y huella oidos, huella vigente, generacion) o si no hubo `confirmar` con exito. Sin veredicto con compuerta conectada falla cerrado (cuenta como indebido).
- **Generacion (barge-in).** Cada herramienta captura la generacion al llegar; si el cliente habla o interrumpe antes de que le toque ejecutarse devuelve `interrumpido_por_el_cliente` (modo `on`) y nunca se evalua contra el estado del turno nuevo.
- **Diferencial contra produccion.** `voz-banco-diferencial.spec.ts` corre 17 guiones (rechazo, relectura, barge-in sobre la lectura y a media generacion, huella nueva, «si» ambiguo, total viejo, doble «si», flujo real cotizar+confirmar en T1 y crear tras el «si» de T2) contra la `CascadaV2Sesion` real (STT/TTS/LLM falsos) y contra el decorador, y compara cada decision.
- **Costos fallan cerrado.** Un turno sin ningun reporte de costo (`h.costo`) corta; tambien corta si `adaptador.costoMicroUsd()` declara mas gasto del reportado. Un costo tardio (aun NaN) tras `cerrarLlamada()` se pliega al acumulado. El constructor de `TopeGasto` respeta el maximo (25) y `iniciarLlamada()` aborta si ya hay una en curso.
- **Aislamiento obligatorio.** `correrLlamada` exige `aislamiento: { stack, env }` (y llama `exigirAislamiento`) con cualquier adaptador distinto de `falso`, antes de abrir la sesion.
- **Corpus.** El validador rechaza PII (telefono MX con o sin separadores/+52/521, correo, URL con credenciales o llaves, tarjeta) en `turnos`, `titulo`, `fuente`, `debe`, `noDebe`; los mensajes dicen categoria y campo, nunca el texto. Un `id` invalido sale como `(id invalido)`; un JSON ilegible da un mensaje fijo. El corpus privado completo se valida con `banco.ts validar-corpus` (sin `skip` en las pruebas).
- **Esquema §5.** `ResultadoLlamada` ya trae `latenciaPrimerAudioMs`, `pedidoEsperado` y `pedidoFinalCorrectoEnBd` (en `null` = sin medir).

## Lo que NO esta hecho todavia

- Libro de gasto por proveedor/dia con reserva previa, `VOZ_TOPE_<PROVEEDOR>_USD` y tope global entre procesos. `TopeGasto` es **por proceso y de una llamada a la vez** (no admite concurrencia: un `TopeGasto` por llamada y un libro compartido cuando haya paralelismo).
- Lista de salida de red (`lista-egreso.ts`), `costoMaxMicroUsd` del controlador y reanudacion tras el codigo de salida 3.
- Pruebas de dos procesos concurrentes, de llaves en logs y de «host no permitido».
- T02: no se extrajo `correrLlamada` de `ejecutar.ts` de #696 (es un corredor nuevo) ni existe el adaptador `cascada-texto`; `ResultadoLlamada` es un subconjunto del §5 sin los checks de BD.
- T03: faltan `limpiarEspera()` y `VOZ_ENVIAR_TURNO`. El hueco del header `x-atiende-call-turn` en el worker de produccion se corrige aparte (#698).
- El costo exigido «por turno» es conservador: un adaptador real que reporte el uso despues de `agenteTermino` cortaria; habra que ajustar cuando existan adaptadores reales.
- La PII dictada en palabras (digitos deletreados) y los nombres propios no se detectan: siguen siendo revision humana del corpus.
