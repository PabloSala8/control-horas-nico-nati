# Bitácora de build

Log de solo-agregar. Nunca se borran entradas anteriores — cada sesión
añade la suya al final. Este archivo es lo que Pablo trae de vuelta al chat
estratégico para sincronizar decisiones; no hace falta que ahí se lea cada
commit, solo el resumen de cada sesión.

Formato sugerido por entrada:

```
## [fecha o número de sesión] — [qué se construyó, en una frase]

**Construido:**
-

**Decisiones tomadas:**
-

**Bugs encontrados y cómo se resolvieron:**
-

**Preguntas abiertas / pendiente para la próxima sesión:**
-
```

---

## Sesión 0 — Setup inicial

**Construido:**
- Aún nada. Este archivo y `CLAUDE.md` y `docs/documento-tecnico.md` son el
  punto de partida.

**Decisiones tomadas:**
- Stack: Node.js + TypeScript + Telegraf + PostgreSQL, hosting en Railway.
- Se descartó chat privado individual del bot con cada empleada y con cada
  admin — solo 3 chats: grupo Nena, grupo Maye, grupo Admins.
- No se migra el histórico del Excel anterior — arranque en cero el 1 de
  agosto de 2026.

**Bugs encontrados y cómo se resolvieron:**
- N/A

**Preguntas abiertas / pendiente para la próxima sesión:**
- Definir la regla exacta de desambiguación cuando una corrección de hora
  cae en un turno partido (mañana/tarde).
- Definir qué pasa si una empleada marca "Entré" dos veces sin salida
  intermedia.
