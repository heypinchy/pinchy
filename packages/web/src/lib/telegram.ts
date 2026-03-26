interface TelegramValidationSuccess {
  valid: true;
  botId: number;
  botUsername: string;
}

interface TelegramValidationFailure {
  valid: false;
  error: string;
}

export type TelegramValidationResult = TelegramValidationSuccess | TelegramValidationFailure;

export async function validateTelegramBotToken(token: string): Promise<TelegramValidationResult> {
  const apiUrl = process.env.TELEGRAM_API_URL || "https://api.telegram.org";
  try {
    const response = await fetch(`${apiUrl}/bot${token}/getMe`);
    const data = await response.json();

    if (!data.ok) {
      return { valid: false, error: data.description || "Invalid token" };
    }

    return {
      valid: true,
      botId: data.result.id,
      botUsername: data.result.username,
    };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
