// Dez avaliacoes: a primeira entrega e mais nove retries. Aproximadamente 4 min.
export const REFERENCE_MAX_ATTEMPTS = 10;

export function nextReferenceAttempt(now: Date, attempts: number): Date {
  const delayMs = Math.min(1000 * 2 ** (attempts - 1), 60_000);
  return new Date(now.getTime() + delayMs);
}
