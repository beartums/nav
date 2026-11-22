// holdtip.js -- hover text on touchscreens: press and hold.
//
// One of nav's page scripts (classic, shared globals). nav explains its icons
// and indicators with the title attribute, which a mouse shows on hover and a
// finger never can. Holding anything with a title (half a second, without
// moving) shows the same words in a bubble beside it; lifting the finger or
// touching elsewhere hides it. The hold doesn't also click.
'use strict';

(function () {
  var HOLD_MS = 450, MOVE_PX = 10;
  var timer = null, start = null, bubble = null, shownFor = null;

  function hide() {
    if (bubble) { bubble.remove(); bubble = null; }
  }
  function show(el) {
    hide();
    var text = el.getAttribute('title') || el.getAttribute('aria-label');
    if (!text) { return; }
    bubble = document.createElement('div');
    bubble.className = 'holdtip';
    bubble.setAttribute('role', 'tooltip');
    bubble.textContent = text;
    document.body.appendChild(bubble);
    var r = el.getBoundingClientRect(), b = bubble.getBoundingClientRect();
    var left = Math.max(8, Math.min(innerWidth - b.width - 8, r.left + r.width / 2 - b.width / 2));
    var top = r.top - b.height - 8;
    if (top < 8) { top = r.bottom + 8; }
    bubble.style.left = left + 'px';
    bubble.style.top = top + 'px';
    shownFor = el;
  }

  document.addEventListener('touchstart', function (e) {
    hide();
    var el = e.target.closest && e.target.closest('[title]');
    if (!el || e.touches.length !== 1) { return; }
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    clearTimeout(timer);
    timer = setTimeout(function () { show(el); }, HOLD_MS);
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!start || !timer) { return; }
    var t = e.touches[0];
    if (Math.abs(t.clientX - start.x) > MOVE_PX || Math.abs(t.clientY - start.y) > MOVE_PX) {
      clearTimeout(timer); timer = null;
    }
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    clearTimeout(timer); timer = null;
    // A hold that showed the bubble is not also a tap on the thing.
    if (bubble && shownFor) { e.preventDefault(); shownFor = null; setTimeout(hide, 2500); }
  });
  document.addEventListener('touchcancel', function () { clearTimeout(timer); timer = null; hide(); });
  // Long-press on a phone also opens the browser's own menu: not over our bubble.
  document.addEventListener('contextmenu', function (e) {
    if (bubble) { e.preventDefault(); }
  });
  window.addEventListener('scroll', hide, { passive: true });
})();
