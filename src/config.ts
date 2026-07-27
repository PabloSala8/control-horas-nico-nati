/**
 * Carga y valida las variables de entorno esperadas (ver CLAUDE.md).
 * Se importa una sola vez; si falta algo crítico, falla temprano y claro.
 */
import 'dotenv/config';

function requerido(nombre: string): string {
  const v = process.env[nombre];
  if (!v || v.trim() === '') {
    throw new Error(`Falta la variable de entorno ${nombre} (revisa tu .env).`);
  }
  return v.trim();
}

function chatId(nombre: string): number {
  const n = Number(requerido(nombre));
  if (!Number.isFinite(n)) {
    throw new Error(`La variable ${nombre} no es un chat_id numérico válido.`);
  }
  return n;
}

export const config = {
  telegramBotToken: requerido('TELEGRAM_BOT_TOKEN'),
  databaseUrl: requerido('DATABASE_URL'),
  adminChatId: chatId('ADMIN_CHAT_ID'),
  nenaChatId: chatId('NENA_CHAT_ID'),
  mayeChatId: chatId('MAYE_CHAT_ID'),
};
