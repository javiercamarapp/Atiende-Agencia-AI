# voz-muestras-ambiente

Genera los WAV con los que una persona escucha el ambiente de restaurante y el tecleo (el desarrollo no puede oírlos). Usa el mismo `MezcladorSalida` que el worker de la llamada.

```
npx vite-node scripts/voz-muestras-ambiente/generar.ts -- [--out <carpeta>] [--segundos 18] [--semilla 1] [--sin-voz]
```

- Por omisión escribe fuera del repo, en `~/atiende-loop/pm/audio-ambiente/` (los WAV **no se commitean**), junto con un `README.md` que explica cada archivo, los parámetros y las medidas objetivas.
- Por preset (`cocina-taqueria`, `sala-tranquila`, `calle-ocupada`): ambiente solo, ambiente + tecleo, ambiente + tecleo sobre una voz de ejemplo, y esa mezcla como la oye el cliente por teléfono (8 kHz, 300-3400 Hz, mu-law). Más cuatro archivos de comparación de volumen del ambiente.
- La voz de ejemplo es `say -v Paulina` (macOS, español de México): sin cuentas ni llaves, pero NO es la voz de Gemini y suena a sintetizador. Sin `say` se usa una voz sintética de prueba.
- Las pruebas automáticas de lo que se puede medir sin oír (nivel, pico, sin recorte, relación voz/ambiente, sin bucle, sincronía del tecleo) están en `packages/voice-core/tests/muestras-ambiente.spec.ts`.
