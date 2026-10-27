// Keep credential inputs inert in a template until the top-level check succeeds.
// GitHub Pages cannot set frame-ancestors/X-Frame-Options response headers.
const message = document.getElementById('launch-message');
if (window.self !== window.top) {
  message.textContent = '安全のため、埋め込み画面ではログインできません。公開ページを直接開いてください。';
  const link = document.createElement('a');
  link.href = import.meta.env.BASE_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '公開ページを開く';
  message.append(document.createElement('br'), link);
} else {
  document.getElementById('login-container').append(document.getElementById('login-template').content.cloneNode(true));
  await import('./main.js');
  message.hidden = true;
}
