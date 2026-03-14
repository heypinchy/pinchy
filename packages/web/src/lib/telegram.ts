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
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
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
