import type { WebContents } from "electron";
import { normalizeWebsiteCredentialOrigin } from "../../../../shared/website-credentials";
import type { WebsiteCredentialStore } from "../store";
import { childFrames, frameIsGone, frameScriptRunner, type CredentialFrame, type CredentialPage, type LoginFrameRelay } from "../frames";
import { fillLoginForm, type LoginFillResult, type LoginFillTarget } from "./executor";
import { FRAME_OWNERS_SHOWN_SCRIPT, LOGIN_FORM_PRESENT_SCRIPT } from "./page-script";

export type AgentCredentialAccount = { accountId: string; username: string; isDefault: boolean };

/** Where a page asks for a password. Every origin here is read by Main from the page, never taken from a caller. */
export type AgentLoginLocation = {
  /** The site the login form belongs to; saved accounts are matched to it. */
  origin: string;
  /** The iframe that holds the form; null when it is the page itself. */
  frame: CredentialFrame | null;
  /** The page's own origin when the form is an iframe of another site, shown to the user before filling. */
  embeddedIn?: string;
};

/** How long a frame may take to say whether it shows a login form. */
const LOCATE_PROBE_MS = 1_500;
/** An iframe that does not answer a fill script in this time is treated like a page that stopped answering. */
const FRAME_SCRIPT_MS = 1_500;

type AgentPage = CredentialPage & Pick<WebContents, "getURL">;
/** A frame with its place in the tree, as Electron's WebFrameMain gives it. */
type FrameNode = CredentialFrame & { readonly parent: FrameNode | null; readonly frames?: readonly FrameNode[] };

/**
 * What an agent may do with saved passwords: see the masked accounts of the page it is
 * authorized on, and ask Desktop to fill one. Passwords never leave this module.
 */
export function createAgentCredentialAccess(
  store: Pick<WebsiteCredentialStore, "listForOrigin" | "resolveForOrigin" | "markUsed">,
  relay: LoginFrameRelay | null = null
) {
  /** The origin Main sees for the page's top frame; never taken from the caller. */
  const pageOrigin = (contents: Pick<WebContents, "getURL" | "isDestroyed">) =>
    contents.isDestroyed() ? null : normalizeWebsiteCredentialOrigin(contents.getURL());

  const within = (work: Promise<unknown>, ms: number) => new Promise<unknown>(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
  const showsLoginForm = async (contents: AgentPage, frame: CredentialFrame | null) => {
    const run = frameScriptRunner(contents, frame, relay, LOCATE_PROBE_MS);
    return Boolean(run) && await within(run!(LOGIN_FORM_PRESENT_SCRIPT), LOCATE_PROBE_MS) === true;
  };
  /**
   * Whether every iframe from the page down to `frame` is shown by the frame that holds it: a page can
   * make an iframe invisible, e.g. one renewing a sign-in in the background, and the iframe cannot tell.
   * Each holder lists its iframes in Chromium's child order, the same order Main sees them in.
   */
  const reachable = async (contents: AgentPage, frame: CredentialFrame, asked: Map<string, Promise<unknown>>) => {
    for (let child = frame as FrameNode; child.parent; child = child.parent) {
      const holder = child.parent;
      const siblings = holder.frames ?? [];
      const index = siblings.findIndex(item => item.frameTreeNodeId === child.frameTreeNodeId);
      if (index < 0) return false;
      if (!asked.has(holder.frameToken)) {
        const run = frameScriptRunner(contents, holder, relay, LOCATE_PROBE_MS);
        asked.set(holder.frameToken, run ? within(run(FRAME_OWNERS_SHOWN_SCRIPT), LOCATE_PROBE_MS) : Promise.resolve(null));
      }
      const shown = await asked.get(holder.frameToken);
      // An answer that does not line up with the frames Main sees cannot tell them apart.
      if (!Array.isArray(shown) || shown.length !== siblings.length || shown[index] !== true) return false;
    }
    return true;
  };

  return {
    pageOrigin,

    /**
     * Finds the login form: the page itself when it shows one, else the HTTPS iframe that does —
     * an identity provider embedded in the page. Iframes the page does not show do not count.
     * Several sites' forms at once stay with the page. Null for pages that are not HTTPS.
     */
    async locateLogin(contents: AgentPage): Promise<AgentLoginLocation | null> {
      const origin = pageOrigin(contents);
      if (!origin) return null;
      const page: AgentLoginLocation = { origin, frame: null };
      const iframes = relay ? childFrames(contents).filter(frame => !frameIsGone(frame) && normalizeWebsiteCredentialOrigin(frame.origin)) : [];
      if (!iframes.length || await showsLoginForm(contents, null)) return page;
      const asked = new Map<string, Promise<unknown>>();
      const found = (await Promise.all(iframes.map(async frame =>
        await showsLoginForm(contents, frame) && await reachable(contents, frame, asked) ? frame : null)))
        .filter((frame): frame is CredentialFrame => frame !== null);
      const sites = new Set(found.map(frame => normalizeWebsiteCredentialOrigin(frame.origin)));
      if (sites.size !== 1) return page;
      const frame = found[0];
      const frameOrigin = normalizeWebsiteCredentialOrigin(frame.origin)!;
      return frameOrigin === origin ? { origin, frame } : { origin: frameOrigin, frame, embeddedIn: origin };
    },

    /** Accounts the user allows agents to use on `origin`, the fill default first. */
    list(origin: string): AgentCredentialAccount[] {
      return store.listForOrigin(origin, { agentOnly: true }).map((item, index) => ({
        accountId: item.id,
        username: item.maskedUsername,
        isDefault: index === 0
      }));
    },

    async fill(
      target: Pick<LoginFillTarget, "holdAutomation"> & { contents: AgentPage; frame?: CredentialFrame | null },
      request: {
        origin: string;
        /** As located: the page's origin when the form is an iframe of another site. */
        embeddedIn?: string;
        accountId: string;
        submit: boolean;
        /** Re-checks page authorization and cancellation; runs after any queueing, right before the write. */
        authorize?: () => Promise<void>;
        sleep?: (ms: number) => Promise<void>;
      }
    ): Promise<LoginFillResult> {
      const { contents } = target;
      const frame = target.frame ?? null;
      const run = frameScriptRunner(contents, frame, relay, FRAME_SCRIPT_MS);
      if (!run) return { status: "page_changed" };
      const topOrigin = request.embeddedIn ?? request.origin;
      let usedId = "";
      const result = await fillLoginForm({
        run,
        isGone: () => contents.isDestroyed() || (frame !== null && frameIsGone(frame)),
        holdAutomation: target.holdAutomation
      }, {
        submit: request.submit,
        // Both the page and the frame holding the form must still be the sites the user approved.
        isPageCurrent: () => pageOrigin(contents) === topOrigin &&
          (frame === null || (!frameIsGone(frame) && normalizeWebsiteCredentialOrigin(frame.origin) === request.origin)),
        // The account is read only now, so turning off agent use while the request waited still stops it.
        async prepare() {
          await request.authorize?.();
          const secret = store.resolveForOrigin(request.origin, { agentOnly: true, id: request.accountId });
          if (!secret) return null;
          usedId = secret.id;
          return { username: secret.username, password: secret.password };
        },
        ...(request.sleep ? { sleep: request.sleep } : {})
      });
      if (usedId && (result.status === "filled" || result.status === "submitted")) {
        try { store.markUsed(usedId); } catch { /* Bookkeeping only; the fill already happened. */ }
      }
      return result;
    }
  };
}

export type AgentCredentialAccess = ReturnType<typeof createAgentCredentialAccess>;
