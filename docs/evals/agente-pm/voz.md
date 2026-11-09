# Evals de voz del agente de PM

Corte: 9-nov-2026. Índice general y privacidad: [`README.md`](README.md). Activación y estado de infraestructura: [`docs/VOZ-ACTIVACION.md`](../../VOZ-ACTIVACION.md).

**Ninguna medición de voz es una llamada telefónica real.** La mejor aproximación es el E2E sintético: worker de voz REAL conectado a LiveKit Cloud, API real local
con Postgres efímero, cliente simulado (LLM con voz sintética) que entra a la sala como participante; **sin PSTN, sin Twilio y sin desvío**. Cero llamadas reales.

## Lo que se midió y con qué

| Fecha | Commit (PR) | Stack de voz | Arnés | Condición | Aprobadas | Wilson 95 % | Respuesta con contenido p50/p95 | USD/min · USD/llamada (worker) | Tipo |
|---|---|---|---|---|---|---|---|---|---|
| 6-nov | `1ef14971c` (#719) | ElevenLabs Scribe v2 RT + v4 Turbo; dos niveles (Luna + Flash-Lite) | audio en proceso, sin LiveKit | limpio, 12 escenarios | 4/11 | 15-65 % | primer audio 4.2/7.9 s | 0.043 · 0.078 | sintético en proceso |
| 6-nov | `a3c7623a6`→`d192c1eae` (#719) | ídem + Krisp BVC | worker real + LiveKit Cloud | limpio | 3/7 | — | primer audio 5.1/7.6 s | 0.045 · 0.148 | E2E sintético |
| 6-nov | `d192c1eae` (#719) | ídem | ídem | restaurante 10 dB | 1/6 | 3-56 % | 5.1/7.4 s | 0.045 · 0.155 | E2E sintético |
| 7-nov | `6ca743d13` (#752, r2) | ídem | ídem | limpio / restaurante / cocina-calle | 3/12 · 0/12 · 4/8 | 9-53 · 0-24 · 22-78 % | primer audio p50 4.0-4.4 s | 0.042-0.045 · 0.105-0.14 | E2E sintético |
| 7-nov | `734e024ab` (#813, r3 ×5) | ídem, **Krisp BVC encendido en el arnés** | ídem, `scripts/voz-medicion-real-audio` | limpio | **24/30 = 80 %** | 63-90 % | 7.8/13.5 s | 0.0444 · 0.124 | E2E sintético |
| 7-nov | `734e024ab` | ídem | ídem | restaurante 10 dB | 11/30 = 37 % | 22-54 % | 8.2/15.0 s | 0.0443 · 0.115 | E2E sintético |
| 7-nov | `734e024ab` | ídem | ídem | cocina/calle | 19/30 = 63 % | 46-78 % | 8.4/13.9 s | 0.0446 · 0.142 | E2E sintético |
| 8-nov | `74aee986e` (#813 + `4d06c6f6d`, revertido) | **sin Krisp** | ídem | restaurante 10 dB ×5 | 17/29 = 59 % (1 excepción de LiveKit) | 41-74 % | 10.3/16.5 s | 0.047 | E2E sintético |
| 8-nov | **`c7ec4f03b`** (#813, cabeza r3) | **sin Krisp, como producción** | ídem | limpio ×2 | **9/12 = 75 %** | 47-91 % | 6.8/15.1 s | 0.0433 · 0.110 | E2E sintético |
| 8-nov | **`c7ec4f03b`** | ídem | ídem | restaurante 10 dB ×2 | **10/12 = 83 %** | 55-95 % | 9.8/16.6 s | 0.0447 · 0.137 | E2E sintético |
| 8-nov | `c222fa625` / `bf04972b2` (#813, r4) | + precarga de lecturas | ídem | limpio: humo ×1 · rep 1 de ×5 | 5/6 · 2/6 | — | 7.6 s p50 (humo) | ≈0.043 · 0.098 | **detenida** por orden de Javier |

**Resultado vigente: 75 % limpio / 83 % restaurante, n=12 por condición, en `c7ec4f03b` (#813, sin fusionar).** Cocina/calle no se midió sin Krisp. La cabeza final de
#813 (`7a590666c`) **no tiene E2E**. Nada de esto está en `main`: main tiene #719 (stack ElevenLabs); #752 y #813 están abiertos y apilados.

Costo total del E2E sintético de voz (6-8 nov): ~200 llamadas, ~22 USD (costo por componente que estima el worker + OpenRouter + ElevenLabs). Ronda r3 ×5: 257 min,
11.42 USD del worker, 34,226 créditos de ElevenLabs (~133/min), OpenRouter del agente 0.40 USD reales (0.0045/llamada).

## Lecturas que importan

- **Krisp BVC telefónico (`VOZ_RUIDO=krisp-telefonia`) se come la voz del cliente con plática de fondo a 10 dB**: el VAD del worker no la oye, sale «¿sigue ahí?» y cuelga
  (13 de 30 llamadas en restaurante). Sin Krisp, en la misma cabeza: 0 cuelgues por silencio. Producción ya tiene `VOZ_RUIDO=ninguno` por omisión; era el arnés el que lo forzaba.
  **No encender `krisp-telefonia` en PM** sin repetir la prueba.
- **Latencia**: la meta (respuesta con contenido p50 ≤ 4 s, p95 ≤ 8 s) **no se alcanzó**: hoy 7-10 s p50. Con Luna a ~2.5 s por vuelta y 2-3 vueltas de herramientas,
  la palanca pendiente es responder sin otra vuelta del modelo (resumen de `cotizar_pedido` con texto del servidor) y mandar las vueltas de solo lectura al modelo rápido.
- Fallas restantes en `c7ec4f03b` (5 de 24): todas del modelo o de la herramienta (Coca de más, escala tras confirmar, bucle de confirmaciones, promo de aguas de cortesía
  cobrada; esta última arreglada en `5dc16494d` sin medir).
- Costo por minuto medido ~0.044 USD contra 0.047 proyectado (−6 %); minutos por llamada 2.8 contra 2.3 proyectados (+22 %) por los turnos del cliente simulado.

## Arnés y comandos

- Código: `scripts/voz-medicion-real-audio/` + `corrida/` (en la rama de #813). Runner: `corrida/matriz.sh`; resumen: `corrida/resumir.py`.
- Condiciones: 1 = línea limpia; 4 = restaurante con plática a 10 dB SNR; 5 = cocina/calle. Escenarios: VZ01, VZ02, VZ04, VZ05, P08, P14.
- Cliente simulado y juez: Claude Haiku 5.5 + checks deterministas contra la base (pedido, total, renglones). El juez se endureció en r3 para no confundir órdenes con piezas.
- Comando (con OK de gasto, desde el worktree de #813):
  ```
  SHA_ESPERADO=$(git rev-parse --short HEAD) ETQ=r4 REPS="1 2 3 4 5" CONDS="1 4 5" bash scripts/voz-medicion-real-audio/corrida/matriz.sh
  python3 scripts/voz-medicion-real-audio/corrida/resumir.py .voz-qa/results r4-c1 r4-c4 r4-c5 --fallas
  ```
  Tope de gasto: `corrida/con-presupuesto.sh` detiene la matriz si el saldo de OpenRouter baja de 30.6 USD o ElevenLabs de 62k créditos; `CARGA_MAX=10` por omisión
  (la carga de la Mac contamina la latencia). La matriz se detiene (`ALTO_SHA`) si el worktree tiene cambios o cambia la cabeza.
- **Sin gastar**: las pruebas unitarias de la cascada y la máquina de la llamada (`npx vitest run packages/voice-core/tests --maxWorkers=2`; en main incluye
  `cascada-v2/compuerta-confirmacion`, `elevenlabs`, `respaldo-y-plazo` con dobles; #813 agrega `stt-nivel` y `silencio-agente-pensando`) y el simulador de voz por texto con proveedor falso
  (`npm run evals:hoteles:voz:falso -w @atiende/domain-hoteles`). El arnés por texto con modelo real (`scripts/voz-medicion-real/`, `VOZ_CORTE_USD`, 1.5 por omisión) sí gasta.

## Resultados crudos

`resultados/2026-11-07-voz-r3-734e024ab/`, `2026-11-08-voz-r3b-74aee986e/`, `2026-11-08-voz-r3c-c7ec4f03b/`, `2026-11-08-voz-r4-PARCIAL/` (incluye las corridas
preliminares `r3pre*`, que no cuentan), y `resultados/voz-llamadas.csv` (una fila por llamada: veredicto, juez, causa, duración, USD del worker, créditos de ElevenLabs,
Krisp, SNR, latencias p50). Se copiaron sin transcripción, eventos, compuerta ni ruta de grabación; las grabaciones `.wav` (~1 GB, con fallas en
`.voz-qa/grabaciones/fallas/`) se quedaron en `~/atiende-loop/work/wt-voz-r3/.voz-qa/` y en `wt-voz-r2`. Las corridas del 6-nov (#719) y la r2 del 7-nov no se copiaron
(sus cifras están en esta tabla, tomadas de `COSTOS-MEDIDOS.md` del loop).
