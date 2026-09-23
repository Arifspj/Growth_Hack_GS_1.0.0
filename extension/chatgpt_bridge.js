// Tab agent injected into a chatgpt.com tab. It finds the composer box, pastes a
// research prompt (web search ON), clicks Send, waits for the reply to finish,
// then returns the last assistant answer to the background worker.
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

  async function waitForCompletion() {
    const t0 = Date.now();
    let lastText = "";
    while (Date.now() - t0 < 120000) {
      const stopBtn = document.querySelector(
        "button[data-testid=\"stop-button\"], button[aria-label*=\"Stop generating\" i]"
      );
      const txt = extractLastAnswer();
      if (!stopBtn && txt && txt !== lastText) {
        await sleep(1500);
        const txt2 = extractLastAnswer();
        if (txt2 === txt && txt2.length > 0) return txt2;
        lastText = txt;
      } else if (txt) {
        lastText = txt;
      }
      await sleep(800);
    }
    return extractLastAnswer();
  }

  window.__gptAssistant = {
    ask: async (prompt, opts) => {
      const useSearch = opts && opts.webSearch !== false;
      const composer = await waitForComposer();
      if (!composer)
        return { ok: false, error: "ChatGPT not ready. Please login and keep chatgpt.com open." };
      if (useSearch) {
        try {
          await toggleWebSearch();
        } catch (e) {}
      }
      setComposer(composer, prompt);
      await sleep(500);
      if (!clickSendButton())
        return { ok: false, error: "Send button not found on chatgpt.com." };
      const text = await waitForCompletion();
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