// Tab agent injected into a chat.deepseek.com tab. Mirrors chatgpt_bridge.js:
// find the composer, paste the prompt, toggle web search, click Send, wait for
// the reply to finish, then return the last assistant answer to the background.
( () => {
  if (window.__dsBridgeActive) return;
  window.__dsBridgeActive = true;
  window.__dsAborted = false;
  console.log("DeepSeek bridge loaded");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // DeepSeek's UI elements: composer textarea (#chat-input), the send button
  // (#send-button / form submit) and an optional web-search toggle. Selector
  // lists are ordered most-reliable-first so a UI change degrades gracefully.
  const COMPOSER_SEL = [
    "textarea#chat-input",
    "div#chat-input[contenteditable=\"true\"]",
    "#chat-input",
    "textarea[placeholder*=\"essage\" i]",
    "textarea[data-testid=\"chat-input\"]",
  ];
  const SEND_SEL = [
    "button#send-button",
    "div#send-button[role=\"button\"]",
    "#send-button",
    "button[data-testid=\"send-button\"]",
    "form button[type=\"submit\"]",
    "button[aria-label*=\"send\" i]",
  ];
  const STOP_SEL = [
    "button[data-testid=\"stop-button\"]",
    "button[aria-label*=\"Stop generating\" i]",
    "button[id=\"stop\"]",
    "#stop",
  ];
  const ANSWER_SEL = [
    "[data-testid=\"assistant-message\"] .ds-markdown",
    "[data-testid=\"assistant-message\"] .markdown",
    "[data-testid=\"assistant-message\"]",
    ".ds-markdown",
    ".markdown",
  ];
  const SEARCH_SEL = [
    "button#search-toggle",
    "button[data-testid=\"search-toggle\"]",
    "button[aria-label*=\"search the web\" i]",
  ];

  function q(a, root) {
    return (root || document).querySelector(a);
  }
  function qa(a, root) {
    return Array.from((root || document).querySelectorAll(a));
  }
  function visible(el) {
    return !!el && el.offsetParent !== null;
  }

  function findComposer() {
    for (const s of COMPOSER_SEL) {
      const el = q(s);
      if (visible(el)) return el;
    }
    // Last-resort: any visible contenteditable editor (DeepSeek supports markdown
    // editing in a codemirror-like div on some layouts).
    const edits = qa("div[contenteditable=\"true\"]").filter(visible);
    if (edits.length) return edits[edits.length - 1];
    const areas = qa("textarea").filter(visible);
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
    for (const s of SEND_SEL) {
      const b = q(s);
      if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      if (visible(b) || s === "#send-button") {
        b.click();
        return true;
      }
    }
    return false;
  }

  async function toggleWebSearch() {
    for (const s of SEARCH_SEL) {
      const b = q(s);
      if (!b) continue;
      const pressed = (b.getAttribute("aria-pressed") || "").toLowerCase();
      const state = (b.getAttribute("data-state") || "").toLowerCase();
      if (state === "checked" || pressed === "true") return true;
      b.click();
      return true;
    }
    return false;
  }

  function extractLastAnswer() {
    for (const s of ANSWER_SEL) {
      const els = qa(s);
      if (els.length) return els[els.length - 1].innerText.trim();
    }
    // Whole-page fallback: last large text block in the conversation stream.
    const blocks = qa("main [class*=\"message\"]").filter(visible);
    return blocks.length ? blocks[blocks.length - 1].innerText.trim() : "";
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

  function isGenerating() {
    for (const s of STOP_SEL) if (visible(q(s))) return true;
    // DeepSeek disables the send button while a reply streams.
    for (const s of SEND_SEL) {
      const b = q(s);
      if (b && (b.disabled === true || b.getAttribute("aria-disabled") === "true")) return true;
    }
    return false;
  }

  async function waitForCompletion(baselineText) {
    const deadline = Date.now() + 240000;
    let lastText = "";
    let stableSince = 0;
    let everSeenFresh = false;

    while (Date.now() < deadline) {
      if (window.__dsAborted) return "";
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
      // Done = generation finished (no stop button, send button re-enabled)
      // AND the answer is fresh and stable for a while.
      const done = !isGenerating() && everSeenFresh && Date.now() - stableSince >= 3000;
      if (done) return txt;
      await sleep(800);
    }
    return everSeenFresh && lastText ? lastText : "";
  }

  window.__dsAssistant = {
    queue: Promise.resolve(),
    ask: async (prompt, opts) => {
      const run = window.__dsAssistant.queue.then(() =>
        window.__dsAssistant._ask(prompt, opts)
      );
      window.__dsAssistant.queue = run.then(
        () => {},
        () => {}
      );
      return run;
    },
    _ask: async (prompt, opts) => {
      window.__dsAborted = false;
      const useSearch = opts && opts.webSearch !== false;
      const composer = await waitForComposer();
      if (!composer)
        return { ok: false, error: "DeepSeek not ready. Please login and keep chat.deepseek.com open." };

      // Wait for a previous reply to finish generating (send button to re-appear).
      const waitSendIdle = async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 120000) {
          if (!isGenerating()) return true;
          await sleep(1200);
        }
        return false;
      };
      if (!(await waitSendIdle()))
        return { ok: false, error: "DeepSeek is taking too long to finish the previous reply." };

      const baselineText = extractLastAnswer();
      if (useSearch) {
        try {
          await toggleWebSearch();
        } catch (e) {}
      }
      setComposer(composer, prompt);
      await sleep(500);
      const landed = (() => {
        try {
          return composer.innerText && composer.innerText.replace(/\s+/g, " ").trim().length > 5;
        } catch (e) {
          return true;
        }
      })();
      if (!landed) return { ok: false, error: "Could not fill the DeepSeek composer." };
      let clicked = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        if (clickSendButton()) { clicked = true; break; }
        await sleep(600);
      }
      if (!clicked) return { ok: false, error: "Send button not found on chat.deepseek.com." };
      const text = await waitForCompletion(baselineText);
      if (!text) return { ok: false, error: "DeepSeek returned empty reply." };
      return { ok: true, text };
    },
  };

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.action === "__dsGetBridge") {
        sendResponse({ ready: !!window.__dsAssistant });
        return;
      }
      if (msg.action === "__dsAbort") {
        window.__dsAborted = true;
        sendResponse({ aborted: true });
        return;
      }
      if (msg.action === "__dsAsk") {
        window.__dsAssistant.ask(msg.prompt, msg.opts).then((r) => sendResponse(r));
        return true;
      }
      if (msg.action === "__dsGetLast") {
        const text = extractLastAnswer();
        sendResponse({ ok: !!text, text });
        return;
      }
    });
  }

  console.log("__dsAssistant bridge ready");
})();