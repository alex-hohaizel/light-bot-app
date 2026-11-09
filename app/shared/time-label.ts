/** Ukrainian display label for a nonnegative whole-minute duration. */
export function formatMinutesDuration(minutes: number): string {
  if (!Number.isSafeInteger(minutes) || minutes < 0) return 'не вказано';
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder} хв`;
  return remainder === 0 ? `${hours} год` : `${hours} год ${remainder} хв`;
}
