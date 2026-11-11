import type { WebContents } from "electron";

export async function waitForWebappGuestsClosed(
  guests: readonly WebContents[],
  timeoutMs = 5_000
): Promise<boolean> {
  const closed = await Promise.all([...new Set(guests)].map((guest) => {
    if (guest.isDestroyed()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const finish = (destroyed: boolean) => {
        clearTimeout(timer);
        guest.removeListener("destroyed", onDestroyed);
        resolve(destroyed);
      };
      const onDestroyed = () => finish(true);
      const timer = setTimeout(() => finish(guest.isDestroyed()), timeoutMs);
      guest.once("destroyed", onDestroyed);
      if (guest.isDestroyed()) finish(true);
    });
  }));
  return closed.every(Boolean);
}
