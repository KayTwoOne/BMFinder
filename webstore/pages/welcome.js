/* The first-run disclosure.

   The button is the whole contract: clicking it records that THIS version of the
   disclosure was accepted, and until that record exists the worker refuses to
   poll, refuses to arm its alarm, and refuses to write anything the content
   script reports. Nothing here is decorative.

   The page talks to the worker over messages like every other surface; it never
   opens IndexedDB itself. */

const send = (msg) => new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || {}); });
  } catch (e) {
    resolve({ error: (e && e.message) || String(e) });
  }
});

const btn = document.getElementById('accept');
const note = document.getElementById('consent-note');

function fail(message) {
  note.textContent = message;
  note.classList.add('err');
  btn.disabled = false;
  btn.textContent = 'I understand — continue';
}

/* Already accepted? Then this page has nothing to ask, and re-showing a consent
   screen someone has already answered would be a small dishonesty of its own.
   Say so and offer the way forward rather than silently redirecting - a page
   that bounces on load is disorienting. */
(async () => {
  const r = await send({ type: 'DISCLOSURE_GET' });
  if (r && r.accepted) {
    btn.textContent = 'Open BMFinder';
    note.textContent = 'You have already accepted this disclosure.';
    btn.dataset.done = '1';
  }
})();

btn.addEventListener('click', async () => {
  if (btn.dataset.done === '1') {
    location.href = chrome.runtime.getURL('dashboard/dashboard.html');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const r = await send({ type: 'DISCLOSURE_ACCEPT' });
  /* If the write failed, stay put. Sending the user to a dashboard whose worker
     will refuse every request looks like the extension is broken, when what
     actually happened is that consent was not stored. */
  if (!r || r.error || !r.accepted) {
    fail('Could not save your choice. ' + ((r && r.error) || 'Please try again.'));
    return;
  }
  location.href = chrome.runtime.getURL('dashboard/dashboard.html');
});
