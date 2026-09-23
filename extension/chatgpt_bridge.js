// Tab agent injected into a chatgpt.com tab. It finds the composer box, pastes a
// research prompt (web search ON), clicks Send, waits for the reply to finish,
// then returns the last assistant answer to the background worker.
// Mirrors the working flow from the Chart Screener Chrome project.
(() => {
  if (window.__gptBridgeActive) return;
  window.__gptBridgeActive = true;
  console.log("ChatGPT bridge loaded");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const roleMsgs = Array.from(
      document.querySelectorAll("main [data-message-author-role=\"assistant\"]")
    );
    if (roleMsgs.length) {
      const last = roleMsgs[roleMsgs.length - 1];
      const md = last.querySelector(".markdown") || last;
      return md.innerText.trim();
    }
    const anyMds = Array.from(
      document.querySelectorAll(
        "[data-message-author-role=\"assistant\"] .markdown, main .markdown, .conversation-container .markdown"
      )
    );
    if (anyMds.length) return anyMds[anyMds.length - 1].innerText.trim();
    return "";
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

  async function waitForCompletion(baselineText) {
    const deadline = Date.now() + 120000;
    const stopBtnSel =
      "button[data-testid=\"stop-button\"], button[aria-label*=\"Stop generating\" i]";

    // Phase 1: generation must actually START (stop button appears). If it never
    // appears, the message likely wasn't sent — bail early instead of returning
    // stale text (that was the "prompt sent twice / wrong data" bug).
    let sawStop = false;
    while (Date.now() < deadline) {
      if (document.querySelector(stopBtnSel)) { sawStop = true; break; }
      await sleep(700);
    }

    // Phase 2: once started, wait until it fully finishes (stop button gone),
    // then require a FRESH answer that differs from the pre-send baseline.
    let lastText = "";
    while (Date.now() < deadline) {
      const stopBtn = document.querySelector(stopBtnSel);
      const txt = extractLastAnswer();
      if (sawStop && !stopBtn && txt && txt !== baselineText) {
        if (txt !== lastText) {
          lastText = txt;
          await sleep(1500);
          continue;
        }
        return txt;
      }
      if (txt) lastText = txt;
      await sleep(800);
    }
    // Timeout: only return text we actually saw change after our send.
    return lastText && lastText !== baselineText ? lastText : "";
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
      const useSearch = opts && opts.webSearch !== false;
      const composer = await waitForComposer();
      if (!composer)
        return { ok: false, error: "ChatGPT not ready. Please login and keep chatgpt.com open." };

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
      if (msg.action === "__gptAsk") {
        window.__gptAssistant.ask(msg.prompt, msg.opts).then((r) => sendResponse(r));
        return true;
      }
    });
  }

  console.log("__gptAssistant bridge ready");
})();