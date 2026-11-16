// Owner sahifasi (/owner/): kirish va hisobot (hisobotning o'zi — owner-report.js)
import { setupProblem, watchUser, login, logout, api, authMessage } from './auth.js';
import { mountOwnerReport } from './owner-report.js';

const $ = (s, r = document) => r.querySelector(s);

function show(name) {
  for (const id of ['setup', 'login', 'denied']) $(`#screen-${id}`).hidden = id !== name;
  $('#app').hidden = name !== 'app';
}

for (const b of document.querySelectorAll('[data-logout]')) b.addEventListener('click', () => logout());
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  const btn = e.currentTarget.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await login($('#login-email').value, $('#login-password').value);
  } catch (x) {
    err.textContent = authMessage(x);
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

if (setupProblem) {
  $('#setup-text').textContent = setupProblem;
  show('setup');
} else {
  watchUser(async (user) => {
    if (!user) return show('login');
    try {
      const me = await api('/owner/me');
      $('#me-email').textContent = me.email;
      $('#to-admin').hidden = !me.admin;
      show('app');
      mountOwnerReport($('#report'), { onAuth: (e) => {
        if (e.status === 401) return show('login');
        $('#denied-text').textContent = e.message;
        show('denied');
      } });
    } catch (e) {
      if (e.status === 403) {
        $('#denied-text').textContent = e.message;
        show('denied');
      } else show('login');
    }
  });
}
