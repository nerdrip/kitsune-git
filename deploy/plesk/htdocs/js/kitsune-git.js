(function () {
  'use strict';

  function all(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }
  function copy(value, button) {
    if (!value) return;
    var done = function () { var previous = button.textContent; button.textContent = 'Skopiowano'; window.setTimeout(function () { button.textContent = previous; }, 1400); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(value).then(done);
    else {
      var area = document.createElement('textarea'); area.value = value; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select();
      try { document.execCommand('copy'); done(); } finally { area.remove(); }
    }
  }
  function refreshAuthFields() {
    var select = document.querySelector('[data-kgt-auth-mode]');
    if (!select) return;
    var mode = select.value;
    all('[data-kgt-token-field]').forEach(function (node) { node.hidden = mode !== 'token'; });
    all('[data-kgt-ssh-field]').forEach(function (node) { node.hidden = mode !== 'generated-key' && mode !== 'custom-key'; });
    all('[data-kgt-custom-key-field]').forEach(function (node) { node.hidden = mode !== 'custom-key'; });
  }
  function ready() {
    all('[data-kgt-copy]').forEach(function (button) { button.addEventListener('click', function () { var target = document.getElementById(button.getAttribute('data-kgt-copy')); copy(target ? target.textContent.trim() : '', button); }); });
    all('[data-kgt-copy-value]').forEach(function (button) { button.addEventListener('click', function () { var target = document.getElementById(button.getAttribute('data-kgt-copy-value')); copy(target ? target.value : '', button); }); });
    all('[data-kgt-reveal]').forEach(function (button) { button.addEventListener('click', function () { var target = document.getElementById(button.getAttribute('data-kgt-reveal')); if (!target) return; target.type = target.type === 'password' ? 'text' : 'password'; button.textContent = target.type === 'password' ? 'Pokaż' : 'Ukryj'; }); });
    all('[data-kgt-refresh]').forEach(function (button) { button.addEventListener('click', function () { window.location.reload(); }); });
    all('[data-kgt-confirm]').forEach(function (form) { form.addEventListener('submit', function (event) { if (!window.confirm(form.getAttribute('data-kgt-confirm'))) event.preventDefault(); }); });
    var auth = document.querySelector('[data-kgt-auth-mode]'); if (auth) auth.addEventListener('change', refreshAuthFields); refreshAuthFields();
    var domain = document.querySelector('select[name="domain"]');
    if (domain) domain.addEventListener('change', function () { var preview = document.querySelector('[data-kgt-public-preview]'); if (preview) preview.textContent = domain.value ? 'https://' + domain.value : 'https://wybrana-domena'; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
