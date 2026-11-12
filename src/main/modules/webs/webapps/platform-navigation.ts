import type { Session, WebContents } from "electron";

type Navigation = { action: string; origin: string };
const sessions = new WeakMap<Session, Map<number, Navigation>>();

/** Chromium gives browser-initiated POST navigations Origin:null, overriding
 * loadURL's extraHeaders. Only the exact owner-authorized navigation may use the
 * Platform API origin. Dedicated app sessions keep this hook out of other guests.
 */
export async function postPlatformTicket(guest: WebContents, action: string, origin: string, ticket: string) {
  let pending = sessions.get(guest.session);
  if (!pending) {
    pending = new Map();
    sessions.set(guest.session, pending);
    const navigations = pending;
    guest.session.webRequest.onBeforeSendHeaders({ urls: ["http://127.0.0.1/*"] }, (details, callback) => {
      const guestId = details.webContentsId;
      const navigation = guestId === undefined ? undefined : navigations.get(guestId);
      if (navigation && guestId !== undefined && details.method === "POST" && details.url === navigation.action) {
        for (const key of Object.keys(details.requestHeaders)) if (key.toLowerCase() === "origin") delete details.requestHeaders[key];
        details.requestHeaders.Origin = navigation.origin;
        navigations.delete(guestId);
      }
      callback({ requestHeaders: details.requestHeaders });
    });
  }
  const navigation = { action, origin };
  pending.set(guest.id, navigation);
  try {
    await guest.loadURL(action, {
      extraHeaders: "Content-Type: application/x-www-form-urlencoded\r\n",
      postData: [{ type: "rawData", bytes: Buffer.from(new URLSearchParams({ ticket }).toString()) }]
    });
  } finally {
    if (pending.get(guest.id) === navigation) pending.delete(guest.id);
  }
}

export type PlatformPageTraffic = { lastRequestAt: number; activeRequests: Map<number, number> };
const trafficSessions = new WeakMap<Session, { origin: string; traffic: PlatformPageTraffic; guests: WeakSet<WebContents> }>();
/** Business requests hit the app origin, bypassing the Platform API's activity
 * counter. Track them in the private Electron session as an additional idle gate.
 */
export function observePlatformPageTraffic(guest: WebContents, appOrigin: string): PlatformPageTraffic {
  let binding = trafficSessions.get(guest.session);
  if (!binding || binding.origin !== appOrigin) {
    binding = { guests: new WeakSet(), origin: appOrigin, traffic: { lastRequestAt: Date.now(), activeRequests: new Map() } };
    trafficSessions.set(guest.session, binding);
    const { traffic, origin } = binding;
    guest.session.webRequest.onBeforeRequest({ urls: ["http://127.0.0.1/*", "ws://127.0.0.1/*"] }, (details, callback) => {
      const url = new URL(details.url);
      const requestOrigin = url.protocol === "ws:" ? `http://${url.host}` : url.origin;
      if (requestOrigin === origin) {
        traffic.lastRequestAt = Date.now();
        traffic.activeRequests.set(details.id, details.webContentsId ?? -1);
      }
      callback({});
    });
    const finish = (details: { id: number; statusCode?: number }) => {
      // An upgraded stream stays active until its guest is destroyed. Electron
      // has no socket-close event here; keeping it alive is the conservative gate.
      if (details.statusCode === 101) return;
      if (traffic.activeRequests.delete(details.id)) traffic.lastRequestAt = Date.now();
    };
    guest.session.webRequest.onCompleted(finish);
    guest.session.webRequest.onErrorOccurred(finish);
  }
  const traffic = binding.traffic;
  if (!binding.guests.has(guest)) {
    binding.guests.add(guest);
    const ownerId = guest.id;
    guest.once("destroyed", () => {
      for (const [requestId, guestId] of traffic.activeRequests) if (guestId === ownerId) traffic.activeRequests.delete(requestId);
      traffic.lastRequestAt = Date.now();
    });
  }
  return traffic;
}
