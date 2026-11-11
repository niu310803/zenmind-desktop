import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import {
  WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH,
  WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH,
  normalizeWebsiteCredentialOrigin,
  type WebsiteCredentialSaveDecision,
  type WebsiteCredentialSaveOffer
} from "../../../../shared/website-credentials";
import type { WebsiteCredentialStore } from "../store";
import { frameIsGone, frameScriptRunner, type CredentialFrame, type LoginFrameRelay } from "../frames";
import {
  LOGIN_OBSERVER_IDLE_MS,
  LOGIN_OBSERVER_NEXT_SCRIPT,
  LOGIN_OBSERVER_FORM_STATE_SCRIPT,
  buildLoginObserverInstallScript,
  type LoginObserverEvent
} from "./page-script";

/** How long a first-step identifier waits for the password page. */
const PENDING_USERNAME_TTL_MS = 120_000;
/**
 * A frame navigating this close to its identifier step counts as handing it over: the step's own
 * navigation can reach Main before the step itself does.
 */
const HANDOVER_GRACE_MS = 3_000;
/**
 * How long a submitted login may take: a slider or picture check over the form, a slow
 * identity provider. While the password field stays on screen the outcome is open.
 */
const OUTCOME_WINDOW_MS = 120_000;
const OUTCOME_FIRST_PROBE_MS = 1_000;
const OUTCOME_PROBE_MS = 1_500;
/** Probes in a row that no frame of the login's site could answer before the outcome counts as unknown. */
const OUTCOME_UNKNOWN_PROBES = 8;
/** A frame that does not answer within this time is treated as unable to answer. */
const FRAME_ANSWER_MS = 1_500;
/** An unanswered save prompt is dropped together with its password. */
const OFFER_TTL_MS = 120_000;
const MAX_OPEN_OFFERS = 4;
/** Frames observed per page, so a page full of ad frames does not cost a script in each without bound. */
const MAX_OBSERVED_FRAMES = 32;

type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
type PendingOffer = WebsiteCredentialSaveOffer & { password: string; expiry: unknown };
type Candidate = {
  origin: string;
  username: string;
  password: string;
  submittedAt: number;
  /** Where the password was typed: its frame, and whether that was an iframe of the page. */
  frameNode: number;
  inIframe: boolean;
  /** The page's main document when the login was submitted. */
  mainDocument: number;
  unknownProbes: number;
  /** The submitted field was emptied or replaced in place: a refusal, or a page clearing it while it moves on. */
  cleared: boolean;
  /** The user clicked or typed in the page again afterwards. */
  touched: boolean;
  /** The user left through the address bar, a reload or history while the login was open. */
  left: boolean;
};
type LoginForm = { state: "pending" | "cleared" | "rejected" | "unknown" } | { state: "gone"; verified: boolean; closed: boolean };

export type LoginCaptureOptions = {
  store: Pick<WebsiteCredentialStore, "isCaptureEnabled" | "classifyCaptured" | "saveCaptured" | "setNeverSave">;
  /** Shows the save prompt in Desktop's trusted UI. Returns false when no window can show it. */
  presentOffer(offer: WebsiteCredentialSaveOffer): boolean;
  withdrawOffer(offerId: string): void;
  /** Reaches iframes. Without it only main frames are observed. */
  relay?: LoginFrameRelay | null;
  now?: () => number;
  timers?: Timers;
};

/**
 * Observes logins in web guests and turns them into save prompts.
 *
 * Every frame of a page is observed, so a login form in an iframe counts like one in the
 * page itself; the password belongs to the origin Main reads from the frame that held it.
 * A login is a short flow within one frame: an identifier step hands its account name only
 * to a password step in the same frame — on its own site, or on another site that frame went
 * on to by itself — and the outcome is judged from what the login's site still shows until
 * it leaves the page.
 *
 * Captured passwords exist only in this controller's memory, bounded in number and
 * time, and are never logged or sent to a renderer.
 */
export function createLoginCapture(options: LoginCaptureOptions) {
  const now = options.now ?? Date.now;
  const timers: Timers = options.timers ?? { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as NodeJS.Timeout) };
  const relay = options.relay ?? null;
  const installScript = buildLoginObserverInstallScript({ maxUsername: WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH, maxPassword: WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH });
  const offers = new Map<string, PendingOffer>();
  const guests = new Map<number, { start(): void; forget(): void; dispose(): void }>();

  function dropOffer(offerId: string, withdraw: boolean) {
    const offer = offers.get(offerId);
    if (!offer) return;
    offers.delete(offerId);
    timers.clear(offer.expiry);
    offer.password = "";
    if (withdraw) options.withdrawOffer(offerId);
  }

  function offer(candidate: { origin: string; username: string; password: string }, verified: boolean) {
    const relation = options.store.classifyCaptured(candidate.origin, candidate.username, candidate.password);
    if (relation !== "new" && relation !== "changed") return;
    // A repeated attempt for the same account replaces its earlier prompt.
    for (const existing of offers.values()) {
      if (existing.origin === candidate.origin && existing.username === candidate.username) dropOffer(existing.offerId, true);
    }
    if (offers.size >= MAX_OPEN_OFFERS) dropOffer(offers.keys().next().value!, true);
    const offerId = randomUUID();
    const summary: WebsiteCredentialSaveOffer = { offerId, origin: candidate.origin, username: candidate.username, kind: relation === "new" ? "save" : "update", verified };
    if (!options.presentOffer(summary)) return;
    offers.set(offerId, { ...summary, password: candidate.password, expiry: timers.set(() => dropOffer(offerId, true), OFFER_TTL_MS) });
  }

  /** Settles with null when the frame does not answer in time. */
  function answerWithin(work: Promise<unknown>): Promise<unknown> {
    return new Promise(resolve => {
      const timer = timers.set(() => resolve(null), FRAME_ANSWER_MS);
      work.then(value => { timers.clear(timer); resolve(value); }, () => { timers.clear(timer); resolve(null); });
    });
  }

  function attach(guest: WebContents) {
    if (guests.has(guest.id) || guest.isDestroyed()) return;
    let disposed = false;
    /** Per frame, the pump of its current document; a superseded document's pump stops. */
    const pumps = new Map<number, number>();
    let pendingUsername: { value: string; origin: string; frameNode: number; at: number } | null = null;
    /** When each frame last navigated itself, and when the user last navigated the page through the browser. */
    const pageNavigatedAt = new Map<number, number>();
    let userNavigatedAt = Number.NEGATIVE_INFINITY;
    let candidate: Candidate | null = null;
    let outcomeTimer: unknown = null;
    let mainDocument = 0;
    // Bumped whenever unsaved candidates must be forgotten; a probe already in flight then discards its result.
    let candidateEpoch = 0;
    const forget = () => {
      candidateEpoch += 1;
      pendingUsername = null;
      candidate = null;
      if (outcomeTimer !== null) timers.clear(outcomeTimer);
      outcomeTimer = null;
    };
    const frames = (): CredentialFrame[] => {
      try {
        return guest.mainFrame.framesInSubtree.filter(frame => !frameIsGone(frame));
      } catch {
        return [];
      }
    };
    const runIn = (frame: CredentialFrame) => frameScriptRunner(guest, frame, relay, FRAME_ANSWER_MS);

    /** What the login's site shows now, in whichever frames of the page still hold it. */
    async function lookForLoginForm(current: Candidate): Promise<LoginForm> {
      const all = frames();
      const site = all.filter(frame => normalizeWebsiteCredentialOrigin(frame.origin) === current.origin);
      if (!site.length) {
        // The site left the page. An iframe that was only removed, the page itself unchanged, may be a dialog the user closed.
        const closed = current.inIframe && current.mainDocument === mainDocument && !all.some(frame => frame.frameTreeNodeId === current.frameNode);
        return { state: "gone", verified: !closed, closed };
      }
      const answers = await Promise.all(site.map(async frame => {
        const run = runIn(frame);
        return { frame, state: run ? await answerWithin(run(LOGIN_OBSERVER_FORM_STATE_SCRIPT)) : null };
      }));
      if (answers.some(answer => answer.state === "submitted")) return { state: "pending" };
      // A new document showing the password form again where the password was typed — the page came back with it,
      // or the login iframe was re-created — means it was refused. Other frames of the site may hold unrelated forms.
      const own = answers.find(answer => answer.frame.frameTreeNodeId === current.frameNode);
      if (own ? own.state === "form" : answers.some(answer => answer.state === "form")) return { state: "rejected" };
      // Emptied in place proves nothing yet: some pages clear the field while they move on.
      if (own?.state === "cleared") return { state: "cleared" };
      if (answers.some(answer => answer.state !== "form" && answer.state !== "none")) return { state: "unknown" };
      return { state: "gone", verified: true, closed: false };
    }

    /**
     * Ends a login that left the page or was closed. Leaving through the browser while it was open
     * drops it. A field emptied in place counts only if the page then moved on by itself: after the
     * user acted on the page again, or closed it, the emptied field most likely meant a refusal.
     */
    function conclude(current: Candidate, verified: boolean, closed: boolean) {
      if (current.left) return;
      if (current.cleared && (current.touched || closed)) return;
      offer(current, verified && !current.cleared);
    }

    /**
     * Chrome's rule of thumb: the login worked once the password form is gone, and failed when
     * the form comes back. While the submitted field still holds what was submitted, it is in progress.
     */
    function judge(delay: number) {
      const epoch = candidateEpoch;
      outcomeTimer = timers.set(async () => {
        outcomeTimer = null;
        const current = candidate;
        if (!current || disposed || guest.isDestroyed() || !options.store.isCaptureEnabled()) return;
        const form = await lookForLoginForm(current);
        if (disposed || epoch !== candidateEpoch) return;
        if (form.state === "gone") {
          candidate = null;
          return conclude(current, form.verified, form.closed);
        }
        if (form.state === "rejected") {
          candidate = null;
          return;
        }
        if (form.state === "cleared") current.cleared = true;
        current.unknownProbes = form.state === "unknown" ? current.unknownProbes + 1 : 0;
        if (current.unknownProbes >= OUTCOME_UNKNOWN_PROBES) {
          candidate = null;
          return conclude(current, false, false);
        }
        // Still on the submitted form after the whole window: abandoned, or refused without saying so.
        if (now() - current.submittedAt + OUTCOME_PROBE_MS > OUTCOME_WINDOW_MS) {
          candidate = null;
          return;
        }
        judge(OUTCOME_PROBE_MS);
      }, delay);
    }

    function handle(frame: CredentialFrame, event: LoginObserverEvent | null) {
      if (!event || typeof event !== "object" || event.type === "idle") return;
      const origin = normalizeWebsiteCredentialOrigin(event.origin);
      // The origin Main reads from the frame decides; an event from a document that already left is dropped.
      if (!origin || origin !== normalizeWebsiteCredentialOrigin(frame.origin)) return;
      if (event.type === "activity") {
        if (candidate) candidate.touched = true;
        return;
      }
      if (typeof event.username !== "string" || event.username.length > WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH) return;
      if (event.type === "username") {
        if (event.username) pendingUsername = { value: event.username, origin, frameNode: frame.frameTreeNodeId, at: now() };
        return;
      }
      if (event.type !== "credential" || typeof event.password !== "string" || !event.password || event.password.length > WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH) return;
      const step = pendingUsername;
      // Only the frame that took the identifier: on its own site, or on another site it went on to by itself —
      // an app handing over to its identity provider. Another frame's identifier belongs to another form.
      const handedOver = step !== null && (pageNavigatedAt.get(step.frameNode) ?? Number.NEGATIVE_INFINITY) >= step.at - HANDOVER_GRACE_MS &&
        userNavigatedAt < step.at;
      const remembered = step && now() - step.at <= PENDING_USERNAME_TTL_MS && step.frameNode === frame.frameTreeNodeId &&
        (step.origin === origin || handedOver) ? step.value : "";
      const username = event.username || remembered;
      forget();
      // Without an account identifier there is nothing to match the password to later.
      if (!username) return;
      candidate = {
        origin, username, password: event.password, submittedAt: now(),
        frameNode: frame.frameTreeNodeId, inIframe: Boolean(frame.parent), mainDocument, unknownProbes: 0,
        cleared: false, touched: false, left: false
      };
      judge(OUTCOME_FIRST_PROBE_MS);
    }

    function observe(frame: CredentialFrame | null | undefined) {
      if (!frame || disposed || guest.isDestroyed() || !options.store.isCaptureEnabled() || frameIsGone(frame)) return;
      // Only authenticated HTTPS documents: the same rule the vault uses for storable origins.
      if (!normalizeWebsiteCredentialOrigin(frame.origin)) return;
      const node = frame.frameTreeNodeId;
      if (!pumps.has(node) && pumps.size >= MAX_OBSERVED_FRAMES) return;
      const run = runIn(frame);
      if (!run) return;
      const mine = (pumps.get(node) ?? 0) + 1;
      pumps.set(node, mine);
      const current = () => !disposed && pumps.get(node) === mine;
      void (async () => {
        try {
          await run(installScript);
          while (current() && !frameIsGone(frame)) {
            const event = await run(LOGIN_OBSERVER_NEXT_SCRIPT, LOGIN_OBSERVER_IDLE_MS + 5_000) as LoginObserverEvent | null;
            if (!current() || event === null) return;
            if (options.store.isCaptureEnabled()) handle(frame, event);
          }
        } catch {
          // The document went away or the frame cannot be reached; its next dom-ready starts a new pump.
        } finally {
          if (pumps.get(node) === mine) pumps.delete(node);
        }
      })();
    }

    // An iframe's every new document is observed from its own dom-ready; the main frame's from the page's.
    const watched = new WeakSet<object>();
    const watch = (frame: CredentialFrame | null | undefined) => {
      const target = frame as (CredentialFrame & { on?(event: "dom-ready", listener: () => void): unknown }) | null | undefined;
      if (!target?.parent || watched.has(target) || typeof target.on !== "function") return;
      watched.add(target);
      target.on("dom-ready", () => observe(target));
    };
    const start = () => { for (const frame of frames()) { watch(frame); observe(frame); } };
    const mainReady = () => observe(guest.mainFrame);
    const frameCreated = (_event: unknown, details: { frame: CredentialFrame | null } | undefined) => watch(details?.frame);
    const navigationStarted = (details: { isMainFrame?: boolean; isSameDocument?: boolean; initiator?: unknown; frame?: { frameTreeNodeId?: number } | null }) => {
      if (!details || details.isSameDocument) return;
      // A page navigates itself (a form, a link, a script); the address bar, a reload, history or Desktop do not.
      const byPage = Boolean(details.initiator);
      if (!byPage && details.isMainFrame) {
        // The user went elsewhere: not part of a login the page started.
        userNavigatedAt = now();
        if (candidate) candidate.left = true;
        return;
      }
      const node = details.frame?.frameTreeNodeId ?? (details.isMainFrame ? guest.mainFrame?.frameTreeNodeId : undefined);
      if (byPage && node !== undefined) pageNavigatedAt.set(node, now());
    };
    const navigated = () => { mainDocument += 1; };
    const destroyed = () => detach(guest.id);
    guest.on("dom-ready", mainReady);
    guest.on("frame-created", frameCreated as never);
    guest.on("did-start-navigation", navigationStarted as never);
    guest.on("did-navigate", navigated);
    guest.once("destroyed", destroyed);
    guests.set(guest.id, {
      start,
      forget,
      dispose() {
        // Closing the page ends the login it was waiting on: the user decides on an outcome nobody saw,
        // unless the page had already emptied the field.
        const unjudged = candidate;
        disposed = true;
        pumps.clear();
        forget();
        guest.off("dom-ready", mainReady);
        guest.off("frame-created", frameCreated as never);
        guest.off("did-start-navigation", navigationStarted as never);
        guest.off("did-navigate", navigated);
        guest.off("destroyed", destroyed);
        if (unjudged && options.store.isCaptureEnabled()) conclude(unjudged, false, true);
      }
    });
    start();
  }

  function detach(webContentsId: number) {
    const entry = guests.get(webContentsId);
    if (!entry) return;
    guests.delete(webContentsId);
    // Prompts already showing stay until answered or expired: a login popup or tab often closes itself after signing in.
    entry.dispose();
  }

  return {
    attach,
    detach,

    /** The user's answer to a save prompt. Unknown or expired offers are ignored. */
    resolveOffer(offerId: unknown, decision: WebsiteCredentialSaveDecision) {
      const pending = typeof offerId === "string" ? offers.get(offerId) : undefined;
      if (!pending) return false;
      const { origin, username, password } = pending;
      try {
        if (decision === "save") options.store.saveCaptured({ origin, username, password });
        else if (decision === "never") options.store.setNeverSave(origin, true);
      } finally {
        dropOffer(pending.offerId, false);
      }
      return true;
    },

    /** Recording was switched on: start observing the pages that are already open. */
    refresh() {
      for (const entry of guests.values()) entry.start();
    },

    /** Lock screen, sleep, or recording switched off: forget everything not yet saved. */
    clearPending() {
      for (const entry of guests.values()) entry.forget();
      for (const offerId of [...offers.keys()]) dropOffer(offerId, true);
    },

    pendingOfferCount: () => offers.size
  };
}

export type LoginCapture = ReturnType<typeof createLoginCapture>;
