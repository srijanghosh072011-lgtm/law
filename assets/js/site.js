/* Ghosh Designs — page behaviour.
   Three things: the mobile nav, the tab groups, and scroll reveals.
   ponytail: the dot carousels are tab groups wearing dots, so there is one
   tab implementation and no carousel code at all. */

(function () {
  "use strict";

  // NodeList.forEach is younger than some of what we still fall back to, and a
  // throw here would leave the page half-built.
  function each(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }

  /* --------------------------------------------------------------- nav */

  var toggle = document.querySelector(".navtoggle");
  var sheet = document.getElementById("navsheet");
  var wide = window.matchMedia("(min-width: 1100px)");

  function setNav(open) {
    toggle.setAttribute("aria-expanded", String(open));
    sheet.classList.toggle("is-open", open);
    document.body.classList.toggle("is-locked", open);
    // Keep tab order and the accessibility tree inside the sheet while it
    // covers the page. Ignored by browsers without inert, which is no worse
    // than before.
    each(document.querySelectorAll("main, footer"), function (el) {
      el.inert = open;
    });
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

    // Past 1100px the close button is display:none, so an open sheet left over
    // from a rotate would trap the page with no way out.
    var onWide = function (e) {
      if (e.matches && sheet.classList.contains("is-open")) setNav(false);
    };
    if (wide.addEventListener) wide.addEventListener("change", onWide);
    else if (wide.addListener) wide.addListener(onWide);
  }

  /* -------------------------------------------------------------- tabs */

  each(document.querySelectorAll("[data-tabs]"), function (group) {
    var tabs = Array.prototype.slice.call(group.querySelectorAll('[role="tab"]'));

    function select(index) {
      tabs.forEach(function (tab, i) {
        var on = i === index;
        var panel = document.getElementById(tab.getAttribute("aria-controls"));
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
        if (panel) panel.hidden = !on;
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

  /* Content is visible in the stylesheet and hidden here, never the other way
     round: if this file fails to load or throws, the page still reads. Only
     what is below the fold gets armed, so nothing on screen flashes. */

  if (!("IntersectionObserver" in window)) return;

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  if (!reduced.matches) {
    var seen = new IntersectionObserver(
      function (entries) {
        each(entries, function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.remove("is-armed");
          seen.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.06 }
    );

    each(document.querySelectorAll("[data-reveal]"), function (el) {
      if (el.getBoundingClientRect().top < window.innerHeight) return;
      el.classList.add("is-armed");
      seen.observe(el);
    });
  }

  var masthead = document.querySelector(".masthead");
  var sentinel = document.querySelector("[data-scroll-top]");

  if (masthead && sentinel) {
    new IntersectionObserver(function (entries) {
      masthead.classList.toggle("is-stuck", !entries[0].isIntersecting);
    }).observe(sentinel);
  }
})();
