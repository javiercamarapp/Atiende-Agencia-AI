# Ajustes del agente de restaurantes (equivalentes de lo que el original hacía con ElevenLabs)

Pantalla **Agente > Ajustes del agente** (owner/admin). Cada control llama a un endpoint real, se guarda con bitácora y declara **dónde aplica hoy**.
Contrato de API: `apps/api/src/routes/verticals/restaurantes/ajustes-agente.ts`. Dominio: `packages/domain-restaurantes/src/ajustes-agente/`.

| Función | Qué es | Dónde aplica hoy |
|---|---|---|
| Modelo del agente de WhatsApp | Lista cerrada (`MODELOS_AGENTE`) con costo estimado por 1,000 mensajes | Desde el siguiente mensaje (el turno manda `preferredModel` al gateway) |
| Temperatura del agente de WhatsApp | 0 a 1, **solo** si el modelo la admite | Desde el siguiente mensaje |
| Temperatura de la voz | Parámetro real de Gemini Live (`generationConfig.temperature`) | Vista previa ahora; llamadas reales con el servicio de llamadas |
| Ritmo y estilo de habla | Gemini no tiene velocidad numérica: se piden por instrucción, anexada **al final** (no cambia reglas ni el trato de usted) | Vista previa ahora; llamadas reales con el servicio de llamadas |
| Modelo de la cascada de voz | Mismo catálogo con costo por minuto | Solo existe en llamadas reales (el escalón 2 de la escalera) |
| Sonido de fondo de restaurante | Murmullo sintetizado, apagado por omisión, volumen 0 a 20 % | La mezcla (`FondoRestaurante`) está probada en aislado; se aplica cuando el worker de telefonía la use |
| Voz y saludo por sucursal | Catálogo de 30 voces con muestra y frase de saludo (config de voz existente) | Ya |
| Conocimiento automático | Documentos generados **al momento** de los datos (ver abajo) | Vista previa de voz ya; llamadas reales con el servicio de llamadas |
| Clonación de voz | **No se construye**: Gemini no clona | Estado honesto "No disponible con el proveedor actual" |

## Modelo elegido sin romper el gateway

`LlmGateway.complete({ preferredModel })` pone el modelo elegido al frente de la escalera **del mismo rol** (`restaurantes:whatsapp_agent`); el resto queda de
respaldo. Los modelos elegibles se registran con `registerAlternatives` (no entran a la escalera por defecto: un fallo no cae a ellos), pasan por la misma política
de proveedores de EE.UU. (`routingForModel`) y comparten circuit breaker con el escalón del mismo id. Un modelo no registrado se ignora. Como el rol no cambia, el
interruptor de plataforma, el tope diario/mensual y el registro de uso siguen siendo los del rol. El reintento tras un fallo real de `crear_pedido` (rol escalado)
no usa el modelo elegido.

**Temperatura**: `aceptaTemperatura` sale de `supported_parameters` de los endpoints permitidos de OpenRouter (leído el 2026-10-04): DeepSeek V4.1 Flash,
Gemini 2.5 Flash-Lite, Gemini 3.8 Flash y Muse Spark 1.3 la aceptan; GPT-6 Luna y Claude Sonnet 5.5 no (con `require_parameters` mandarla deja la ruta sin
endpoints). Para esos dos la pantalla dice que no la admiten y el servidor la rechaza (400) en vez de ignorarla.

**Costo estimado**: precio de lista de `MODEL_PRICES` (agent-core) × un uso típico (6,000 tokens de entrada y 400 de salida por mensaje; 12,000 y 500 por minuto de
cascada). No es una factura: el costo real lo reporta OpenRouter por llamada.

## Base de conocimiento automática (equivalente a los `[Auto]` del original)

`generarConocimientoAuto` arma cuatro documentos desde los datos de la cuenta: **sucursales y horarios**, **menú y precios por sucursal**, **colonia → sucursal más
cercana** (con alerta cuando las dos más cercanas quedan a menos de 1 km de diferencia) y **preguntas frecuentes** (solo las que tienen dato). No hay texto escrito a mano y
**no se guardan copias**: cada lectura sale de los datos vigentes, así que se "re-sincroniza" sola (la huella cambia cuando cambia un dato). El precio que se cobra sigue saliendo
de `cotizar_pedido`.

- **Ventas** y **personal** no se generan: el agente que atiende al cliente no necesita cifras de ventas (el Copiloto las responde con datos en vivo) y el personal es información
  de personas. La pantalla lo dice con su razón.
- Tope de 6,000 caracteres en la instrucción de voz, en orden de prioridad; un documento que no cabe **entero** se omite (nunca a medias) y el agente lo consulta en vivo con sus herramientas.
- WhatsApp **no** recibe los documentos: ya consulta el menú y las sucursales en vivo con herramientas y el prompt de cada mensaje pagaría esos tokens en todos los turnos.

## Despliegue

1. Mergear el código (compatible con la base sin migrar: GET devuelve los valores de siempre con `disponible: false`; PUT responde 503; el agente se comporta igual).
2. Aplicar `packages/domain-restaurantes/migrations/055_ajustes_agente_modelo_voz_fondo.sql` (espejo `supabase/migrations/20240101000330_...`). Después de aplicarla se pueden guardar ajustes.
3. Sin variables nuevas ni crons nuevos. Cambiar el modelo de WhatsApp requiere `OPENROUTER_API_KEY` (sin ella, el gateway real no existe y la elección no tiene efecto).

## Dependencia: servicio de llamadas (PR #418, `apps/voice-worker`)

Para que la voz real use estos ajustes el worker debe: leer `GET /internal/restaurantes/voz/ajustes-llamada?organizationId=` (secreto interno), pasar `temperatura` y
`modeloLlm` en `AperturaLlamada`, anexar el bloque con `instruccionConAjustes`, resolver `PeticionLlmVoz.modeloPreferido` con la misma política de proveedores y mezclar
el fondo con `FondoRestaurante.mezclar`. Esos puntos de entrada ya existen y están probados; conectarlos es del PR del worker.
