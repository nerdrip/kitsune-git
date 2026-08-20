(function () {
  'use strict';

  function ready(callback) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback);
    else callback();
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  ready(function () {
    Array.prototype.slice.call(document.querySelectorAll('[data-kitsune-suite]')).forEach(function (mount) {
      var product = mount.getAttribute('data-suite-product') || 'Rozszerzenie Kitsune';
      var version = mount.getAttribute('data-suite-version') || '—';
      var hub = mount.getAttribute('data-suite-hub') === '1';
      var bar = element('aside', 'kitsune-suite-bar');
      bar.setAttribute('aria-label', 'Kitsune Plesk Suite');

      var brand = element('div', 'kitsune-suite-brand');
      brand.appendChild(element('span', 'kitsune-suite-mark', '狐'));
      var copy = element('div', 'kitsune-suite-copy');
      copy.appendChild(element('small', '', 'KITSUNE PLESK SUITE'));
      copy.appendChild(element('strong', '', product));
      copy.appendChild(element('span', '', hub ? 'Konfiguracja dostępna centralnie w Kitsune Hub' : 'Tryb samodzielny — menu tego managera pozostaje widoczne'));
      brand.appendChild(copy);
      bar.appendChild(brand);

      var actions = element('div', 'kitsune-suite-actions');
      actions.appendChild(element('span', 'kitsune-suite-version', 'v' + version));
      actions.appendChild(element('span', 'kitsune-suite-mode' + (hub ? '' : ' is-standalone'), hub ? 'Zarządzane przez Hub' : 'Tryb samodzielny'));
      if (hub) {
        var link = element('a', 'kitsune-suite-link', '← Plesk Management');
        link.href = '/modules/kitsuneserv-bridge/index.php/index/index?tab=plesk';
        actions.appendChild(link);
      }
      bar.appendChild(actions);
      mount.replaceWith(bar);
      if (bar.nextElementSibling) bar.nextElementSibling.classList.add('kitsune-suite-surface');
    });
  });
})();
