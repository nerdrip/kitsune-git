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
      var moduleMatch = window.location.pathname.match(/\/modules\/([a-z0-9][a-z0-9._-]+)\//i);
      var moduleId = moduleMatch ? moduleMatch[1].toLowerCase() : '';
      var icons = {
        'kitsuneartifactory-manager': 'kitsuneartifactory-menu.svg', 'kitsuneirc-manager': 'kitsuneirc-menu.svg',
        'kitsune-manager': 'kitsunecolab-menu.svg', 'kitsunecolab-manager': 'kitsunecolab-menu.svg',
        'kitsunepaint-manager': 'kitsunepaint-menu.svg', 'kitsunepnc-manager': 'kitsunepnc-menu.svg',
        'kitsunetab-manager': 'kitsunetab-menu.svg', 'kitsunetest-manager': 'kitsunetest-menu.svg',
        'nailit-manager': 'nailit-menu.svg', 'kitsune-git': 'kitsune-git-menu.svg',
        'wpkit-parse-manager': 'wpkit-parse-menu.svg', 'nerd-apps-runtime-manager': 'nerd-runtime-menu.svg',
        'ultimate-tool': 'ultimate-tool-menu.svg', 'kitsuneserv-bridge': 'kitsune-hub-menu.svg'
      };
      var bar = element('aside', 'kitsune-suite-bar');
      bar.setAttribute('aria-label', 'Kitsune Plesk Suite');

      var brand = element('div', 'kitsune-suite-brand');
      var mark = element('span', 'kitsune-suite-mark');
      if (moduleId && icons[moduleId]) {
        var icon = document.createElement('img'); icon.src = '/modules/' + moduleId + '/images/' + icons[moduleId]; icon.alt = '';
        mark.appendChild(icon);
      } else mark.textContent = '狐';
      brand.appendChild(mark);
      var copy = element('div', 'kitsune-suite-copy');
      copy.appendChild(element('small', '', 'KITSUNE PLESK SUITE'));
      copy.appendChild(element('strong', '', product));
      copy.appendChild(element('span', '', hub ? 'Konfiguracja dostępna centralnie w Kitsune Hub' : 'Tryb samodzielny — menu tego managera pozostaje widoczne'));
      brand.appendChild(copy);
      bar.appendChild(brand);

      var actions = element('div', 'kitsune-suite-actions');
      actions.appendChild(element('span', 'kitsune-suite-version', 'v' + version));
      actions.appendChild(element('span', 'kitsune-suite-mode' + (hub ? '' : ' is-standalone'), hub ? 'Zarządzane przez Hub' : 'Tryb samodzielny'));
      if (moduleId && moduleId !== 'kitsuneserv-bridge') {
        var updateLink = element('a', 'kitsune-suite-link is-update', window.location.pathname.indexOf('/self-update/') !== -1 ? '← Konfiguracja' : '↻ Aktualizacja wtyczki');
        updateLink.href = window.location.pathname.indexOf('/self-update/') !== -1 ? '/modules/' + moduleId + '/index.php/index/index' : '/modules/' + moduleId + '/index.php/self-update/index';
        actions.appendChild(updateLink);
      }
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
