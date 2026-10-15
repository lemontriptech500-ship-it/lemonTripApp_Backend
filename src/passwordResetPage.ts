// Matches the mobile app's ScreenHeader, Colors, Ui controls, and Manrope typography.
export function passwordResetPage(token: string | null) {
  const lock = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg>';
  const shield = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/></svg>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="referrer" content="no-referrer">
  <meta name="theme-color" content="#0C3026">
  <title>Reset your password · LemonTrip</title>
  <link rel="stylesheet" href="/app/reset-password/assets/styles.css">
</head>
<body>
  <div class="page">
    <header class="header">
      <div class="brand-bar">
        <img class="logo" src="/app/reset-password/assets/logo.png" width="156" height="52" alt="LemonTrip — Travel smarter. Travel better.">
        <span class="secure-badge">${shield} Account recovery</span>
      </div>
      <div class="header-copy">
        <p class="eyebrow">ACCOUNT RECOVERY</p>
        <h1>${token ? 'A fresh start.' : 'Let’s get you back in.'}</h1>
        <p class="subtitle">Choose a new password for your LemonTrip account.</p>
      </div>
    </header>
    <main>
      <section class="card" aria-labelledby="reset-title">
        <div class="card-heading">
          <div class="icon-tile">${lock}</div>
          <div><p class="eyebrow">${token ? 'NEW PASSWORD' : 'NEW LINK NEEDED'}</p><h2 id="reset-title">${token ? 'Reset your password' : 'This link is incomplete'}</h2></div>
        </div>
        ${token ? `<p class="intro">A new password, and you’re ready for your next journey.</p>
        <form id="reset-password-form">
          <input type="hidden" name="token" value="${token}">
          <div class="field"><label for="new-password">New password</label><div class="input-wrap">${lock}<input id="new-password" name="newPassword" type="password" autocomplete="new-password" placeholder="Enter your new password" minlength="8" maxlength="128" aria-describedby="password-hint" required></div><p class="hint" id="password-hint">Use 8–128 characters.</p></div>
          <div class="field"><label for="confirm-password">Confirm new password</label><div class="input-wrap">${lock}<input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" placeholder="Enter it once more" minlength="8" maxlength="128" required></div></div>
          <button class="primary-button" type="submit">Reset password <span aria-hidden="true">→</span></button>
        </form>
        <p id="reset-status" class="status" role="status" aria-live="polite" aria-atomic="true"></p>
        <noscript><p class="status">Enable JavaScript to reset your password here, or use the reset code in LemonTrip.</p></noscript>
        <p class="return-note">After resetting, return to LemonTrip in your browser or app to log in.</p>` : '<p class="intro">Open Forgot password in LemonTrip and request a new reset link using your account email.</p>'}
      </section>
      <aside class="security-note">${shield}<p>Reset links work once and expire in 30 minutes. After a reset, all your devices are signed out.</p></aside>
      ${token ? `<details class="card app-options"><summary>Reset inside the app instead <span aria-hidden="true">+</span></summary><div class="options-content"><p>Already have the app installed?</p><a class="app-link" href="lemontripmobile://reset-password?token=${encodeURIComponent(token)}">Open LemonTrip app <span aria-hidden="true">↗</span></a><p>Or choose “I already have a reset code” on the Forgot password screen and paste this code:</p><code>${token}</code></div></details>` : ''}
    </main>
    <footer>Travel smarter. Travel better.<span>LemonTrip · Account recovery</span></footer>
  </div>
  ${token ? '<script src="/app/reset-password/open.js" defer></script>' : ''}
</body>
</html>`;
}
