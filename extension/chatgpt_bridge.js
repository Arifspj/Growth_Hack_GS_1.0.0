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
    // Try the classic assistant-message selectors first (markdown within a
    // [data-message-author-role="assistant"] node).
    const roleSels = [
      "main [data-message-author-role=\"assistant\"] .markdown",
      "main [data-message-author-role=\"assistant\"]",
      "[data-message-author-role=\"assistant\"] .markdown",
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
    // Robust fallback: whatever ChatGPT changed in its DOM, the fresh answer is
    // always rendered inside <main>. Returning the whole main text guarantees a
    // reply is never missed (extractAiJson in the background digs out the JSON).
    const main = document.querySelector("main");
    if (main) {
      const t = main.innerText ? main.innerText.trim() : "";
      if (t) return t;
    }
    const anyMd = document.querySelector(".markdown");
    return anyMd && anyMd.innerText ? anyMd.innerText.trim() : "";
  }

  async function waitForComposer(timeoutMs = 45000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const c = findComposer();
      if (c) return c;
      await sleep(700);
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
      // back) AND the answer is fresh and has been stable for 2.5s.
      const done = (!stopBtn || sendVisible()) && everSeenFresh && Date.now() - stableSince >= 2500;
      if (done) return txt;
      await sleep(800);
    }
    // Timeout: return whatever fresh text did stream in (never the stale baseline).
    return everSeenFresh && lastText ? lastText : "";
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
          await sleep(1200);
        }
        return false;
      };
      if (!(await waitSendIdle()))
        return { ok: false, error: "ChatGPT is taking too long to finish the previous reply." };

      const baselineText = extractLastAnswer();
      if (useSearch) {
        try {
          await toggleWebSearch();
        } catch (e) {}
      }
      setComposer(composer, prompt);
      await sleep(500);
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
      const text = await waitForCompletion(baselineText);
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
        const text = extractLastAnswer();
        sendResponse({ ok: !!text, text });
        return;
      }
    });
  }

  console.log("__gptAssistant bridge ready");
})();