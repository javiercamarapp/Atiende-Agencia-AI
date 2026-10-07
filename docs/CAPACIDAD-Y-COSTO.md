# Capacidad y costo en hora pico (R-36)

Prueba: `apps/api/tests/carga-hora-pico.spec.ts` (corre en el gate normal con carga chica; corrida grande abajo).
Helpers puros: `scripts/load-test-horario-pico/metricas.ts`. Presupuesto de bundle del front (R-37): `scripts/verify-bundle-budget/`.

```
CARGA_REPORTE=1 CARGA_CLIENTES=500 CARGA_MENSAJES_META=200 npx vitest run apps/api/tests/carga-hora-pico.spec.ts --maxWorkers=2
```

## Que mide y que NO mide

Mide la capa de aplicacion (Hono, reglas del dominio, limites de tasa, firma de Meta) por `app.request` con repositorios EN MEMORIA,
sin ningun envio real. **No mide**: Postgres/Supabase (latencia de red, pool, bloqueos), Vercel (arranque en frio, concurrencia de
funciones), la API de Meta ni el LLM. Como todo corre en un solo hilo, las latencias de abajo incluyen la cola del propio proceso: sirven
para detectar regresiones y errores de logica bajo concurrencia, no son una promesa de latencia en produccion.

## Resultados medidos (4-oct-2026, Node 26, Mac de desarrollo)

| Escenario (500 clientes con IP distinta) | ok | 5xx | p50 | p95 | max |
|---|---|---|---|---|---|
| Menu | 500/500 | 0 | 25 ms | 27 ms | 37 ms |
| Cotizar | 500/500 | 0 | 44 ms | 48 ms | 49 ms |
| Confirmar | 500/500 | 0 | 18 ms | 21 ms | 21 ms |
| Crear pedido | 500/500 | 0 | 66 ms | 69 ms | 69 ms |
| Lote Meta, 1 POST con 200 mensajes (turno instantaneo) | 1/1 | 0 | 9 ms | | |

Memoria del proceso (RSS) al final: ~336 MiB. 500 tokens de rastreo distintos y total de cada pedido = $90 calculado por el servidor.

## Hallazgos reales (comportamiento vigente, caracterizado por tests)

1. **Una IP compartida se queda sin pedidos a partir del 11o en un minuto.** El tope de `POST .../orders` es 10/min por IP + restaurante
   (`storefront.ts`). Wifi de una plaza o CGNAT movil comparten IP: el 11o cliente recibe 429 (medido: 10 pedidos 200, 2 pedidos 429, 0 5xx).
   No se cambio: subir el tope es una decision de seguridad/producto (ver Huecos).
2. **Un POST de Meta procesa sus mensajes en serie dentro de una sola transaccion.** El tiempo del POST crece con
   mensajes x latencia del turno (el test lo fija: 20 mensajes x 15 ms >= 270 ms). La funcion de Vercel tiene `maxDuration: 30` s
   (`vercel.json`); con turnos de LLM de varios segundos, un lote grande puede agotar el presupuesto y Meta reintenta (el reclamo por
   `messageId` evita doble respuesta porque el outbox se revierte junto con la transaccion, pero el lote se vuelve a recorrer:
   los turnos de LLM ya ejecutados se repiten y **se cobran dos veces**).
3. **El limite de tasa del webhook es 120 POST/min por IP + numero** (`whatsapp.ts`). Meta agrupa mensajes por POST, asi que un solo numero
   rara vez lo alcanza, pero no hay medicion contra trafico real de Meta.
4. **Cada peticion del storefront hace 1 o 2 escrituras de limite de tasa en la base** (`consumeRateLimit`, bucket por IP y por sesion) antes de
   su trabajo real. Un pedido completo (cotizar + confirmar + crear) son 6 escrituras de limite + las del pedido, y el rastreo suma 1 por consulta.
5. Una sola IP insistente (150 GET en una ventana) recibe exactamente 120 respuestas 200 y 30 respuestas 429, ninguna 5xx.

## Modelo de capacidad (formulas; los valores marcados "supuesto" NO estan medidos)

- Peticiones a base por pedido completo del storefront ~ 6 (limites) + n_pedido (supuesto: lo que haga la transaccion de crear; no medido contra Postgres).
- Conexiones: `poolMax` por defecto 10 por instancia (`managed-postgres-engine.ts`). Conexiones totales = instancias concurrentes x 10; debe
  quedar bajo el limite del pooler de Supabase de TU plan (**verificar en el panel de Supabase; no consta en el repo**).
- Pedidos/hora sostenibles = (conexiones utiles) / (tiempo de base por pedido en segundos) x 3600. Falta medir el tiempo de base por pedido
  contra Postgres real (ver Huecos).
- Costo de LLM por mensaje de WhatsApp = (tokens de entrada x precio de entrada + tokens de salida x precio de salida) / 1e6. Los precios por
  modelo estan en `docs/LLM-GATEWAY.md` (p. ej. DeepSeek flash en EE.UU. 0.14-0.60 / 0.42-2.40 USD por 1M); los tokens por turno son un
  supuesto a medir con `core` usage (`record_usage_cost_event`). Mensajes por lote x costo por mensaje = costo de un lote pico.
- Costo de plataforma: ver la tabla de `docs/DEPLOY.md` ("Resumen de costo por plataforma"): Vercel Hobby no permite uso comercial; vender a
  Los Taquitos de PM exige plan de pago de Vercel y, segun trafico, de Supabase. Los precios vigentes no se copian aqui: consultar los planes.

## Huecos conocidos

- Sin medicion contra Postgres real ni Vercel: requiere un entorno de staging con credenciales (no se toco produccion).
- Decidir el tope por IP del pedido (10/min) para redes compartidas (por ejemplo, subirlo o llavear tambien por telefono): decision de Javier.
- Decidir si el lote de Meta debe particionarse o el turno de LLM moverse fuera del POST (cola) si se esperan lotes grandes.
