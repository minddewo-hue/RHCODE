export async function retryGeneratedImageDownload<T>(
  download: () => Promise<T>,
  delays: readonly number[] = [0, 250, 750, 1_500],
  wait: (milliseconds: number) => Promise<void> = waitForDelay,
): Promise<T> {
  let lastError: unknown = new Error("Generated image download failed.");
  for (const delay of delays) {
    if (delay > 0) await wait(delay);
    try {
      return await download();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function waitForDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
