import { WEBSITE_CREDENTIAL_SCRIPT_WORLD_ID } from "../../../../shared/website-credentials";

/**
 * Login-form observer that runs in an isolated JavaScript world of every frame of a guest
 * page. Page scripts cannot reach that world, so they can neither read what it captures
 * nor forge its events. Main pulls events through `next()`; nothing is pushed out.
 *
 * It only looks at visible login inputs at the moment the user submits them: it keeps
 * no keystroke history and never reads other fields or network traffic. Inputs inside
 * open shadow roots count as part of the page; closed shadow roots cannot be reached.
 */
export const LOGIN_OBSERVER_WORLD_ID = WEBSITE_CREDENTIAL_SCRIPT_WORLD_ID;
/** A pull for the next event answers "idle" after this long, and Main asks again. */
export const LOGIN_OBSERVER_IDLE_MS = 20_000;

/**
 * What a frame shows after a login was submitted:
 * - `submitted`: the submitted field still holds what was submitted (a check over the form, a slow answer);
 * - `cleared`: this document submitted, and its password field was emptied or replaced in place;
 * - `form`: a document that submitted nothing shows a password form — the page came back with it;
 * - `none`: no password field on screen.
 */
export type LoginFormState = "submitted" | "cleared" | "form" | "none";

export type LoginObserverEvent =
  /** The first page of a two-step login: an identifier submitted without a password. */
  | { type: "username"; origin: string; username: string }
  | { type: "credential"; origin: string; username: string; password: string }
  /** The user clicked or typed in the page again after submitting a login. Only real input counts. */
  | { type: "activity"; origin: string }
  /** Nothing happened while Main waited, or a newer pull replaced this one. */
  | { type: "idle" };

function loginObserver(maxUsername: number, maxPassword: number) {
  const scope = globalThis as unknown as { __desktopLoginObserver?: { next(idleMs: number): Promise<unknown>; formState(): string } };
  if (scope.__desktopLoginObserver) return;
  const queue: unknown[] = [];
  let waiter: ((event: unknown) => void) | null = null;
  const emit = (event: unknown) => {
    if (waiter) { const resolve = waiter; waiter = null; resolve(event); }
    else if (queue.length < 8) queue.push(event);
  };

  /** Matches in `root` and in every open shadow root below it. */
  const deepQuery = (root: ParentNode, selector: string): Element[] => {
    const found = Array.from(root.querySelectorAll(selector));
    for (const host of Array.from(root.querySelectorAll("*"))) if (host.shadowRoot) found.push(...deepQuery(host.shadowRoot, selector));
    return found;
  };
  /** The parent element, stepping out of a shadow root to its host. */
  const parentAcross = (element: Element): Element | null => {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const closestAcross = (start: Element | null, selector: string) => {
    for (let element = start; element; element = parentAcross(element)) if (element.matches(selector)) return element;
    return null;
  };
  /** The element, then each shadow host around it, outward. */
  const hostsOf = (element: Element) => {
    const path = [element];
    for (let root = element.getRootNode(); root instanceof ShadowRoot; root = path[path.length - 1].getRootNode()) path.push(root.host);
    return path;
  };
  /** Whether `a` comes first, compared in the innermost tree they share: their own elements in one shadow root, else the hosts around them. */
  const before = (a: Element, b: Element) => {
    const around = hostsOf(b);
    for (const mine of hostsOf(a)) {
      const theirs = around.find(element => element.getRootNode() === mine.getRootNode());
      if (theirs) return mine !== theirs && Boolean(mine.compareDocumentPosition(theirs) & Node.DOCUMENT_POSITION_FOLLOWING);
    }
    return false;
  };

  const shown = (element: Element): boolean => {
    if (!(element instanceof HTMLInputElement)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  const editable = (element: Element): element is HTMLInputElement =>
    element instanceof HTMLInputElement && shown(element) && !element.disabled && (!element.readOnly || element.type === "password");
  // A "show password" control turns the field into type=text. Once seen as a password field it stays one,
  // so revealing it is neither mistaken for the form going away nor read as an account name.
  const knownPasswordFields = new WeakSet<Element>();
  const remember = (root: ParentNode) => { for (const input of deepQuery(root, "input[type=password]")) knownPasswordFields.add(input); };
  const passwordFields = (root: ParentNode) => { remember(root); return deepQuery(root, "input").filter(editable).filter(input => knownPasswordFields.has(input)); };
  // Pages often disable the form while the login request runs; a disabled field is still on screen.
  const shownPasswordFields = () => { remember(document); return deepQuery(document, "input").filter(shown).filter(input => knownPasswordFields.has(input)) as HTMLInputElement[]; };
  /** The field and value of the last login this document submitted, and when. */
  let submitted: { field: HTMLInputElement; value: string; at: number } | null = null;
  let awaitingActivity = false;
  const isText = (input: HTMLInputElement) => ["text", "email", "tel", ""].includes(input.type) && !knownPasswordFields.has(input);
  const identifierFields = (root: ParentNode) => deepQuery(root, "input").filter(editable).filter(isText);
  const looksLikeIdentifier = (input: HTMLInputElement) =>
    /username|email|tel/u.test(input.autocomplete) || input.type === "email"
    || /user|login|account|email|phone|mobile|identifier/iu.test(`${input.name} ${input.id}`);
  const markedAsAccount = (input: HTMLInputElement) => /\b(username|email)\b/u.test(input.autocomplete);

  /**
   * The identifier belonging to a password field: one marked as the account, else the closest
   * text input before it. A shown read-only account counts (the second page of many identity
   * providers), and so does a hidden field marked as the account, which sites add for password managers.
   */
  function usernameFor(password: HTMLInputElement) {
    const root = password.form ?? document;
    const inputs = deepQuery(root, "input").filter((input): input is HTMLInputElement => input instanceof HTMLInputElement && input !== password && Boolean(input.value.trim()));
    const candidates = inputs.filter(input => shown(input) && isText(input));
    const marked = candidates.find(markedAsAccount);
    if (marked) return marked.value.trim();
    const preceding = candidates.filter(input => before(input, password));
    const nearest = preceding[preceding.length - 1] ?? candidates[0];
    if (nearest) return nearest.value.trim();
    const hidden = inputs.find(input => !shown(input) && input.type !== "password" && !knownPasswordFields.has(input) && markedAsAccount(input));
    return hidden?.value.trim() ?? "";
  }

  const clickables = "button, [role=button], [role=link], input[type=submit], input[type=button], input[type=image], a";
  const loginWords = /log\s*-?\s*in|sign\s*-?\s*in|submit|continue|next|\u767b\s*\u5f55|\u767b\s*\u5165|\u63d0\s*\u4ea4|\u786e\s*\u5b9a|\u786e\s*\u8ba4|\u4e0b\s*\u4e00\s*\u6b65|\u7ee7\s*\u7eed/iu;
  const otherWords = /forgot|reset|recover|register|sign\s*-?\s*up|create|show|hide|\u5fd8\u8bb0|\u627e\u56de|\u91cd\u7f6e|\u6ce8\u518c|\u663e\u793a|\u9690\u85cf|\u5207\u6362|\u626b\u7801/iu;
  const labelOf = (element: Element) =>
    (element.getAttribute("aria-label") || element.getAttribute("title") || (element as HTMLInputElement).value || element.textContent || "").replace(/\s+/gu, " ").trim();
  /**
   * What a click submitted, if anything: a form's own submit control, or the nearest clickable —
   * including a styled <div> the site draws as its button — whose label says it logs in.
   */
  function submitterOf(start: Element | null): Element | null {
    const control = closestAcross(start, clickables);
    if (control && (control.matches("input[type=submit], input[type=image]") || (control instanceof HTMLButtonElement && control.type === "submit"))
        && closestAcross(control, "form")) return control;
    let candidate = control;
    for (let element = start, depth = 0; !candidate && element && depth < 5; element = parentAcross(element), depth += 1) {
      if (getComputedStyle(element).cursor === "pointer") candidate = element;
    }
    if (!candidate) return null;
    const label = labelOf(candidate);
    return label.length <= 24 && loginWords.test(label) && !otherWords.test(label) ? candidate : null;
  }

  let lastSignature = "";
  function capture(element: Element | null) {
    const form = closestAcross(element, "form") as HTMLFormElement | null;
    const fields = passwordFields(form ?? document).filter(input => input.value);
    if (!fields.length) {
      const identifier = identifierFields(form ?? document).filter(input => input.value.trim() && looksLikeIdentifier(input));
      if (identifier.length === 1 && !passwordFields(document).length && identifier[0].value.length <= maxUsername) {
        emit({ type: "username", origin: location.origin, username: identifier[0].value.trim() });
      }
      return;
    }
    let chosen = fields[0];
    if (fields.length > 1) {
      // Sign-up, reset and change-password forms: keep only the new password, which is entered twice or marked as new.
      const marked = fields.find(input => input.autocomplete === "new-password");
      const repeated = fields.find((input, index) => fields.some((other, otherIndex) => otherIndex > index && other.value === input.value));
      const next = marked ?? repeated;
      if (!next) return;
      chosen = next;
    }
    const username = usernameFor(chosen);
    if (chosen.value.length > maxPassword || username.length > maxUsername) return;
    // Submit, click and Enter often fire together for one attempt.
    const signature = `${username}\u0000${chosen.value}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    setTimeout(() => { lastSignature = ""; }, 1500);
    submitted = { field: chosen, value: chosen.value, at: performance.now() };
    awaitingActivity = true;
    emit({ type: "credential", origin: location.origin, username, password: chosen.value });
  }

  /** The element the user acted on, inside any open shadow root. */
  const targetOf = (event: Event) => {
    const target = event.composedPath()[0] ?? event.target;
    return target instanceof Element ? target : null;
  };

  remember(document);
  // Fields rendered later are noticed when the user starts typing in them, before any reveal toggle.
  addEventListener("focusin", event => { const target = targetOf(event); if (target instanceof HTMLInputElement && target.type === "password") knownPasswordFields.add(target); }, true);
  // Capture phase: read the values before the page clears the form or navigates.
  addEventListener("submit", event => capture(targetOf(event)), true);
  addEventListener("click", event => {
    const submitter = submitterOf(targetOf(event));
    if (submitter) capture(submitter);
  }, true);
  addEventListener("keydown", event => {
    const target = targetOf(event);
    if (event.key === "Enter" && target instanceof HTMLInputElement) capture(target);
  }, true);
  // The first real click or key after a login (not the one that submitted it) says the user is still on the
  // page and acting — after a refusal, typically. Page scripts cannot produce trusted input.
  const noteActivity = (event: Event) => {
    if (!awaitingActivity || !event.isTrusted || !submitted || performance.now() - submitted.at < 500) return;
    awaitingActivity = false;
    emit({ type: "activity", origin: location.origin });
  };
  addEventListener("pointerdown", noteActivity, true);
  addEventListener("keydown", noteActivity, true);

  scope.__desktopLoginObserver = {
    next(idleMs: number) {
      if (queue.length) return Promise.resolve(queue.shift());
      // A newer pull replaces an older one; the older one ends as idle.
      if (waiter) { const previous = waiter; waiter = null; previous({ type: "idle" }); }
      return new Promise(resolve => {
        const settle = (event: unknown) => { clearTimeout(timer); resolve(event); };
        const timer = setTimeout(() => { if (waiter === settle) { waiter = null; resolve({ type: "idle" }); } }, idleMs);
        waiter = settle;
      });
    },
    formState() {
      const fields = shownPasswordFields();
      if (!fields.length) return "none";
      if (!submitted) return "form";
      return fields.includes(submitted.field) && submitted.field.value === submitted.value ? "submitted" : "cleared";
    }
  };
}

export function buildLoginObserverInstallScript(limits: { maxUsername: number; maxPassword: number }) {
  return `(${loginObserver.toString()})(${limits.maxUsername}, ${limits.maxPassword}); void 0;`;
}
export const LOGIN_OBSERVER_NEXT_SCRIPT = `globalThis.__desktopLoginObserver ? globalThis.__desktopLoginObserver.next(${LOGIN_OBSERVER_IDLE_MS}) : null`;
export const LOGIN_OBSERVER_FORM_STATE_SCRIPT = "globalThis.__desktopLoginObserver ? globalThis.__desktopLoginObserver.formState() : null";
