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
    "div[role=\"button\"][aria-label*=\"send\" i]",
    "[class*=\"ds-icon-button\"][aria-label]",
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
    "[data-message-author-role=\"assistant\"]",
    "[data-star=\"true\"]",
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
    // Minimal typing simulation so React (controlled input) really registers the
    // value — a single native "input" event is sometimes not enough to enable
    // the send path on chat.deepseek.com.
    try {
      if (composer.tagName === "TEXTAREA" && document.execCommand) {
        composer.value = "";
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        composer.value = text;
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
    } catch (e) {}
    return true;
  }

  function isSendDisabled(el) {
    return !el || el.disabled === true || el.getAttribute("aria-disabled") === "true";
  }

  // Dispatch a realistic keyboard event so DeepSeek's React keydown handler
  // fires. `.click()` on the plane icon alone does not always submit.
  function pressEnterOn(composer) {
    for (const ev of ["keydown", "keypress", "keyup"]) {
      const e = new KeyboardEvent(ev, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
      composer.dispatchEvent(e);
    }
  }

  function clickSendButton(composer) {
    for (const s of SEND_SEL) {
      const b = q(s);
      if (!b) continue;
      const btn = b.tagName.toLowerCase() === "button" ? b : null;
      const act = b.tagName.toLowerCase() === "button"
        ? (btn.click && btn.click())
        : (b.click && b.click());
      void act;
    }
    // DeepSeek sends on Enter even when no explicit send button is clickable.
    if (composer) pressEnterOn(composer);
    return true;
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

  const BLOCK_SNIPPETS = [
    "unusual activity",
    "please try again later",
    "verify you are human",
    "not a robot",
    "security check",
    "cf-chl",
    "cf-challenge",
    "access denied",
    "forbidden",
  ];

  function detectBlocked() {
    if (!document.body) return false;
    const txt = document.body.innerText.toLowerCase().replace(/\s+/g, " ");
    return BLOCK_SNIPPETS.some((s) => txt.includes(s));
  }

  function extractLastAnswer() {
    if (detectBlocked()) return "__BLOCKED__";
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
      // Send the prompt and VERIFY it actually left the composer (DeepSeek clears
      // the box and shows a user bubble the moment the message is submitted).
      // Plugin-side .click() alone often does not commit; we click every candidate,
      // then fire Enter on the focused composer, and confirm the composer emptied.
      const composerClean = (() => {
        try {
          const v = composer.innerText != null ? composer.innerText : composer.value;
          return !String(v || "").replace(/\s+/g, " ").trim();
        } catch (e) {
          return false;
        }
      })();
      const sentT0 = Date.now();
      let sent = false;
      while (Date.now() - sentT0 < 15000) {
        if (window.__dsAborted) return { ok: false, error: "Stopped before sending." };
        clickSendButton(composer);
        await sleep(900);
        if (composerClean()) { sent = true; break; }
      }
      if (!sent) return { ok: false, error: "DeepSeek did not send the prompt (composer still has text)." };
      const text = await waitForCompletion(baselineText);
      if (text === "__BLOCKED__")
        return {
          ok: false,
          blocked: true,
          error:
            "DeepSeek is showing a security check. " +
            "Open chat.deepseek.com in Chrome, complete the check, then run AI again.",
        };
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
        sendResponse({ ok: !!text && text !== "__BLOCKED__", text });
        return;
      }
      if (msg.action === "__dsWaitResult") {
        const baseline = msg.baseline || "";
        const start = Date.now();
        const timeoutMs = msg.timeoutMs || 240000;
        (async () => {
          while (Date.now() - start < 5000) await sleep(500); // let the page settle
          while (Date.now() - start < 60000) {
            if (extractLastAnswer() !== baseline && extractLastAnswer() !== "__BLOCKED__") break;
            await sleep(800);
          }
          let reset = true;
          const t0 = Date.now();
          const deadline = t0 + timeoutMs;
          let text = "";
          while (Date.now() < deadline) {
            if (window.__dsAborted) break;
            const cur = extractLastAnswer();
            if (cur === "__BLOCKED__") {
              sendResponse({ blocked: true });
              return;
            }
            const fresh = !!cur && cur !== baseline;
            if (fresh) {
              if (cur !== text) { text = cur; reset = true; }
            }
            if (!isGenerating() && fresh && reset) {
              await sleep(3000);
              const final = extractLastAnswer();
              if (final === text && !isGenerating()) {
                sendResponse({ ok: !!final, text: final });
                return;
              }
            }
            await sleep(800);
          }
          sendResponse({ ok: !!text, text });
        })();
        return true;
      }
    });
  }

  console.log("__dsAssistant bridge ready");
})();