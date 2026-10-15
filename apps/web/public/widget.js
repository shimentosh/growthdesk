/*
 * Growthdesk live chat loader. Paste on any website:
 *
 *   <script src="https://YOUR-APP/widget.js" data-key="lc_…" async></script>
 *
 * It adds one fixed iframe (the chat at /chat/<key>), sized to the launcher
 * while closed and to the panel while open, and keeps the visitor's token in
 * this site's own localStorage so a returning visitor sees their chat again.
 *
 * Page API: window.GrowthdeskChat.open() / .close() / .toggle()
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute("data-key");
  if (!key || window.__gdLiveChat) return;
  window.__gdLiveChat = true;

  var origin = new URL(script.src, location.href).origin;
  var storeKey = "gd_lc_" + key;
  var token = "";
  try {
    token = localStorage.getItem(storeKey) || "";
  } catch (e) {
    /* storage blocked: the chat still works for this page view */
  }

  var CLOSED = { w: "84px", h: "84px" };
  var frame = document.createElement("iframe");
  var src = origin + "/chat/" + encodeURIComponent(key) + "?host=" + encodeURIComponent(location.host) + "&page=" + encodeURIComponent(location.href.slice(0, 1000));
  frame.src = src + (token ? "#t=" + encodeURIComponent(token) : "");
  frame.title = "Live chat";
  frame.setAttribute("allow", "clipboard-write");
  var s = frame.style;
  s.position = "fixed";
  s.bottom = "0";
  s.right = "0";
  s.width = CLOSED.w;
  s.height = CLOSED.h;
  s.border = "0";
  s.background = "transparent";
  s.colorScheme = "normal";
  s.zIndex = "2147483000";
  s.display = "none";
  frame.setAttribute("allowtransparency", "true");

  function size(open) {
    var small = window.innerWidth < 480;
    if (!open) {
      s.width = CLOSED.w;
      s.height = CLOSED.h;
    } else if (small) {
      s.width = "100%";
      s.height = "100%";
    } else {
      s.width = "400px";
      s.height = Math.min(700, window.innerHeight) + "px";
    }
  }

  var isOpen = false;
  window.addEventListener("message", function (e) {
    if (e.origin !== origin || e.source !== frame.contentWindow) return;
    var d = e.data;
    if (!d || d.gd !== "lc") return;
    if (d.type === "ready") {
      if (d.position === "left") {
        s.right = "";
        s.left = "0";
      }
      s.display = "block";
    }
    else if (d.type === "resize") {
      isOpen = !!d.open;
      size(isOpen);
    } else if (d.type === "token" && typeof d.token === "string") {
      try {
        localStorage.setItem(storeKey, d.token);
      } catch (err) {
        /* ignore */
      }
    }
  });
  window.addEventListener("resize", function () {
    size(isOpen);
  });

  function send(type) {
    if (frame.contentWindow) frame.contentWindow.postMessage({ gd: "lc", type: type }, origin);
  }
  window.GrowthdeskChat = {
    open: function () {
      send("open");
    },
    close: function () {
      send("close");
    },
    toggle: function () {
      send("toggle");
    },
  };

  function mount() {
    document.body.appendChild(frame);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
