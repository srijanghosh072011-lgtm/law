/* Ghosh Designs — page behaviour.
   Three things: the mobile nav, the tab groups, and scroll reveals.
   ponytail: the dot carousels are tab groups wearing dots, so there is one
   tab implementation and no carousel code at all. */

(function () {
  "use strict";

  /* --------------------------------------------------------------- nav */

  var toggle = document.querySelector(".navtoggle");
  var sheet = document.getElementById("navsheet");

  function setNav(open) {
    toggle.setAttribute("aria-expanded", String(open));
    sheet.classList.toggle("is-open", open);
    document.body.classList.toggle("is-locked", open);
  }

  if (toggle && sheet) {
    toggle.addEventListener("click", function () {
      setNav(toggle.getAttribute("aria-expanded") !== "true");
    });

    sheet.addEventListener("click", function (event) {
      if (event.target.closest("a")) setNav(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && sheet.classList.contains("is-open")) {
        setNav(false);
        toggle.focus();
      }
    });
  }

  /* -------------------------------------------------------------- tabs */

  document.querySelectorAll("[data-tabs]").forEach(function (group) {
    var tabs = Array.prototype.slice.call(group.querySelectorAll('[role="tab"]'));

    function select(index) {
      tabs.forEach(function (tab, i) {
        var on = i === index;
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
        document.getElementById(tab.getAttribute("aria-controls")).hidden = !on;
      });
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () {
        select(i);
      });

      tab.addEventListener("keydown", function (event) {
        var next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[
          event.key
        ];
        if (next === undefined) return;
        event.preventDefault();
        next = (next + tabs.length) % tabs.length;
        select(next);
        tabs[next].focus();
      });
    });
  });

  /* ------------------------------------------------- reveals & sticky nav */

  var reveals = document.querySelectorAll("[data-reveal]");

  if (!("IntersectionObserver" in window)) {
    // No observer (very old browser): show everything rather than hide it.
    reveals.forEach(function (el) {
      el.classList.add("is-in");
    });
    return;
  }

  var seen = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        seen.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.06 }
  );

  reveals.forEach(function (el) {
    seen.observe(el);
  });

  var masthead = document.querySelector(".masthead");
  var sentinel = document.querySelector("[data-scroll-top]");

  if (masthead && sentinel) {
    new IntersectionObserver(function (entries) {
      masthead.classList.toggle("is-stuck", !entries[0].isIntersecting);
    }).observe(sentinel);
  }
})();
