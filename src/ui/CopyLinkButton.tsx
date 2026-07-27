import { useState } from 'react';

/**
 * The URL itself is the export -- AppState's effect keeps window.location.hash
 * in sync with deck size/groups/query on every change, so there's nothing to
 * compute here except copying whatever the address bar already says.
 */
export function CopyLinkButton() {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard permission denied or unavailable -- fall back to select+prompt
      window.prompt('Copy this link:', url);
    }
  }

  return (
    <button className="link-btn copy-link-btn" onClick={copy}>
      {copied ? 'Copied!' : 'Copy link'}
    </button>
  );
}
