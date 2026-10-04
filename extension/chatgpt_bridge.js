// Tab agent injected into a chatgpt.com tab. It finds the composer box, pastes a
// research prompt (web search ON), clicks Send, waits for the reply to finish,
// then returns the last assistant answer to the background worker.
// Mirrors the working flow from the Chart Screener Chrome project.
( () => {
  if (window.__gptBridgeActive) return;
  window.__gptBridgeActive = true;
  window.__gptAborted = false;
  console.log("ChatGPT bridge loaded");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ChatGPT throws a Cloudflare-style security block ("Our systems have detected
  // unusual activity…") when it suspects automation. Detect it so the extension
  // can stop cleanly with a clear message instead of grinding every row into a
  // useless "no valid JSON" failure. Only counts when the composer is also gone,
  // so legit pages (or the occasional normal "try again later" toast) don't trip.
  const BLOCK_SNIPPETS = [
    "unusual activity",
    "please try again later",
    "verify you are human",
    "not a robot",
    "security check",
    "cf-chl",
    "cf-challenge",
  ];
  function detectBlocked() {
    let bodyText = "";
    try { bodyText = String(document.body && document.body.innerText || "").toLowerCase(); } catch (e) {}
    if (!bodyText) return false;
    const composerGone = !findComposer();
    return composerGone && BLOCK_SNIPPETS.some((s) => bodyText.includes(s));
  }

  function findComposer() {
    const selectors = [
      "textarea#prompt-textarea",
      "textarea[data-id=\"root\"]",
      "div#prompt-textarea[contenteditable=\"true\"]",
      "div[contenteditable=\"true\"][data-id=\"root\"]",
      "textarea[placeholder*=\"essage\" i]",
      "div[contenteditable=\"true\"]",
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) return el;
    }
    const edits = Array.from(
      document.querySelectorAll("div[contenteditable=\"true\"]")
    ).filter((e) => e.offsetParent !== null);
    if (edits.length) return edits[edits.length - 1];
    const areas = Array.from(document.querySelectorAll("textarea")).filter(
      (e) => e.offsetParent !== null
    );
    return areas.length ? areas[areas.length - 1] : null;
  }

  function setComposer(composer, text) {
    composer.focus();
    if (composer.tagName === "TEXTAREA") {
      const proto = Object.getPrototypeOf(composer);
      const setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(composer, text);
      else composer.value = text;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      while (composer.firstChild) composer.removeChild(composer.firstChild);
      const div = document.createElement("div");
      div.textContent = text;
      composer.appendChild(div);
      composer.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
      );
    }
    return true;
  }

  function clickSendButton() {
    const selectors = [
      "button[data-testid=\"send-button\"]",
      "button[aria-label=\"Send\"]",
      "button[aria-label=\"Send message\"]",
      "form button[type=\"submit\"]",
    ];
    for (const s of selectors) {
      const b = document.querySelector(s);
      if (b && b.offsetParent !== null) {
        b.click();
        return true;
      }
    }
    return false;
  }

  async function toggleWebSearch() {
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const b of buttons) {
      const label = (b.getAttribute("aria-label") || "").toLowerCase();
      const testid = (b.getAttribute("data-testid") || "").toLowerCase();
      const text = (b.textContent || "").toLowerCase();
      const state = (b.getAttribute("data-state") || "").toLowerCase();
      const pressed = (b.getAttribute("aria-pressed") || "").toLowerCase();
      const isSearchToggle =
        /search the web|search web/i.test(label) ||
        testid.includes("search") ||
        /search the web/.test(text);
      if (isSearchToggle) {
        if (state === "checked" || pressed === "true") return true;
        b.click();
        return true;
      }
    }
    return false;
  }

  function extractLastAnswer() {
    // Source of truth: the LAST assistant message node. Each ChatGPT version
    // keeps one node per message with data-message-author-role="assistant" —
    // returning that single node (never the whole <main>) is what prevents a
    // stale/previous-row reply from leaking into this row's write.
    const roleNodes = Array.from(
      document.querySelectorAll('[data-message-author-role="assistant"]')
    );
    if (roleNodes.length) {
      const last = roleNodes[roleNodes.length - 1];
      const md = last.querySelector(".markdown") || last;
      const t = md && md.innerText ? md.innerText.trim() : "";
      if (t) return t;
    }
    // Fallback selectors (only if the role attribute is absent from this layout).
    const roleSels = [
      "main [data-message-author-role=\"assistant\"] .markdown",
      ".conversation-container .markdown",
    ];
    for (const s of roleSels) {
      const found = document.querySelectorAll(s);
      if (found.length) {
        const last = found[found.length - 1];
        const t = last && last.innerText ? last.innerText.trim() : "";
        if (t) return t;
      }
    }
    const main = document.querySelector("main");
    if (main) {
      const t = main.innerText ? main.innerText.trim() : "";
      if (t) return t;
    }
    return "";
  }

  async function waitForComposer(timeoutMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const c = findComposer();
      if (c) return c;
      await sleep(200);
    }
    return null;
  }

  // Modern ChatGPT hides the stop button via CSS but LEAVES it in the DOM, so
  // plain querySelector always finds it and the done-check never fires. Only
  // count a button that is actually visible on screen (offsetParent + rects).
  function visibleStopButton() {
    const els = document.querySelectorAll(
      "button[data-testid=\"stop-button\"], button[aria-label*=\"Stop generating\" i]"
    );
    for (const el of els) {
      if (el.offsetParent !== null || (el.getClientRects && el.getClientRects().length)) return el;
    }
    return null;
  }

  // When generation finishes ChatGPT swaps the stop button back to the send
  // button, so a visible send button is a strong "answer is done" signal.
  const SEND_BTN_SEL = [
    "button[data-testid=\"send-button\"]",
    "button[aria-label=\"Send\"]",
    "button[aria-label=\"Send message\"]",
    "form button[type=\"submit\"]",
  ];
  function sendVisible() {
    for (const s of SEND_BTN_SEL) {
      const b = document.querySelector(s);
      if (b && b.offsetParent !== null) return true;
    }
    return false;
  }

  // ChatGPT appends each new answer to the end of <main>. Given the text we
  // captured BEFORE sending (baseline), slice off everything before it so only
  // THIS row's fresh reply is returned — never stale JSON from earlier rows.
  function extractTail(text, base) {
    const t = String(text || "");
    const b = String(base || "");
    if (b && t.startsWith(b)) {
      const tail = t.slice(b.length).trim();
      if (tail) return tail;
    }
    return t.trim();
  }

  // True when the text contains at least one balanced { ... } object. ChatGPT is
  // told to output ONE JSON object, so as soon as a closing brace lands the reply
  // is effectively complete — this stops premature "done" during mid-stream quiet
  // gaps that used to capture a truncated/stale answer.
  function hasBalancedJson(text) {
    const s = String(text || "");
    let start = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "{") { start = i; break; }
    }
    if (start === -1) return false;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (inStr) { if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return true;
      }
    }
    return false;
  }

  async function waitForCompletion(baselineText) {
    const deadline = Date.now() + 240000;
    let lastText = "";
    let stableSince = 0;
    let everSeenFresh = false;

    while (Date.now() < deadline) {
      if (window.__gptAborted) return "";
      if (detectBlocked()) return "__BLOCKED__";
      const stopBtn = visibleStopButton();
      const txt = extractLastAnswer();
      const fresh = !!txt && txt !== baselineText;
      if (fresh && !everSeenFresh) {
        everSeenFresh = true;
        stableSince = Date.now();
        lastText = txt;
      } else if (fresh && txt !== lastText) {
        lastText = txt;
        stableSince = Date.now();
      }
      // Done = generation finished (no VISIBLE stop button, or the send button is
      // back) AND the answer is fresh, is a COMPLETE balanced JSON object, and has
      // been stable for 2.5s. Requiring balanced JSON stops "done" from firing on
      // a quiet mid-stream gap, which used to return a truncated/previous answer.
      const done = (!stopBtn || sendVisible()) && everSeenFresh && hasBalancedJson(txt) && Date.now() - stableSince >= 2500;
      if (done) return extractTail(txt, baselineText);
      await sleep(350);
    }
    // Timeout: return whatever fresh text did stream in (never the stale baseline).
    return extractTail(everSeenFresh && lastText ? lastText : "", baselineText);
  }

  // TikTok: several rows accumulate in ONE ChatGPT thread, and a row's reply can
  // then read a previous row's assistant message (wrong/random answers). Starting
  // a fresh conversation before every ask gives each row a clean thread, so the
  // last assistant message is ALWAYS and ONLY that row's answer.
  async function resetConversation() {
    // A fresh ChatGPT thread ALWAYS lives at the root path (chatgpt.com/),
    // never under /c/<thread-id>. Using the URL (not DOM heuristics) is the
    // deterministic proof that we really are on a new conversation.
    const isFreshThread = () => !/\/c\//.test(location.pathname);
    if (isFreshThread()) return true; // already clean (nothing sent yet)

    const newChatSelectors = [
      "a[href=\"/new\"]",
      "a[href=\"/new/\"]",
      "button[aria-label*=\"New chat\"]",
      "a[aria-label*=\"New chat\"]",
      "#new-chat-button",
      "button[id=\"nav-item-new-chat\"]",
      "a[data-testid=\"notion-link\"]",
    ];
    const visible = (el) => !!el && (el.getClientRects().length > 0 || el.offsetParent !== null);
    const t0 = Date.now();
    while (Date.now() - t0 < 25000 && !isFreshThread()) {
      for (const s of newChatSelectors) {
        const el = document.querySelector(s);
        if (visible(el)) el.click();
      }
      // Give the new thread a beat to render, then check the URL again.
      await sleep(600);
    }
    if (!isFreshThread()) return false; // could not escape the old thread
    // Small wait so the fresh thread's composer is present before we fill it.
    await waitForComposer(10000);
    window.__gptLastBaseline = "";
    return true;
  }

  window.__gptAssistant = {
    queue: Promise.resolve(),
    ask: async (prompt, opts) => {
      // Serialize everything on this tab: each __gptAsk runs only after the
      // previous one fully finished, so two rows can never send together.
      const run = window.__gptAssistant.queue.then(() =>
        window.__gptAssistant._ask(prompt, opts)
      );
      window.__gptAssistant.queue = run.then(
        () => {},
        () => {}
      );
      return run;
    },
    _ask: async (prompt, opts) => {
      window.__gptAborted = false;
      if (detectBlocked())
        return {
          ok: false,
          blocked: true,
          error:
            "ChatGPT is showing a security check (\"unusual activity detected\"). " +
            "Open chatgpt.com in Chrome, solve the CAPTCHA, then run AI again.",
        };
      const useSearch = opts && opts.webSearch !== false;
      // Fresh thread per row: never let previous rows' Q&A bleed into this one.
      // If we cannot reach a fresh thread (no New-chat button / navigation stuck),
      // DO NOT send in the old thread — the answer would bind to the wrong row.
      if (!(await resetConversation())) {
        return {
          ok: false,
          error:
            "Could not start a fresh ChatGPT conversation. Click \"New chat\" on chatgpt.com manually and make sure the left sidebar is loaded, then run AI again.",
        };
      }
      const composer = await waitForComposer();
      if (!composer) {
        if (detectBlocked())
          return {
            ok: false,
            blocked: true,
            error:
              "ChatGPT is showing a security check (\"unusual activity detected\"). " +
              "Open chatgpt.com in Chrome, solve the CAPTCHA, then run AI again.",
          };
        return { ok: false, error: "ChatGPT not ready. Please login and keep chatgpt.com open." };
      }

      // If a previous reply is still generating, wait for it to finish and for
      // the send button to reappear. Sending mid-generation clicks the STOP
      // button instead, which is exactly the "starts then stops" the user saw.
      const waitSendIdle = async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 120000) {
          const stopBtn = document.querySelector(
            "button[data-testid=\"stop-button\"], button[aria-label*=\"Stop generating\" i]"
          );
          if (!stopBtn) return true;
          await sleep(400);
        }
        return false;
      };
      if (!(await waitSendIdle()))
        return { ok: false, error: "ChatGPT is taking too long to finish the previous reply." };

      if (useSearch) {
        try {
          await toggleWebSearch();
        } catch (e) {}
      }
      setComposer(composer, prompt);
      await sleep(180);
      // Only click send if our text actually landed in the composer.
      const landed = (() => {
        try {
          return composer.innerText && composer.innerText.replace(/\s+/g, " ").trim().length > 5;
        } catch (e) {
          return true;
        }
      })();
      if (!landed) return { ok: false, error: "Could not fill the ChatGPT composer." };
      let clicked = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        if (clickSendButton()) { clicked = true; break; }
        await sleep(600);
      }
      if (!clicked) return { ok: false, error: "Send button not found on chatgpt.com." };
      // Fresh thread per row, and extractLastAnswer() reads ONLY assistant nodes —
      // the just-sent user prompt is a user node, so there is nothing to baseline
      // away and done never fires on the prompt itself. Capture the baseline right
      // after send (empty on a fresh thread) and start polling immediately.
      const baseAfterSend = extractLastAnswer();
      window.__gptLastBaseline = baseAfterSend;
      const text = await waitForCompletion(baseAfterSend);
      if (text === "__BLOCKED__")
        return {
          ok: false,
          blocked: true,
          error:
            "ChatGPT is showing a security check (\"unusual activity detected\"). " +
            "Open chatgpt.com in Chrome, solve the CAPTCHA, then run AI again.",
        };
      if (!text) return { ok: false, error: "ChatGPT returned empty reply." };
      return { ok: true, text };
    },
  };

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.action === "__gptGetBridge") {
        sendResponse({ ready: !!window.__gptAssistant });
        return;
      }
      if (msg.action === "__gptAbort") {
        window.__gptAborted = true;
        sendResponse({ aborted: true });
        return;
      }
      if (msg.action === "__gptAsk") {
        window.__gptAssistant.ask(msg.prompt, msg.opts).then((r) => sendResponse(r));
        return true;
      }
      if (msg.action === "__gptGetLast") {
        const text = extractTail(extractLastAnswer(), window.__gptLastBaseline || "");
        sendResponse({ ok: !!text, text });
        return;
      }
    });
  }

  console.log("__gptAssistant bridge ready");
})();